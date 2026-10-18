import 'reflect-metadata';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fromEpochMs } from '@platform/shared-kernel';
import {
  createConnection,
  runMigrations,
} from '../../../apps/api/src/platform/persistence/drizzle.connection';
import { CoordinatorRecovery } from '../../../apps/api/src/platform/upgrade/coordinator-recovery';
import { UpgradeStore } from '../../../apps/api/src/platform/upgrade/upgrade-store';
import { UpgradeService } from '../../../apps/api/src/platform/upgrade/upgrade-service';
import type { UpgradeInspector } from '../../../apps/api/src/platform/upgrade/upgrade-inspector';
import type { UpgradeCatalog } from '../../../apps/api/src/platform/upgrade/upgrade-catalog';
import type { UpgradeSecurity } from '../../../apps/api/src/platform/access-passcode/upgrade-security.service';
import {
  freezeUpgradePlan,
  UpgradeError,
} from '../../../apps/api/src/platform/upgrade/upgrade-trust';
import * as integrity from '../../../apps/api/src/platform/upgrade/migration-database-integrity';
import { deferred, stub, unused, useEnv } from '../../support/strict-ports';
import { planFixtureEnvelope, planFixtureSource } from '../../support/upgrade-plan-fixture';

type Dependencies = ConstructorParameters<typeof CoordinatorRecovery>;
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) await close();
});

/** Real production compatibility + fallback service, file SQLite and RO Worker.
 * Retained role/Owner/artifact boundaries are synthetic; no Native/VM or release
 * qualification is inferred from this local protocol execution. */
