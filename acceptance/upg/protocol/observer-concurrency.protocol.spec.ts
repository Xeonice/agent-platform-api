import 'reflect-metadata';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID, generateKeyPairSync, sign } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  IMAGE_SPEC_REGISTRY,
  SANDBOX_PROVIDER_REGISTRY,
  UpgradeManifestSchema,
  ConfirmedServiceReleaseSchema,
  type ProviderRegistry,
  type SignedUpgradeManifest,
} from '@platform/contracts';
import { ProtocolProvider, registryMetadataFixture } from '../../support/protocol-resources';
import { useEnv } from '../../support/strict-ports';
import { configurePlatformApp } from '../../../apps/api/src/bootstrap/configure-app';
import { PLATFORM_SQLITE } from '../../../apps/api/src/platform/persistence/platform.module';
import { UpgradeStore } from '../../../apps/api/src/platform/upgrade/upgrade-store';
import { UpgradeObserver } from '../../../apps/api/src/platform/upgrade/upgrade-observer';
import {
  canonicalUpgrade,
  freezeUpgradePlan,
  upgradeDigest,
} from '../../../apps/api/src/platform/upgrade/upgrade-trust';
import type Database from 'better-sqlite3';
import type { INestApplication } from '@nestjs/common';
import { HelperContainerSession } from '@platform/runtime';

// Actual Nest business usecases, independent compiled ControlAPI, production
// Entry/Observer and committed SQLite. Only the external runtime is I-fixture.
// Intent/manifest metadata is state-layer setup, NOT release or native evidence.
const instanceId = 'observer-concurrency-fixture';
const controlKey = 'synthetic-observer-control-key-32-characters';
const controllerKey = 'synthetic-observer-controller-key-32-characters';
const entryKey = 'synthetic-observer-entry-key-32-characters';
let app: INestApplication, role: ChildProcessWithoutNullStreams, db: Database.Database;
let directory = '',
  restore = () => {};
let provider: ProtocolProvider, store: UpgradeStore, observer: UpgradeObserver;
let entry: { origin: string; controlOrigin: string; close: () => Promise<void> };
let attemptId = '',
  fence = 0,
  roleOrigin = '';
