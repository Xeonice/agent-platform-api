import { assertDefined } from '../../support/assert-defined';
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Test } from '@nestjs/testing';
import { UpgradeSourceActualSchema } from '@platform/contracts';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UpgradeService } from '../../../apps/api/src/platform/upgrade/upgrade-service';
import { UpgradeOperationStore } from '../../../apps/api/src/platform/upgrade/upgrade-operation-store';
import { UpgradeProjection } from '../../../apps/api/src/platform/upgrade/upgrade-projection';
import { UpgradeStore } from '../../../apps/api/src/platform/upgrade/upgrade-store';
import { UpgradeContractStore } from '../../../apps/api/src/platform/upgrade/upgrade-contract-store';
import { UpgradeController } from '../../../apps/api/src/platform/upgrade/upgrade.controller';
import { UpgradeSecurity } from '../../../apps/api/src/platform/access-passcode/upgrade-security.service';
import { PasscodeService } from '../../../apps/api/src/platform/access-passcode/passcode.service';
import { PasscodeGuard } from '../../../apps/api/src/platform/access-passcode/passcode.guard';
import { PasscodeAttemptLimiter } from '../../../apps/api/src/platform/access-passcode/passcode-attempt-limiter';
import { DeploymentState } from '../../../apps/api/src/platform/deployment/deployment-state';
import { configurePlatformApp } from '../../../apps/api/src/bootstrap/configure-app';
import { freezeUpgradeChain } from '../../../apps/api/src/platform/upgrade/upgrade-chain';
import { upgradeDigest } from '../../../apps/api/src/platform/upgrade/upgrade-trust';
import {
  withCoordinatorBusinessEpoch,
  fenceCoordinatorConnection,
  coordinatorWriterControl,
} from '../../../apps/api/src/platform/persistence/coordinator-lease';
import type { UpgradeInspector } from '../../../apps/api/src/platform/upgrade/upgrade-inspector';
import type { UpgradeCatalog } from '../../../apps/api/src/platform/upgrade/upgrade-catalog';
import { currentDatabase } from '../../support/sqlite';
import { deferred, useEnv, unused } from '../../support/strict-ports';
import {
  planFixtureEnvelope,
  planFixtureRoots,
  planFixtureSource,
  planFixtureArtifact,
} from '../../support/upgrade-plan-fixture';

const origin = 'http://127.0.0.1:49217';
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});

/** Real HTTP authentication/CSRF, SQLite intents, Ed25519 envelopes and epoch
 * fencing. Only external physical preparation is delayed/controlled. No native
 * installer, model continuity or 1GB performance qualification is claimed. */
