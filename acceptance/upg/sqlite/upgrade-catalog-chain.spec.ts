import 'reflect-metadata';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UpgradeCatalog } from '../../../apps/api/src/platform/upgrade/upgrade-catalog';
import { UpgradeStore } from '../../../apps/api/src/platform/upgrade/upgrade-store';
import type { UpgradeInspector } from '../../../apps/api/src/platform/upgrade/upgrade-inspector';
import { currentDatabase } from '../../support/sqlite';
import { deferred, useEnv } from '../../support/strict-ports';
import {
  planFixtureEnvelope,
  planFixtureRoots,
  planFixtureSource,
} from '../../support/upgrade-plan-fixture';
import {
  canonicalUpgrade,
  upgradeDigest,
  upgradeRunInputFingerprint,
} from '../../../apps/api/src/platform/upgrade/upgrade-trust';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
async function fixture(capable = true) {
  const home = await mkdtemp(join(tmpdir(), 'catalog-chain-boundary-')),
    root = join(home, 'trust.json'),
    catalogFile = join(home, 'catalog.json');
  const source = planFixtureSource(),
    bridge = planFixtureEnvelope(source, '0.2.1', [], capable);
  const final = planFixtureEnvelope(
    {
      ...source,
      releaseId: '0.2.1',
      activationGeneration: 2,
      components: bridge.manifest.components,
    },
    '0.2.2',
    ['0.2.1'],
  );
  await writeFile(root, JSON.stringify(planFixtureRoots()), { mode: 0o600 });
  await writeFile(
    catalogFile,
    JSON.stringify({
      schemaVersion: 1,
      releases: [bridge, final].map((envelope) => ({
        envelope,
        releaseId: envelope.manifest.releaseId,
        manifestDigest: envelope.manifestDigest,
      })),
    }),
    { mode: 0o600 },
  );
  const restore = useEnv({
    PLATFORM_INSTANCE_ID: 'catalog-chain-boundary',
    UPGRADE_TRUST_ROOT_PATH: root,
    UPGRADE_CATALOG_FILE: catalogFile,
  });
  const db = currentDatabase();
  let time = Date.now();
  const clock = { now: () => new Date(time) },
    store = new UpgradeStore(db.sqlite, clock, { next: randomUUID });
  store.bootstrap(source);
  const inspectorBoundary: Partial<UpgradeInspector> = {
    sourceActual: async () => null,
    installedProof: async () => ({ qualified: true }),
    schema: () => source.schema,
    requiresProjectNameV2: () =>
      !!db.sqlite
        .prepare('SELECT 1 FROM upgrade_online_migrations WHERE read_epoch=2 LIMIT 1')
        .get(),
  };
  const inspector = inspectorBoundary as UpgradeInspector;
  const catalog = new UpgradeCatalog(store, clock, inspector);
  cleanups.push(async () => {
    db.sqlite.close();
    restore();
    await rm(home, { recursive: true, force: true });
  });
  return {
    catalog,
    bridge,
    final,
    inspector,
    home,
    trustRootPath: root,
    catalogFile,
    advance: (ms: number) => {
      time += ms;
    },
  };
}
describe('real signed catalog final-target compatibility eligibility', () => {
  it('uses the explicit isolated control root without a business DATA_ROOT and rejects missing/relative/outside homes', async () => {
    const f = await fixture(),
      keys = generateKeyPairSync('ed25519');
    const manifest = {
      ...f.bridge.manifest,
      purpose: 'qualification' as const,
      qualification: {
        instanceId: 'catalog-chain-boundary',
        inputFingerprint: upgradeRunInputFingerprint(f.bridge.manifest),
      },
    };
    const envelope = {
      manifest,
      manifestDigest: upgradeDigest(manifest),
      signature: {
        algorithm: 'Ed25519',
        keyId: 'qualification-fixture',
        value: sign(null, Buffer.from(canonicalUpgrade(manifest)), keys.privateKey).toString(
          'base64',
        ),
      },
    };
    const roots = {
      ...planFixtureRoots(),
      purpose: 'qualification',
      qualificationInstanceId: 'catalog-chain-boundary',
      keys: [
        {
          id: 'qualification-fixture',
          publicKey: keys.publicKey.export({ format: 'pem', type: 'spki' }),
        },
      ],
    };
    const proofPath = join(f.home, 'qualification.json');
    await writeFile(f.trustRootPath, JSON.stringify(roots), { mode: 0o600 });
    await writeFile(
      f.catalogFile,
      JSON.stringify({
        schemaVersion: 1,
        releases: [
          { envelope, releaseId: manifest.releaseId, manifestDigest: envelope.manifestDigest },
        ],
      }),
      { mode: 0o600 },
    );
    await writeFile(
      proofPath,
      JSON.stringify({
        purpose: 'qualification',
        instanceId: 'catalog-chain-boundary',
        trustRootDigest: upgradeDigest(roots),
        isolatedRoot: f.home,
      }),
      { mode: 0o600 },
    );
    const restore = useEnv({
      PLATFORM_PROCESS_ROLE: 'upgrade-control',
      DATA_ROOT: undefined,
      UPGRADE_CONTROL_ROOT: join(f.home, 'control'),
      UPGRADE_QUALIFICATION_INSTALLATION_PATH: proofPath,
    });
    try {
      await f.catalog.refresh();
      expect(f.catalog.status().state).toBe('verified');
      for (const invalid of [
        undefined,
        '',
        'relative-control',
        f.home,
        join(f.home, '..', 'outside-control'),
      ]) {
        const reset = useEnv({ UPGRADE_CONTROL_ROOT: invalid });
        try {
          await f.catalog.refresh();
          expect(f.catalog.status()).toMatchObject({
            state: 'unknown',
            reason: 'QUALIFICATION_HOME_NOT_ISOLATED',
          });
        } finally {
          reset();
        }
      }
    } finally {
      restore();
    }
  });
  it('advertises the final target and immutable two-node chain without downloading execution packages, then withdraws stale eligibility', async () => {
    const f = await fixture();
    await f.catalog.refresh();
    expect(f.catalog.status()).toMatchObject({
      state: 'verified',
      availableRelease: { releaseId: f.final.manifest.releaseId, supportsAsync: true },
    });
    expect(
      f.catalog
        .target(f.final.manifest.releaseId, f.final.manifestDigest)
        .chain.map((stage) => stage.envelope.manifestDigest),
    ).toEqual([f.bridge.manifestDigest, f.final.manifestDigest]);
    f.advance(5001);
    expect(f.catalog.status()).toMatchObject({
      state: 'unknown',
      availableRelease: null,
      reason: 'CATALOG_OBSERVATION_STALE',
    });
    expect(() => f.catalog.target(f.final.manifest.releaseId, f.final.manifestDigest)).toThrow(
      'UPGRADE_TARGET_UNAVAILABLE',
    );
  });
  it('does not advertise an unresumable final chain, while preserving an explicitly legacy direct target', async () => {
    const f = await fixture(false);
    await f.catalog.refresh();
    expect(f.catalog.status()).toMatchObject({
      state: 'verified',
      availableRelease: { releaseId: f.bridge.manifest.releaseId, supportsAsync: false },
    });
    expect(() => f.catalog.target(f.final.manifest.releaseId, f.final.manifestDigest)).toThrow(
      'UPGRADE_TARGET_UNAVAILABLE',
    );
  });
  it('keeps the last verified target during a concurrent refresh, without extending its freshness or silently accepting a failed refresh', async () => {
    const f = await fixture();
    await f.catalog.refresh();
    const pending = deferred<null>();
    vi.spyOn(f.inspector, 'sourceActual').mockImplementation(() => pending.promise);
    const refreshing = f.catalog.refresh();
    expect(
      f.catalog.target(f.final.manifest.releaseId, f.final.manifestDigest).envelope.manifestDigest,
    ).toBe(f.final.manifestDigest);
    f.advance(5001);
    expect(() => f.catalog.target(f.final.manifest.releaseId, f.final.manifestDigest)).toThrow(
      'UPGRADE_TARGET_UNAVAILABLE',
    );
    pending.resolve(null);
    await refreshing;
    expect(
      f.catalog.target(f.final.manifest.releaseId, f.final.manifestDigest).envelope.manifestDigest,
    ).toBe(f.final.manifestDigest);
    vi.spyOn(f.inspector, 'installedProof').mockRejectedValue(
      new Error('controlled-source-proof-loss'),
    );
    await f.catalog.refresh();
    expect(f.catalog.status().state).toBe('unknown');
    expect(() => f.catalog.target(f.final.manifest.releaseId, f.final.manifestDigest)).toThrow(
      'UPGRADE_TARGET_UNAVAILABLE',
    );
  });
});