const components = () => {
  const artifact = {
    artifactDigest: upgradeDigest({ scope: 'observer-state-only' }),
    inputFingerprint: upgradeDigest({ scope: 'observer-state-input' }),
    sourceRevision: 'a'.repeat(40),
    protocol: { min: 1, max: 2 },
  };
  return {
    api: artifact,
    coordinator: artifact,
    installer: artifact,
    web: { ...artifact, webRevision: 'a'.repeat(40) },
  };
};
async function startControl(coordinatorUrl: string): Promise<string> {
  const env = {
    ...process.env,
    PLATFORM_PROCESS_ROLE: 'control',
    PLATFORM_INSTANCE_ID: instanceId,
    PLATFORM_CONTROL_RPC_KEY: controlKey,
    COORDINATOR_RPC_URL: coordinatorUrl,
    PORT: '0',
    HOST: '127.0.0.1',
  };
  for (const name of [
    'DATABASE_URL',
    'DATA_ROOT',
    'BOXLITE_HOME',
    'RUNTIME_OWNER_HOME',
    'PLATFORM_COORDINATOR_RPC_KEY',
    'PLATFORM_CONTROLLER_RPC_KEY',
    'PLATFORM_ENTRY_CONTROL_KEY',
  ])
    delete (env as NodeJS.ProcessEnv)[name];
  role = spawn(
    process.execPath,
    [
      '-e',
      `require(${JSON.stringify(resolve('apps/api/dist/roles/control-api-main.js'))}).startControlApi().then(s=>console.log('OBS_CONTROL:'+JSON.stringify(s.address())))`,
    ],
    { env, stdio: 'pipe' },
  );
  return new Promise((ok, fail) => {
    let out = '';
    const timer = setTimeout(() => fail(new Error('Independent ControlAPI did not start')), 10000);
    role.stderr.resume();
    role.stdout.on('data', (bytes) => {
      out += String(bytes);
      const match = /OBS_CONTROL:(\{[^\n]+\})/.exec(out);
      if (!match) return;
      const value = JSON.parse(match[1]!) as { port: number };
      clearTimeout(timer);
      ok('http://127.0.0.1:' + String(value.port));
    });
    role.once('error', (error) => {
      clearTimeout(timer);
      fail(error);
    });
    role.once('exit', () => {
      clearTimeout(timer);
      fail(new Error('Independent ControlAPI exited before readiness'));
    });
  });
}
beforeAll(async () => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), 'upg-observer-real-http-')));
  restore = useEnv({
    DATABASE_URL: join(directory, 'platform.sqlite'),
    DATA_ROOT: directory,
    PLATFORM_PROCESS_ROLE: 'coordinator',
    PLATFORM_INSTANCE_ID: instanceId,
    PLATFORM_CONTROL_RPC_KEY: controlKey,
    PLATFORM_CONTROLLER_RPC_KEY: controllerKey,
    PLATFORM_ENTRY_CONTROL_KEY: entryKey,
    ACCESS_PASSCODE_AUTO_GENERATE: 'false',
    ACCESS_PASSCODE: 'synthetic-observer-access-passcode',
    ACCESS_PASSCODE_ALLOW_LOOPBACK: 'false',
    SANDBOX_DEFAULT_IMAGE: 'ghcr.io/agent-infra/sandbox:latest',
  });
  const { AppModule } = await import('../../../apps/api/src/app.module');
  provider = new ProtocolProvider();
  const providers: ProviderRegistry = {
    defaultProvider: provider.name,
    get: () => provider,
    has: (name) => name === provider.name,
    list: () => [provider],
    register: () => {
      throw new Error('Only external I-fixture is configured');
    },
  };
  const module = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(SANDBOX_PROVIDER_REGISTRY)
    .useValue(providers)
    .overrideProvider(IMAGE_SPEC_REGISTRY)
    .useValue(registryMetadataFixture())
    .compile();
  app = module.createNestApplication();
  configurePlatformApp(app);
  await app.init();
  await app.listen(0, '127.0.0.1');
  await vi.waitFor(
    () =>
      expect(app.get(HelperContainerSession, { strict: false }).status()).toMatchObject({
        ready: true,
        starting: false,
      }),
    { timeout: 10000 },
  );
  db = app.get(PLATFORM_SQLITE, { strict: false });
  store = app.get(UpgradeStore, { strict: false });
  observer = app.get(UpgradeObserver, { strict: false });
  roleOrigin = await startControl(await app.getUrl());
  const schema = (db.prepare('SELECT count(*) n FROM __drizzle_migrations').get() as { n: number })
    .n;
  const current = ConfirmedServiceReleaseSchema.parse({
    releaseId: '0.2.0',
    activationGeneration: 1,
    activatedAt: new Date().toISOString(),
    schema,
    channel: 'observer-state-only',
    components: components(),
    commits: { project: 'a'.repeat(40), api: 'a'.repeat(40), web: 'a'.repeat(40) },
    productionWebBinding: 'http://127.0.0.1/observer-fixture',
  });
  store.bootstrap(current);
  const artifact = components().api;
  const manifest = UpgradeManifestSchema.parse({
    schemaVersion: 2,
    releaseId: '0.2.1',
    channel: current.channel,
    publishedAt: new Date().toISOString(),
    components: components(),
    commits: current.commits,
    packages: [
      {
        platform: process.platform,
        arch: process.arch,
        name: 'observer-state-only.tgz',
        url: 'https://observer.invalid/package.tgz',
        digest: upgradeDigest({ scope: 'not-a-release-package' }),
        bytes: 1,
        format: 'native-tar',
      },
    ],
    upgradePaths: [
      {
        fromRelease: current.releaseId,
        minSchema: schema,
        maxSchema: schema,
        targetSchema: schema,
        bridgeReleases: [],
        migrationPlanDigest: null,
      },
    ],
    policy: {
      id: 'observer-state-only',
      weights: [1, 5, 25, 100],
      stageDurationMs: 60000,
      minRequests: 100,
      observationFreshnessMs: 5000,
      probeHz: 10,
      requestDeadlineMs: 2000,
      attachDeadlineMs: 5000,
      softErrorDelta: 0.01,
      p95Ratio: 2,
      p95FloorMs: 1000,
      evaluationIntervalMs: 10000,
      consecutiveEvaluations: 2,
      retentionMs: 60000,
      migrationBatchMs: 50,
      maxWalBytes: 67108864,
      minFreeBytes: 1,
      fallbacks: [
        {
          releaseId: current.releaseId,
          apiDigest: artifact.artifactDigest,
          webDigest: artifact.artifactDigest,
          rehearsed: false,
        },
      ],
      stopUserResources: false,
      restoreLiveVolume: false,
      contractInUpgrade: false,
    },
    evidence: [],
  });
  const keys = generateKeyPairSync('ed25519');
  const envelope: SignedUpgradeManifest = {
    manifest,
    manifestDigest: upgradeDigest(manifest),
    signature: {
      algorithm: 'Ed25519',
      keyId: 'state-only',
      value: sign(null, Buffer.from(canonicalUpgrade(manifest)), keys.privateKey).toString(
        'base64',
      ),
    },
  };
  const accepted = store.accept(
    'state-layer-explicit-observer-actor',
    {
      requestId: randomUUID(),
      targetReleaseId: manifest.releaseId,
      targetDigest: envelope.manifestDigest,
      expectedActivationGeneration: 1,
    },
    envelope,
    freezeUpgradePlan(envelope, current),
  );
  attemptId = accepted.attemptId;
  fence = store.claim(attemptId, 'state-layer-observer-controller', 30000).fence;
  const imported = (await import(resolve('../deploy/upgrade/stable-entry.mjs'))) as {
    createStableEntry: (options: Record<string, unknown>) => Promise<typeof entry>;
  };
  expect(typeof imported.createStableEntry).toBe('function');
  entry = await imported.createStableEntry({
    root: join(directory, 'entry'),
    instanceId,
    controlKey: entryKey,
    stickyKey: 'synthetic-observer-sticky-key-32-characters',
    verifyFence: ({ fence: actual }: { fence: number }) => {
      store.assertFence(attemptId, actual);
      return Promise.resolve(true);
    },
    initialBinding: {
      instanceId,
      attemptId,
      fence,
      routeGeneration: 1,
      weight: 0,
      oldApi: { origin: roleOrigin, digest: artifact.artifactDigest },
      candidateApi: null,
      web: {
        root: directory,
        digest: artifact.artifactDigest,
        treeDigest: artifact.artifactDigest,
      },
      retainedWeb: [],
    },
  });
  process.env.PLATFORM_ENTRY_ORIGIN = entry.origin;
  process.env.PLATFORM_ENTRY_CONTROL_ORIGIN = entry.controlOrigin;
});
afterAll(async () => {
  role?.kill('SIGCONT');
  observer?.onModuleDestroy();
  if (role && !role.killed) role.kill('SIGTERM');
  await entry?.close();
  await app?.close();
  provider?.close();
  restore();
  if (directory) rmSync(directory, { recursive: true, force: true });
});
interface Sample {
  observed_at: number;
  latency_ms: number;
  success: number;
  request_id: string;
  route_generation: number;
}
const samples = (generation: number) =>
  db
    .prepare(
      'SELECT observed_at,latency_ms,success,request_id,route_generation FROM upgrade_observations WHERE attempt_id=? AND route_generation=? ORDER BY observed_at',
    )
    .all(attemptId, generation) as Sample[];