async function fixture(chainLength = 2, fenced = false) {
  const home = await mkdtemp(join(tmpdir(), 'upgrade-operation-boundary-'));
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(req.url === '/api/health' ? { status: 'ok' } : { ok: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const entry = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const root = join(home, 'trust.json');
  await writeFile(root, JSON.stringify(planFixtureRoots()), { mode: 0o600 });
  const restore = useEnv({
    PLATFORM_INSTANCE_ID: 'upgrade-operation-boundary',
    PLATFORM_PROCESS_ROLE: undefined,
    COORDINATOR_WRITER_FENCE_VALID: undefined,
    UPGRADE_TRUST_ROOT_PATH: root,
    PLATFORM_ENTRY_CONTROL_ORIGIN: entry,
    PLATFORM_ENTRY_ORIGIN: entry,
    PLATFORM_ENTRY_CONTROL_KEY: 'boundary-entry-key-not-production-32',
    UPGRADE_SESSION_SECRET: 'boundary-upgrade-session-not-production-32',
    PASSCODE_COOKIE_SECRET: 'boundary-passcode-session-not-production-32',
    ACCESS_PASSCODE: 'ordinary-boundary-passcode',
    ACCESS_PASSCODE_ALLOW_LOOPBACK: 'false',
    API_ALLOWED_ORIGINS: origin,
  });
  const db = currentDatabase(),
    clock = { now: () => new Date() },
    ids = { next: randomUUID };
  const sqlite = fenced
    ? fenceCoordinatorConnection(db.sqlite, 'upgrade-operation-boundary', clock, ids)
    : db.sqlite;
  const store = new UpgradeStore(sqlite, clock, ids),
    source = planFixtureSource();
  store.bootstrap(source);
  const bridge = planFixtureEnvelope(source, '0.2.1');
  const final =
    chainLength === 1
      ? bridge
      : planFixtureEnvelope(
          {
            ...source,
            releaseId: bridge.manifest.releaseId,
            activationGeneration: 2,
            components: bridge.manifest.components,
          },
          '0.2.2',
          ['0.2.1'],
        );
  const envelopes = chainLength === 1 ? [final] : [bridge, final];
  const chain = freezeUpgradeChain(final, source, envelopes);
  const preparation = deferred<Record<string, unknown>>(),
    catalogRead = deferred<void>();
  const capture = vi.fn(() => preparation.promise);
  const installedProof = vi.fn(async () => ({ qualified: true }));
  const inspectorBoundary: Partial<UpgradeInspector> = {
    requiresProjectNameV2: () => false,
    sourceActual: async () => null,
    installedProof,
    capture,
    entryBinding: async () => ({ fence: 0, web: { digest: source.components.web.artifactDigest } }),
    webBuild: async () => ({
      releaseId: source.releaseId,
      webRevision: source.components.web.webRevision,
    }),
    defaultImagesSnapshot: () => [],
  };
  const inspector = inspectorBoundary as UpgradeInspector;
  const catalogBoundary: Partial<UpgradeCatalog> = {
    target: (release: string, digest: string) => {
      if (release !== final.manifest.releaseId || digest !== final.manifestDigest)
        throw new Error('unavailable target');
      return { envelope: final, plan: chain[chain.length - 1].plan, chain, sourceActual: null };
    },
    refresh: vi.fn(() => catalogRead.promise),
    status: () => ({
      state: 'verified',
      reason: null,
      observedAt: clock.now().toISOString(),
      availableRelease: {
        releaseId: final.manifest.releaseId,
        targetDigest: final.manifestDigest,
        webRevision: final.manifest.components.web.webRevision,
        webArtifactDigest: final.manifest.components.web.artifactDigest,
        installable: true,
        supportsAsync: true,
      },
    }),
  };
  const catalog = catalogBoundary as UpgradeCatalog;
  const operations = new UpgradeOperationStore(store, clock, ids),
    projection = new UpgradeProjection(store, catalog, inspector, clock);
  const passcodes = new PasscodeService(db.db),
    security = new UpgradeSecurity(clock, ids, passcodes);
  const service = new UpgradeService(
    store,
    catalog,
    security,
    inspector,
    clock,
    undefined,
    operations,
    projection,
  );
  // Drive exact worker turns explicitly in this protocol fixture. The production
  // lifecycle timer and Native pending loop have separate integration coverage.
  vi.spyOn(service, 'onApplicationBootstrap').mockImplementation(() => undefined);
  Reflect.set(service, 'scheduleOperation', () => undefined);
  const module = await Test.createTestingModule({
    controllers: [UpgradeController],
    providers: [DeploymentState, { provide: UpgradeService, useValue: service }],
  }).compile();
  const app = module.createNestApplication();
  app.useGlobalGuards(new PasscodeGuard(passcodes, new PasscodeAttemptLimiter()));
  configurePlatformApp(app, { allowedOrigins: [origin], trustProxy: 'none' });
  await app.listen(0, '127.0.0.1');
  const session = 'ap_session=' + passcodes.issueCurrentSessionToken();
  const status = await request(app.getHttpServer())
    .get('/api/system/upgrade/status')
    .set('Cookie', session)
    .expect(200);
  const setCookie: unknown = status.headers['set-cookie'];
  const cookies = Array.isArray(setCookie)
    ? setCookie.filter((value): value is string => typeof value === 'string')
    : typeof setCookie === 'string'
      ? [setCookie]
      : [];
  const cookie = session + '; ' + cookies.map((value) => value.split(';')[0]).join('; ');
  const command = {
    requestId: randomUUID(),
    targetReleaseId: final.manifest.releaseId,
    targetDigest: final.manifestDigest,
    expectedActivationGeneration: 1,
  };
  const post = (body = command, prefer = true) => {
    const outgoing = request(app.getHttpServer())
      .post('/api/system/upgrade/requests')
      .set('Cookie', cookie)
      .set('Origin', origin)
      .set('X-Upgrade-CSRF', status.body.csrfToken);
    return (prefer ? outgoing.set('Prefer', 'respond-async') : outgoing).send(body);
  };
  cleanups.push(async () => {
    service.onModuleDestroy();
    projection.onModuleDestroy();
    preparation.resolve({ resources: [] });
    catalogRead.resolve();
    await new Promise((resolve) => setTimeout(resolve, 25));
    await app.close();
    sqlite.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(home, { recursive: true, force: true });
    restore();
  });
  return {
    app,
    db,
    sqlite,
    store,
    operations,
    projection,
    service,
    inspector,
    security,
    clock,
    ids,
    chain,
    command,
    post,
    cookie,
    capture,
    installedProof,
    preparation,
    catalogRead,
    csrf: status.body.csrfToken as string,
  };
}
function confirmTechnicalStage(f: Awaited<ReturnType<typeof fixture>>, attemptId: string) {
  f.store.claim(attemptId, 'state-fixture-controller', 30000);
  const commit = (
    kind: 'step-applied' | 'activation-confirmed',
    payload: Record<string, unknown>,
    confirmed?: ReturnType<UpgradeStore['confirmed']>,
  ) => {
    const snapshot = f.store.snapshot(attemptId);
    return f.store.commit(
      attemptId,
      {
        fence: snapshot.fence,
        generation: snapshot.attempt.generation,
        expectedSequence: snapshot.attempt.sequence,
        eventId: randomUUID(),
        kind,
        payload,
      },
      confirmed ?? undefined,
    );
  };
  for (const step of f.store.plan(attemptId).steps) {
    const evidence = { syntheticStateBoundary: step.stepId };
    commit('step-applied', {
      stepId: step.stepId,
      completedWork: step.totalWork,
      receiptDigest: upgradeDigest(evidence),
      evidence,
    });
  }
  const snapshot = f.store.snapshot(attemptId),
    before = assertDefined(f.store.confirmed());
  commit(
    'activation-confirmed',
    {},
    {
      ...before,
      releaseId: snapshot.manifest.releaseId,
      activationGeneration: before.activationGeneration + 1,
      components: snapshot.manifest.components,
      commits: snapshot.manifest.commits,
      activatedAt: f.clock.now().toISOString(),
    },
  );
}

describe('one explicit final-target operation with fast authenticated reads', () => {
  it('returns real 202 and status/lookup within two seconds while physical preparation and catalog are blocked; retries/mode changes have one intent', async () => {
    const f = await fixture();
    const begin = performance.now(),
      accepted = await f
        .post()
        .expect((response) => {
          if (response.status !== 202) throw new Error(JSON.stringify(response.body));
        })
        .expect(202);
    expect(performance.now() - begin).toBeLessThan(2000);
    expect(accepted.body).toMatchObject({
      requestId: f.command.requestId,
      state: 'accepted',
      sequence: 0,
      percent: null,
    });
    expect(accepted.body.attemptId).toBeUndefined();
    expect(f.store.latest()).toBeNull();
    const advancing = f.service.advanceOperation();
    await expect.poll(() => f.capture.mock.calls.length).toBe(1);
    const startRead = performance.now();
    const reading = await request(f.app.getHttpServer())
      .get('/api/system/upgrade/status')
      .set('Cookie', f.cookie)
      .expect(200);
    const lookup = await request(f.app.getHttpServer())
      .get('/api/system/upgrade/requests/' + f.command.requestId)
      .set('Cookie', f.cookie)
      .set('Prefer', 'respond-async')
      .expect(200);
    expect(performance.now() - startRead).toBeLessThan(2000);
    expect(reading.body.operation.operationId).toBe(accepted.body.operationId);
    expect(lookup.body.operationId).toBe(accepted.body.operationId);
    expect(lookup.headers['cache-control']).toBe('no-store');
    expect(lookup.headers.vary).toContain('Prefer');
    expect((await f.post().expect(202)).body.operationId).toBe(accepted.body.operationId);
    await f.post(f.command, false).expect(409);
    await f.post({ ...f.command, targetDigest: 'sha256:' + 'f'.repeat(64) }).expect(409);
    expect(
      f.db.sqlite
        .prepare("SELECT count(*) n FROM platform_operations WHERE role='upgrade-plan'")
        .get(),
    ).toEqual({ n: 1 });
    expect(f.store.latest()).toBeNull();
    f.preparation.resolve({ resources: [] });
    await advancing;
    expect(f.store.latest()?.targetReleaseId).toBe('0.2.1');
  });
  it('resumes one immutable two-stage plan from another service instance, preserving the first 100 and completing only the final target', async () => {
    const f = await fixture();
    const accepted = (await f.post().expect(202)).body;
    f.preparation.resolve({ resources: [] });
    await f.service.advanceOperation();
    const first = assertDefined(f.store.latest());
    confirmTechnicalStage(f, first.attemptId);
    const resumed = new UpgradeService(
      f.store,
      undefined as never,
      f.security,
      f.inspector,
      f.clock,
      undefined,
      new UpgradeOperationStore(f.store, f.clock, f.ids),
    );
    await resumed.advanceOperation();
    expect(assertDefined(f.operations.latest()).operation).toMatchObject({
      operationId: accepted.operationId,
      currentStageIndex: 1,
      state: 'preparing',
      percent: null,
    });
    expect(f.store.attempt(first.attemptId).percent).toBe(100);
    await resumed.advanceOperation();
    const final = assertDefined(f.store.latest());
    expect(final.attemptId).not.toBe(first.attemptId);
    expect(final.targetDigest).toBe(f.command.targetDigest);
    confirmTechnicalStage(f, final.attemptId);
    await resumed.advanceOperation();
    expect(assertDefined(f.operations.latest()).operation).toMatchObject({
      state: 'completed',
      percent: 100,
      currentStageIndex: 1,
    });
    expect(f.db.sqlite.prepare('SELECT count(*) n FROM upgrade_attempts').get()).toEqual({ n: 2 });
    await resumed.advanceOperation();
    expect(f.db.sqlite.prepare('SELECT count(*) n FROM upgrade_attempts').get()).toEqual({ n: 2 });
  });
  it('retains historical technical confirmation but defers the user plan when current activation proof is unknown, without a next attempt', async () => {
    const f = await fixture();
    await f.post().expect(202);
    f.preparation.resolve({ resources: [] });
    await f.service.advanceOperation();
    const first = assertDefined(f.store.latest());
    confirmTechnicalStage(f, first.attemptId);
    f.installedProof.mockResolvedValue({ qualified: false });
    await f.service.advanceOperation();
    expect(assertDefined(f.operations.latest()).operation).toMatchObject({
      state: 'deferred',
      reason: 'UPGRADE_STAGE_ACTIVATION_UNCONFIRMED',
      percent: null,
    });
    expect(f.store.attempt(first.attemptId)).toMatchObject({
      state: 'activation-confirmed',
      percent: 100,
    });
    await f.service.advanceOperation();
    expect(f.db.sqlite.prepare('SELECT count(*) n FROM upgrade_attempts').get()).toEqual({ n: 1 });
  });
  it('a retired writer suspended in preflight cannot queue or mark failed; the actual next epoch resumes exactly once', async () => {
    const f = await fixture(1, true);
    await f.post().expect(202);
    const old = withCoordinatorBusinessEpoch(f.sqlite, () => f.service.advanceOperation());
    await expect.poll(() => f.capture.mock.calls.length).toBe(1);
    coordinatorWriterControl(f.sqlite).release();
    const nextConnection = fenceCoordinatorConnection(
      f.db.sqlite,
      f.store.instanceId,
      f.clock,
      f.ids,
    );
    f.preparation.resolve({ resources: [] });
    await expect(old).rejects.toThrow();
    expect(f.store.latest()).toBeNull();
    const nextStore = new UpgradeStore(nextConnection, f.clock, f.ids),
      nextOperations = new UpgradeOperationStore(nextStore, f.clock, f.ids);
    const next = new UpgradeService(
      nextStore,
      undefined as never,
      f.security,
      f.inspector,
      f.clock,
      undefined,
      nextOperations,
    );
    await withCoordinatorBusinessEpoch(nextConnection, () => next.advanceOperation());
    expect(nextStore.latest()?.targetReleaseId).toBe(f.command.targetReleaseId);
    expect(f.db.sqlite.prepare('SELECT count(*) n FROM upgrade_attempts').get()).toEqual({ n: 1 });
    coordinatorWriterControl(nextConnection).release();
  });
  it('rejects CSRF, unsupported resume capability and both directions of another active mutation before creating an attempt', async () => {
    const f = await fixture(1);
    await request(f.app.getHttpServer())
      .post('/api/system/upgrade/requests')
      .set('Cookie', f.cookie)
      .set('Origin', origin)
      .set('Prefer', 'respond-async')
      .set('X-Upgrade-CSRF', 'wrong')
      .send(f.command)
      .expect(403);
    const coordinator = f.chain[0].envelope.manifest.components.coordinator;
    const supported = coordinator.upgradeOperationFormats;
    coordinator.upgradeOperationFormats = [];
    await f.post().expect(409);
    expect(f.operations.latest()).toBeNull();
    coordinator.upgradeOperationFormats = supported;
    await f.post().expect(202);
    const contracts = new UpgradeContractStore(f.store, f.clock, f.ids);
    expect(() =>
      contracts.accept(
        'instance-administrator',
        {
          requestId: randomUUID(),
          targetPlanDigest: 'sha256:' + 'a'.repeat(64),
          expectedActivationGeneration: 1,
          acknowledgeRollbackClosure: true,
        },
        unused<Parameters<UpgradeContractStore['accept']>[2]>('unused contract plan'),
        0,
      ),
    ).toThrow('UPGRADE_ALREADY_ACTIVE');
    expect(() =>
      f.store.accept(
        'instance-administrator',
        { ...f.command, requestId: randomUUID() },
        f.chain[0].envelope,
        f.chain[0].plan,
      ),
    ).toThrow('UPGRADE_ALREADY_ACTIVE');
    expect(f.store.latest()).toBeNull();
    expect(
      f.db.sqlite
        .prepare("SELECT count(*) n FROM platform_operations WHERE role='project-name-contract'")
        .get(),
    ).toEqual({ n: 0 });
  });
  it('mode opt-in after a real legacy acceptance returns that original technical attempt instead of executing a duplicate', async () => {
    const f = await fixture(1);
    f.catalogRead.resolve();
    f.preparation.resolve({ resources: [] });
    const legacy = (await f.post(f.command, false).expect(202)).body;
    const replay = (await f.post().expect(202)).body;
    expect(replay.attemptId).toBe(legacy.attemptId);
    expect(f.operations.latest()).toBeNull();
    expect(f.db.sqlite.prepare('SELECT count(*) n FROM upgrade_attempts').get()).toEqual({ n: 1 });
  });
  it('ready revocation during the final physical await wins over the older successful proof and cannot complete or advance the user plan', async () => {
    const f = await fixture();
    await f.post().expect(202);
    f.preparation.resolve({ resources: [] });
    await f.service.advanceOperation();
    const attempt = assertDefined(f.store.latest());
    confirmTechnicalStage(f, attempt.attemptId);
    const checking = deferred<{ qualified: boolean }>();
    f.installedProof.mockImplementation(() => checking.promise);
    const calls = f.installedProof.mock.calls.length;
    const advancing = f.service.advanceOperation();
    await expect.poll(() => f.installedProof.mock.calls.length).toBeGreaterThan(calls);
    const snapshot = f.store.snapshot(attempt.attemptId);
    f.store.commit(attempt.attemptId, {
      fence: snapshot.fence,
      generation: snapshot.attempt.generation,
      expectedSequence: snapshot.attempt.sequence,
      eventId: randomUUID(),
      kind: 'ready-revoked',
      payload: { reason: 'controlled-ready-revocation' },
    });
    checking.resolve({ qualified: true });
    await advancing;
    expect(assertDefined(f.operations.latest()).operation).toMatchObject({
      state: 'deferred',
      percent: null,
      reason: 'UPGRADE_STAGE_ACTIVATION_UNCONFIRMED',
    });
    expect(f.store.attempt(attempt.attemptId)).toMatchObject({
      state: 'activation-confirmed',
      percent: 100,
    });
    expect(f.db.sqlite.prepare('SELECT count(*) n FROM upgrade_attempts').get()).toEqual({ n: 1 });
  });
  it.each([true, false])(
    'reports a changed default only when both real snapshots are managed (managed=%s)',
    async (managed) => {
      const f = await fixture(1);
      const images = vi.spyOn(f.inspector, 'defaultImagesSnapshot');
      images.mockReturnValue([
        {
          provider: 'boxlite',
          managed,
          ref: 'registry.invalid/default:old',
          digest: 'sha256:' + 'a'.repeat(64),
          runtimeVersions: {},
        },
      ]);
      await f.post().expect(202);
      f.preparation.resolve({ resources: [] });
      await f.service.advanceOperation();
      const attempt = assertDefined(f.store.latest());
      confirmTechnicalStage(f, attempt.attemptId);
      images.mockReturnValue([
        {
          provider: 'boxlite',
          managed,
          ref: 'registry.invalid/default:new',
          digest: 'sha256:' + 'b'.repeat(64),
          runtimeVersions: { codex: 'fixture-version' },
        },
      ]);
      await f.service.advanceOperation();
      const update = assertDefined(f.operations.latest()).operation.defaultImageUpdate;
      if (managed)
        expect(update).toMatchObject({
          scope: 'managed-default',
          images: [
            {
              provider: 'boxlite',
              previousDigest: 'sha256:' + 'a'.repeat(64),
              digest: 'sha256:' + 'b'.repeat(64),
              runtimeVersions: { codex: 'fixture-version' },
            },
          ],
        });
      else expect(update).toBeNull();
    },
  );
  it('unknown default-image declarations omit the CLI promise without preventing an otherwise confirmed platform update', async () => {
    const f = await fixture(1);
    vi.spyOn(f.inspector, 'defaultImagesSnapshot').mockImplementation(() => {
      throw new Error('controlled-unavailable-image-declaration');
    });
    await f.post().expect(202);
    f.preparation.resolve({ resources: [] });
    await f.service.advanceOperation();
    confirmTechnicalStage(f, assertDefined(f.store.latest()).attemptId);
    await f.service.advanceOperation();
    expect(assertDefined(f.operations.latest()).operation).toMatchObject({
      state: 'completed',
      percent: 100,
      defaultImageUpdate: null,
    });
  });
  it('keeps the measured partial source tuple consistent between the catalog plan and actual attempt admission', async () => {
    const f = await fixture();
    const source = assertDefined(f.store.confirmed()),
      failed = planFixtureEnvelope(source, '0.2.9');
    const failedPlan = freezeUpgradeChain(failed, source, [failed])[0].plan;
    const old = f.store.accept(
      'instance-administrator',
      {
        requestId: randomUUID(),
        targetReleaseId: failed.manifest.releaseId,
        targetDigest: failed.manifestDigest,
        expectedActivationGeneration: 1,
      },
      failed,
      failedPlan,
    );
    f.store.claim(old.attemptId, 'fixture-failed-controller', 30000);
    const snapshot = f.store.snapshot(old.attemptId);
    f.store.commit(old.attemptId, {
      fence: snapshot.fence,
      generation: snapshot.attempt.generation,
      expectedSequence: snapshot.attempt.sequence,
      eventId: randomUUID(),
      kind: 'failed',
      payload: { reason: 'controlled-older-failure' },
    });
    const facts = {
      schemaVersion: 1,
      qualified: true,
      partial: true,
      instanceId: f.store.instanceId,
      baseConfirmedReleaseId: source.releaseId,
      activationGeneration: 1,
      schema: source.schema,
      components: {
        ...source.components,
        installer: planFixtureArtifact('physically-measured-mixed-installer'),
      },
      observedAt: f.clock.now().toISOString(),
    };
    const actual = UpgradeSourceActualSchema.parse({ ...facts, proofDigest: upgradeDigest(facts) });
    vi.spyOn(f.inspector, 'sourceActual').mockResolvedValue(actual);
    const fixed = freezeUpgradeChain(
      f.chain[f.chain.length - 1].envelope,
      { ...source, schema: actual.schema, components: actual.components },
      f.chain.map((stage) => stage.envelope),
    );
    f.chain.splice(0, f.chain.length, ...fixed);
    await f.post().expect(202);
    f.preparation.resolve({ resources: [] });
    await f.service.advanceOperation();
    const accepted = assertDefined(f.store.latest());
    expect(accepted.state).toBe('accepted');
    expect(
      f.store.snapshot(accepted.attemptId).sourceActual?.components.installer.artifactDigest,
    ).toBe(actual.components.installer.artifactDigest);
    expect(f.store.plan(accepted.attemptId).sourceInstallerDigest).toBe(
      actual.components.installer.artifactDigest,
    );
  });
});
