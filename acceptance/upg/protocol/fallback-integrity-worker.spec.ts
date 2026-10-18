import 'reflect-metadata';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fromEpochMs } from '@platform/shared-kernel';
import {
  createConnection,
  runMigrations,
} from '../../../apps/api/src/platform/persistence/drizzle.connection';
import { UpgradeStore } from '../../../apps/api/src/platform/upgrade/upgrade-store';
import { UpgradeService } from '../../../apps/api/src/platform/upgrade/upgrade-service';
import type { UpgradeInspector } from '../../../apps/api/src/platform/upgrade/upgrade-inspector';
import type { UpgradeCatalog } from '../../../apps/api/src/platform/upgrade/upgrade-catalog';
import type { UpgradeSecurity } from '../../../apps/api/src/platform/access-passcode/upgrade-security.service';
import { recoveryIntegrity } from '../../../apps/api/src/platform/upgrade/upgrade-recovery-integrity';
import {
  freezeUpgradePlan,
  UpgradeError,
} from '../../../apps/api/src/platform/upgrade/upgrade-trust';
import * as integrity from '../../../apps/api/src/platform/upgrade/migration-database-integrity';
import { deferred, stub, unused, useEnv } from '../../support/strict-ports';
import { planFixtureEnvelope, planFixtureSource } from '../../support/upgrade-plan-fixture';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) await close();
});

/** Real file SQLite, production UpgradeService fallback and independent real RO
 * worker. Only external retained role/Owner/artifact facts are controlled; this
 * does not claim a real installer, VM, model or release qualification. */
async function fixture(large = false) {
  const directory = mkdtempSync(join(tmpdir(), 'fallback-worker-'));
  const restore = useEnv({
    PLATFORM_INSTANCE_ID: 'fallback-worker-fixture',
    PLATFORM_PROCESS_ROLE: undefined,
    UPGRADE_INITIAL_ARTIFACT_ROOT: join(directory, 'retained-source'),
  });
  const connection = createConnection(join(directory, 'platform.sqlite'));
  runMigrations(connection.db, connection.sqlite);
  let offset = 0;
  const clock = { now: () => fromEpochMs(Date.now() + offset) };
  const store = new UpgradeStore(connection.sqlite, clock, { next: randomUUID });
  const source = planFixtureSource();
  store.bootstrap(source);
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.setHeader('connection', 'close');
    if (req.url === '/eligibility') {
      void service.fallbackEligibility(id, fence, {}).then(
        (value) => res.end(JSON.stringify(value)),
        () => {
          res.statusCode = 500;
          res.end('{}');
        },
      );
    } else if (req.url === '/health') {
      connection.sqlite.prepare('SELECT 1').get();
      res.end('{"ok":true}');
    } else {
      res.end(
        JSON.stringify({
          qualified: true,
          migrationCommitKnown: true,
          capacitySufficient: true,
          latestDatabaseCompatible: true,
          newWritesCompatible: true,
        }),
      );
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture address missing');
  const origin = 'http://127.0.0.1:' + String((address as AddressInfo).port);
  const envelope = planFixtureEnvelope(source, '0.2.1');
  const plan = freezeUpgradePlan(envelope, source);
  const baseline = {
    coordinator: { origin },
    ownerBinding: { activeOwnerId: 'retained' },
    resources: [],
    tasks: [],
    observedAt: clock.now().toISOString(),
  };
  const accepted = store.accept(
    'actor',
    {
      requestId: randomUUID(),
      targetReleaseId: envelope.manifest.releaseId,
      targetDigest: envelope.manifestDigest,
      expectedActivationGeneration: 1,
    },
    envelope,
    plan,
    undefined,
    baseline,
  );
  const id = accepted.attemptId;
  const fence = store.claim(id, 'controller', 30000).fence;
  let binding: Record<string, unknown> = {
    instanceId: store.instanceId,
    attemptId: id,
    fence,
    routeGeneration: 1,
    weight: 0,
    oldApi: { origin, digest: source.components.api.artifactDigest },
    web: { origin, digest: source.components.web.artifactDigest },
  };
  const inspector = stub<UpgradeInspector>({
    entryBinding: async () => binding,
    continuity: async () => ({
      qualified: true,
      owner: { owners: [{ protocol: { min: 1, max: 2 } }] },
    }),
    verifySourceArtifact: async () => ({
      realSourceRoot: 'external-retained',
      verificationRoot: 'external-retained',
      mirrored: false,
    }),
    controlIdentity: async () => ({
      artifactDigest: source.components.api.artifactDigest,
      controlOnly: true,
      noRuntimeSideEffects: true,
    }),
    authenticationContinuity: async () => true,
    webBuild: async () => ({
      webRevision: source.components.web.webRevision,
      releaseId: source.releaseId,
    }),
    schema: () => 29,
  });
  const service = new UpgradeService(
    store,
    unused<UpgradeCatalog>('catalog'),
    unused<UpgradeSecurity>('security'),
    inspector,
    clock,
  );
  if (large) {
    connection.sqlite.exec(
      'CREATE TABLE unrelated_large_history(id INTEGER PRIMARY KEY,payload BLOB)',
    );
    connection.sqlite.transaction(() => {
      const insert = connection.sqlite.prepare(
        'INSERT INTO unrelated_large_history(payload) VALUES(zeroblob(?))',
      );
      for (let i = 0; i < 128; i++) insert.run(1024 * 1024);
    })();
  }
  cleanup.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    connection.sqlite.close();
    restore();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    connection,
    store,
    inspector,
    clock,
    id,
    fence,
    origin,
    prove: () => recoveryIntegrity(store, inspector, clock, id, fence, binding, 5000),
    changeBinding: () => {
      binding = { ...binding, routeGeneration: 2 };
    },
    advance: (ms: number) => {
      offset += ms;
    },
  };
}