async function fixture(large = false) {
  const directory = mkdtempSync(join(tmpdir(), 'coordinator-recovery-worker-'));
  const source = planFixtureSource();
  const restore = useEnv({
    PLATFORM_INSTANCE_ID: 'coordinator-recovery-worker-fixture',
    PLATFORM_PROCESS_ROLE: undefined,
    UPGRADE_INITIAL_ARTIFACT_ROOT: join(directory, 'retained-source'),
    PLATFORM_ARTIFACT_DIGEST: source.components.coordinator?.artifactDigest,
    PLATFORM_PROCESS_START_IDENTITY: 'retained-coordinator-start',
    COORDINATOR_GENERATION: '4',
    COORDINATOR_WRITER_FENCE_VALID: 'false',
  });
  const connection = createConnection(join(directory, 'platform.sqlite'));
  cleanup.push(async () => {
    connection.sqlite.close();
    restore();
    rmSync(directory, { recursive: true, force: true });
  });
  runMigrations(connection.db, connection.sqlite);
  let offset = 0;
  const clock = { now: () => fromEpochMs(Date.now() + offset) };
  const store = new UpgradeStore(connection.sqlite, clock, { next: randomUUID });
  store.bootstrap(source);
  connection.sqlite
    .prepare(
      "INSERT INTO platform_role_leases VALUES('state-coordinator',?,'current-writer',5,8,?)",
    )
    .run(store.instanceId, clock.now().getTime() + 30000);
  let compatibilityRequests = 0;
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.setHeader('connection', 'close');
    if (req.url === '/health') {
      connection.sqlite.prepare('SELECT 1').get();
      res.end('{"ok":true}');
      return;
    }
    const pending =
      req.url === '/eligibility'
        ? service.fallbackEligibility(id, fence, {})
        : (compatibilityRequests++, recovery.compatibility(id, fence));
    void pending.then(
      (value) => res.end(JSON.stringify(value)),
      (error: unknown) => {
        res.statusCode = 503;
        res.end(JSON.stringify({ code: error instanceof UpgradeError ? error.code : 'UNKNOWN' }));
      },
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture address missing');
  const origin = 'http://127.0.0.1:' + String(address.port);
  const envelope = planFixtureEnvelope(source, '0.2.1');
  const plan = freezeUpgradePlan(envelope, source);
  const baseline = {
    coordinator: {
      origin,
      artifactDigest: source.components.coordinator?.artifactDigest,
      startIdentity: 'retained-coordinator-start',
    },
    columns: { projects: connection.sqlite.prepare('PRAGMA table_info(projects)').all() },
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
  const recovery = new CoordinatorRecovery(
    store,
    inspector,
    unused<Dependencies[2]>('migrations'),
    unused<Dependencies[3]>('applications'),
    unused<Dependencies[4]>('agent pump'),
    unused<Dependencies[5]>('automation'),
    unused<Dependencies[6]>('provisions'),
    unused<Dependencies[7]>('clones'),
    unused<Dependencies[8]>('events'),
    unused<Dependencies[9]>('tasks'),
    unused<Dependencies[10]>('terminals'),
    unused<Dependencies[11]>('owners'),
    clock,
  );
  const service = new UpgradeService(
    store,
    unused<UpgradeCatalog>('catalog'),
    unused<UpgradeSecurity>('security'),
    inspector,
    clock,
  );
  if (large) {
    connection.sqlite.exec('CREATE TABLE unrelated_history(payload BLOB)');
    connection.sqlite.transaction(() => {
      const insert = connection.sqlite.prepare('INSERT INTO unrelated_history VALUES(zeroblob(?))');
      for (let i = 0; i < 128; i++) insert.run(1024 * 1024);
    })();
  }
  connection.sqlite.pragma('wal_checkpoint(TRUNCATE)');
  return {
    connection,
    origin,
    prove: () => recovery.compatibility(id, fence),
    requests: () => compatibilityRequests,
    advance: (ms: number) => {
      offset += ms;
    },
    changeBinding: () => {
      binding = { ...binding, routeGeneration: 2 };
    },
  };
}

describe('retained Coordinator compatibility integrity worker', () => {
  it('keeps real HTTP/SQLite responsive during a 128MiB scan and permits a single control read beyond the 2s business deadline', async () => {
    const f = await fixture(true);
    const original = integrity.verifyMigrationDatabaseIntegrity;
    const entered = deferred<void>();
    let calls = 0;
    vi.spyOn(integrity, 'verifyMigrationDatabaseIntegrity').mockImplementation(async (sqlite) => {
      calls++;
      await original(sqlite);
      if (calls === 1) {
        entered.resolve();
        await delay(2100);
      }
    });
    const pragma = f.connection.sqlite.pragma.bind(f.connection.sqlite);
    vi.spyOn(f.connection.sqlite, 'pragma').mockImplementation((source, options) => {
      if (source.includes('quick_check')) throw new Error('main-thread full scan');
      return pragma(source, options);
    });
    const began = performance.now();
    const pending = fetch(f.origin + '/eligibility');
    await entered.promise;
    for (let i = 0; i < 3; i++) {
      const response = await fetch(f.origin + '/health', { signal: AbortSignal.timeout(2000) });
      expect(response.status).toBe(200);
      await response.arrayBuffer();
    }
    const response = await pending;
    expect(response.status).toBe(200);
    const result: unknown = await response.json();
    // Real host capacity can disqualify the overall fallback on a busy runner.
    // These fields require the actual compatibility reply to arrive; a 2s RPC
    // timeout would leave migrationCommitKnown/latestDatabaseCompatible false.
    expect(result, JSON.stringify(result)).toMatchObject({
      sharedStateHealthy: true,
      migrationCommitKnown: true,
      latestDatabaseCompatible: true,
      newWritesCompatible: true,
      artifactImmutable: true,
    });
    expect(performance.now() - began).toBeGreaterThanOrEqual(2100);
    expect(f.requests()).toBe(1);
    expect(calls).toBe(2);
  });
  it('qualifies a retained read-only Coordinator without pretending it owns the current writer', async () => {
    const f = await fixture();
    expect(process.env.COORDINATOR_WRITER_FENCE_VALID).toBe('false');
    expect(await f.prove()).toMatchObject({ qualified: true, retainedBinary: true });
    expect(
      f.connection.sqlite
        .prepare("SELECT generation FROM platform_role_leases WHERE role='state-coordinator'")
        .get(),
    ).toMatchObject({ generation: 5 });
    expect(process.env.COORDINATOR_GENERATION).toBe('4');
  });
  it('keeps a real foreign-key violation unqualified', async () => {
    const f = await fixture();
    f.connection.sqlite.exec(
      'CREATE TABLE fixture_parent(id INTEGER PRIMARY KEY); CREATE TABLE fixture_child(parent INTEGER REFERENCES fixture_parent(id));',
    );
    f.connection.sqlite.pragma('foreign_keys=OFF');
    f.connection.sqlite.exec('INSERT INTO fixture_child VALUES(9)');
    expect(await f.prove()).toMatchObject({ qualified: false, sharedStateHealthy: false });
  });
  it.each(['writer', 'process', 'binding', 'fence', 'freshness'] as const)(
    'rejects %s changes while the actual worker result is awaited, with HTTP still responsive',
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
      const outcome = expect(f.prove()).rejects.toMatchObject({
        code:
          change === 'binding'
            ? 'ENTRY_BINDING_CHANGED'
            : change === 'fence'
              ? 'UPGRADE_FENCE_EXPIRED'
              : change === 'freshness'
                ? 'OBSERVATION_STALE'
                : 'SOURCE_WRITER_UNCONFIRMED',
      });
      await scanned.promise;
      try {
        if (change === 'writer')
          f.connection.sqlite.exec(
            "UPDATE platform_role_leases SET holder_id='new-writer',generation=6,fence=9 WHERE role='state-coordinator'",
          );
        else if (change === 'process') process.env.PLATFORM_PROCESS_START_IDENTITY = 'replaced';
        else if (change === 'binding') f.changeBinding();
        else f.advance(change === 'fence' ? 31000 : 6000);
        const response = await fetch(f.origin + '/health', { signal: AbortSignal.timeout(2000) });
        expect(response.status).toBe(200);
        await response.arrayBuffer();
      } finally {
        release.resolve();
      }
      await outcome;
    },
  );
  it('propagates an unknown worker timeout without qualifying or retrying', async () => {
    const f = await fixture();
    const scan = vi
      .spyOn(integrity, 'verifyMigrationDatabaseIntegrity')
      .mockRejectedValue(new UpgradeError('GLOBAL_SCHEMA_INTEGRITY_TIMEOUT'));
    await expect(f.prove()).rejects.toMatchObject({ code: 'GLOBAL_SCHEMA_INTEGRITY_TIMEOUT' });
    expect(scan).toHaveBeenCalledTimes(1);
  });
});