const p95 = (rows: Sample[]) =>
  rows.map((row) => row.latency_ms).sort((a, b) => a - b)[
    Math.max(0, Math.ceil(rows.length * 0.95) - 1)
  ] ?? 0;

describe('UPG actual concurrent HTTP observer, independent ControlAPI and original SQLite', () => {
  it('maintains >=10 real starts/s under 1100ms process suspension, with exact write/read values, no duplicate requests and measured soft latency', async () => {
    const beforeLifecycle = provider.calls.filter((method) =>
      ['create', 'start', 'stop', 'destroy'].includes(method),
    );
    await vi.waitFor(() => expect(samples(1).length).toBeGreaterThanOrEqual(100), {
      timeout: 10000,
      interval: 50,
    });
    const baseline = samples(1);
    expect(baseline.every((row) => row.success === 1)).toBe(true);
    const response = await fetch(entry.controlOrigin + '/binding', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-platform-internal-key': entryKey },
      body: JSON.stringify({
        instanceId,
        attemptId,
        fence,
        routeGeneration: 2,
        weight: 100,
        oldApi: { origin: roleOrigin, digest: components().api.artifactDigest },
        candidateApi: { origin: roleOrigin, digest: components().api.artifactDigest },
        web: {
          root: directory,
          digest: components().web.artifactDigest,
          treeDigest: components().web.artifactDigest,
        },
        retainedWeb: [],
      }),
    });
    expect(response.status).toBe(200);
    for (let i = 0; i < 3; i++) {
      expect(role.pid).toBeTypeOf('number');
      expect(role.kill('SIGSTOP')).toBe(true);
      try {
        await delay(1100);
      } finally {
        role.kill('SIGCONT');
      }
      await delay(400);
    }
    await delay(1500);
    const measured = samples(2),
      window = measured.at(-1)!.observed_at - measured[0]!.observed_at;
    expect(measured.length).toBeGreaterThanOrEqual(50);
    expect((1000 * (measured.length - 1)) / window).toBeGreaterThanOrEqual(10);
    expect(measured.every((row) => row.success === 1)).toBe(true);
    expect(Math.max(...measured.map((row) => row.latency_ms))).toBeLessThanOrEqual(2000);
    expect(p95(measured)).toBeGreaterThan(1000);
    expect(p95(measured)).toBeGreaterThan(2 * p95(baseline));
    expect(new Set(measured.map((row) => row.request_id)).size).toBe(measured.length);
    const values = db
      .prepare('SELECT count(*) n FROM upgrade_probe_records WHERE attempt_id=?')
      .get(attemptId) as { n: number };
    expect(values.n).toBeGreaterThanOrEqual(baseline.length + measured.length);
    expect(db.pragma('quick_check', { simple: true })).toBe('ok');
    expect(
      provider.calls.filter((method) => ['create', 'start', 'stop', 'destroy'].includes(method)),
    ).toEqual(beforeLifecycle);
  });
});