describe('recovery integrity does not block the Coordinator or reuse stale authority', () => {
  it('runs the real HTTP fallback with an uncached 128MiB worker while health and SQLite reads remain responsive', async () => {
    const f = await fixture(true);
    const original = integrity.verifyMigrationDatabaseIntegrity;
    const entered = deferred<void>(),
      release = deferred<void>();
    vi.spyOn(integrity, 'verifyMigrationDatabaseIntegrity').mockImplementation(async (sqlite) => {
      entered.resolve();
      await original(sqlite);
      await release.promise;
    });
    // A synchronous full scan on the actual writer connection is forbidden.
    const pragma = f.connection.sqlite.pragma.bind(f.connection.sqlite);
    vi.spyOn(f.connection.sqlite, 'pragma').mockImplementation((source, options) => {
      if (source.includes('quick_check')) throw new Error('main-thread full scan');
      return pragma(source, options);
    });
    const pending = fetch(f.origin + '/eligibility');
    await entered.promise;
    try {
      for (let i = 0; i < 3; i++) {
        const began = performance.now();
        const response = await fetch(f.origin + '/health', { signal: AbortSignal.timeout(2000) });
        expect(response.status).toBe(200);
        expect(performance.now() - began).toBeLessThan(2000);
        await response.arrayBuffer();
      }
    } finally {
      release.resolve();
    }
    const result = await pending;
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ qualified: true, sharedStateHealthy: true });
  });
  it('returns unhealthy for a real foreign-key violation instead of qualifying recovery', async () => {
    const f = await fixture();
    f.connection.sqlite.exec(
      'CREATE TABLE fixture_parent(id INTEGER PRIMARY KEY); CREATE TABLE fixture_child(parent INTEGER REFERENCES fixture_parent(id));',
    );
    f.connection.sqlite.pragma('foreign_keys=OFF');
    f.connection.sqlite.exec('INSERT INTO fixture_child VALUES(9)');
    const response = await fetch(f.origin + '/eligibility');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ qualified: false, sharedStateHealthy: false });
  });
  it.each(['binding', 'fence', 'freshness'] as const)(
    'rejects %s changed while the real scan is awaited',
    async (change) => {
      const f = await fixture();
      const original = integrity.verifyMigrationDatabaseIntegrity;
      const scanned = deferred<void>(),
        release = deferred<void>();
      vi.spyOn(integrity, 'verifyMigrationDatabaseIntegrity').mockImplementation(async (sqlite) => {
        await original(sqlite);
        scanned.resolve();
        await release.promise;
      });
      const rejected = expect(f.prove()).rejects.toMatchObject({
        code:
          change === 'binding'
            ? 'ENTRY_BINDING_CHANGED'
            : change === 'freshness'
              ? 'OBSERVATION_STALE'
              : 'UPGRADE_FENCE_EXPIRED',
      });
      await scanned.promise;
      try {
        if (change === 'binding') f.changeBinding();
        else if (change === 'fence') f.advance(31000);
        else f.advance(6000);
        // The controlled clock crosses the real 5s freshness guard while this
        // completed real worker is held; unrelated HTTP remains responsive.
        const response = await fetch(f.origin + '/health', { signal: AbortSignal.timeout(2000) });
        expect(response.status).toBe(200);
        await response.arrayBuffer();
      } finally {
        release.resolve();
      }
      await rejected;
    },
  );
  it('keeps worker timeout unknown and never turns it into a positive receipt', async () => {
    const f = await fixture();
    vi.spyOn(integrity, 'verifyMigrationDatabaseIntegrity').mockRejectedValue(
      new UpgradeError('GLOBAL_SCHEMA_INTEGRITY_TIMEOUT'),
    );
    await expect(f.prove()).rejects.toMatchObject({ code: 'GLOBAL_SCHEMA_INTEGRITY_TIMEOUT' });
  });
});
