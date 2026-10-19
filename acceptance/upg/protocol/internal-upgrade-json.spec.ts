import 'reflect-metadata';
import { randomUUID, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Body, Controller, Post, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ConfirmedServiceReleaseSchema,
  UpgradeManifestSchema,
  type SignedUpgradeManifest,
  type ProviderRegistry,
} from '@platform/contracts';
import { CLOCK, fromEpochMs } from '@platform/shared-kernel';
import { configurePlatformApp } from '../../../apps/api/src/bootstrap/configure-app';
import { INTERNAL_UPGRADE_JSON_LIMIT } from '../../../apps/api/src/bootstrap/internal-upgrade-json';
import { DeploymentState } from '../../../apps/api/src/platform/deployment/deployment-state';
import { PasscodeService } from '../../../apps/api/src/platform/access-passcode/passcode.service';
import { UpgradeSecurity } from '../../../apps/api/src/platform/access-passcode/upgrade-security.service';
import { UpgradeInternalController } from '../../../apps/api/src/platform/upgrade/upgrade.controller';
import { UpgradeService } from '../../../apps/api/src/platform/upgrade/upgrade-service';
import { UpgradeStore } from '../../../apps/api/src/platform/upgrade/upgrade-store';
import { CoordinatorHandoff } from '../../../apps/api/src/platform/upgrade/coordinator-handoff';
import { CoordinatorRecovery } from '../../../apps/api/src/platform/upgrade/coordinator-recovery';
import { UpgradeRoleHandoffs } from '../../../apps/api/src/platform/upgrade/upgrade-role-handoffs';
import { UpgradeObserver } from '../../../apps/api/src/platform/upgrade/upgrade-observer';
import { UpgradeOnlineMigration } from '../../../apps/api/src/platform/upgrade/upgrade-online-migration';
import {
  canonicalUpgrade,
  freezeUpgradePlan,
  upgradeDigest,
} from '../../../apps/api/src/platform/upgrade/upgrade-trust';
import { useEnv, stub, unused } from '../../support/strict-ports';
import { UpgradeInspector } from '../../../apps/api/src/platform/upgrade/upgrade-inspector';
import { UpgradeInspectionController } from '../../../apps/api/src/platform/upgrade/upgrade-inspection.controller';

const instanceId = 'internal-upgrade-json-protocol';
const key = 'synthetic-internal-upgrade-controller-key-32';
const clock = { now: () => fromEpochMs(Date.now()) };
const ids = { next: randomUUID };
let app: INestApplication, sqlite: Database.Database, store: UpgradeStore;
let directory: string, restore: () => void, attemptId: string, fence: number;

@Controller('public-body-fixture')
class PublicBodyFixture {
  @Post() read(@Body() body: unknown) {
    return body;
  }
}

beforeEach(async () => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), 'upg-private-json-http-')));
  restore = useEnv({
    PLATFORM_INSTANCE_ID: instanceId,
    PLATFORM_CONTROLLER_RPC_KEY: key,
    DATA_ROOT: directory,
    API_ALLOWED_ORIGINS: 'http://127.0.0.1',
  });
  sqlite = new Database(join(directory, 'platform.sqlite'));
  sqlite.pragma('journal_mode = WAL');
  migrate(drizzle(sqlite), { migrationsFolder: resolve('drizzle') });
  store = new UpgradeStore(sqlite, clock, ids);
  const component = {
    artifactDigest: upgradeDigest({ scope: 'http-transport-state-fixture' }),
    inputFingerprint: upgradeDigest({ scope: 'http-transport-state-input' }),
    sourceRevision: 'a'.repeat(40),
    protocol: { min: 1, max: 2 },
  };
  const components = {
    api: component,
    coordinator: component,
    installer: component,
    web: { ...component, webRevision: 'a'.repeat(40) },
  };
  const schema = (
    sqlite.prepare('SELECT count(*) n FROM __drizzle_migrations').get() as { n: number }
  ).n;
  const source = ConfirmedServiceReleaseSchema.parse({
    releaseId: '0.2.0',
    activationGeneration: 1,
    activatedAt: clock.now().toISOString(),
    schema,
    channel: 'transport-state-fixture',
    components,
    commits: { project: 'a'.repeat(40), api: 'a'.repeat(40), web: 'a'.repeat(40) },
    productionWebBinding: 'http://127.0.0.1/state-fixture',
  });
  store.bootstrap(source);
  const manifest = UpgradeManifestSchema.parse({
    schemaVersion: 2,
    releaseId: '0.2.1',
    channel: source.channel,
    publishedAt: clock.now().toISOString(),
    components,
    commits: source.commits,
    packages: [
      {
        platform: process.platform,
        arch: process.arch,
        name: 'state-fixture.tgz',
        url: 'https://distribution.invalid/state-fixture.tgz',
        digest: component.artifactDigest,
        bytes: 1,
        format: 'native-tar',
      },
    ],
    upgradePaths: [
      {
        fromRelease: source.releaseId,
        minSchema: schema,
        maxSchema: schema,
        targetSchema: schema,
        bridgeReleases: [],
        migrationPlanDigest: null,
      },
    ],
    policy: {
      id: 'transport-state-fixture',
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
          releaseId: source.releaseId,
          apiDigest: component.artifactDigest,
          webDigest: component.artifactDigest,
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
      keyId: 'transport-state-fixture',
      value: sign(null, Buffer.from(canonicalUpgrade(manifest)), keys.privateKey).toString(
        'base64',
      ),
    },
  };
  const accepted = store.accept(
    'explicit-state-fixture-actor',
    {
      requestId: randomUUID(),
      targetReleaseId: manifest.releaseId,
      targetDigest: envelope.manifestDigest,
      expectedActivationGeneration: 1,
    },
    envelope,
    freezeUpgradePlan(envelope, source),
  );
  attemptId = accepted.attemptId;
  fence = store.claim(attemptId, 'state-fixture-controller', 120000).fence;
  const passcodes = new PasscodeService(drizzle(sqlite));
  const security = new UpgradeSecurity(clock, ids, passcodes);
  const inspector = new UpgradeInspector(
    store,
    clock,
    stub<ProviderRegistry>({ list: () => [] }),
    new UpgradeOnlineMigration(store, clock),
    security,
    passcodes,
    unused('job receipts'),
    unused('sandbox exec'),
    unused('probe evidence'),
  );
  const service = new UpgradeService(store, undefined as never, security, inspector, clock);
  // Only the real commit/snapshot controller paths are exercised. There is no
  // SDK/health/activation double pretending to qualify a release or native task.
  const module = await Test.createTestingModule({
    controllers: [UpgradeInternalController, UpgradeInspectionController, PublicBodyFixture],
    providers: [
      DeploymentState,
      { provide: UpgradeService, useValue: service },
      { provide: UpgradeInspector, useValue: inspector },
      { provide: CLOCK, useValue: clock },
      ...[
        CoordinatorHandoff,
        UpgradeRoleHandoffs,
        UpgradeObserver,
        UpgradeOnlineMigration,
        CoordinatorRecovery,
      ].map((provide) => ({ provide, useValue: null })),
    ],
  }).compile();
  app = module.createNestApplication();
  configurePlatformApp(app);
  await app.listen(0, '127.0.0.1');
});
afterEach(async () => {
  await app?.close();
  sqlite?.close();
  restore?.();
  if (directory) rmSync(directory, { recursive: true, force: true });
});

function command(evidence: unknown) {
  return {
    fence,
    generation: store.attempt(attemptId).generation,
    expectedSequence: 0,
    eventId: randomUUID(),
    kind: 'progress',
    payload: {
      stepId: 'package-download',
      completedWork: 0,
      totalWork: 1,
      evidence,
      stage: 'downloading',
    },
  };
}
function post(body: Record<string, unknown>, auth = key, instance = instanceId) {
  return request(app.getHttpServer())
    .post('/internal/upgrades/' + attemptId + '/commit')
    .set('X-Platform-Internal-Key', auth)
    .set('X-Platform-Instance-Id', instance)
    .send(body);
}
function evidence() {
  // Synthetic opaque transport evidence, never represented as real continuity.
  return {
    source: 'transport-state-fixture',
    operations: Array.from({ length: 1800 }, (_, i) => ({
      id: 'fixture-operation-' + i,
      observedAt: '2026-10-12T00:00:00.000Z',
      state: 'complete',
      description: '完整 UTF-8 传输证据'.repeat(3),
    })),
  };
}
function history() {
  return {
    attempt: store.attempt(attemptId),
    events: sqlite.prepare('SELECT * FROM upgrade_events').all(),
    steps: sqlite.prepare('SELECT * FROM upgrade_steps').all(),
  };
}

describe('production private upgrade HTTP JSON boundary and committed SQLite receipts', () => {
  it('exposes only authenticated fixed inspection actions and reads metadata from the actual business DB', async () => {
    const inspect = (body: Record<string, unknown>, auth = key) =>
      request(app.getHttpServer())
        .post('/internal/upgrades/inspection')
        .set('X-Platform-Internal-Key', auth)
        .set('X-Platform-Instance-Id', instanceId)
        .send(body);
    const before = history();
    const found = await inspect({ action: 'metadata' }).expect(200);
    expect(found.body.instanceId).toBe(instanceId);
    expect(found.body.action).toBe('metadata');
    expect(found.body.result).toEqual({
      schema: (
        sqlite.prepare('SELECT count(*) AS n FROM __drizzle_migrations').get() as { n: number }
      ).n,
      requiredDataFormats: [],
      defaultImagesSnapshot: [],
      observedAt: found.body.startedAt,
    });
    expect(Date.parse(found.body.completedAt)).toBeGreaterThanOrEqual(
      Date.parse(found.body.startedAt),
    );
    await inspect({ action: 'metadata' }, 'wrong-key').expect(403);
    await inspect({ action: 'exec', command: 'forbidden' }).expect(400);
    await inspect({ action: 'metadata', method: 'capture' }).expect(400);
    await inspect({
      action: 'bootstrapProof',
      release: store.confirmed(),
      artifactRoot: '/etc',
    }).expect(400);
    await inspect({ action: 'controlIdentity', origin: 'https://outside.invalid' }).expect(400);
    expect(history()).toEqual(before);
  });

  it('negotiates the fast bridge and persists full evidence while returning bounded authenticated receipts', async () => {
    const capabilities = await request(app.getHttpServer())
      .get('/internal/upgrades/controller-capabilities')
      .set('X-Platform-Internal-Key', key)
      .set('X-Platform-Instance-Id', instanceId)
      .expect(200);
    expect(capabilities.body).toEqual({ controlFastPath: 1, progressEvidenceReference: 1 });
    const proof = evidence(),
      body = command(proof),
      prefix = '/internal/upgrades/' + attemptId;
    const compact = (path: string, value: Record<string, unknown>) =>
      request(app.getHttpServer())
        .post(prefix + path)
        .set('X-Platform-Internal-Key', key)
        .set('X-Platform-Instance-Id', instanceId)
        .send(value);
    const committed = await compact('/commit-receipt', body).expect(200);
    expect(Buffer.byteLength(JSON.stringify(committed.body))).toBeLessThan(1024);
    expect(committed.body).toMatchObject({
      eventId: body.eventId,
      eventDigest: upgradeDigest(body),
      eventSequence: 1,
      sequence: 1,
      fence,
    });
    const check = await compact('/authority-check', { fence, generation: body.generation }).expect(
      200,
    );
    expect(check.body).toMatchObject({
      attemptId,
      sequence: 1,
      planDigest: store.plan(attemptId).planDigest,
    });
    const renewed = await compact('/lease-renew', {
      fence,
      generation: body.generation,
      controllerId: 'state-fixture-controller',
    }).expect(200);
    expect(renewed.body.leaseExpiresAt).toBeGreaterThan(Date.now());
    const checkpoint = await request(app.getHttpServer())
      .get(prefix + '/progress-checkpoint')
      .query({ fence, generation: body.generation })
      .set('X-Platform-Internal-Key', key)
      .set('X-Platform-Instance-Id', instanceId)
      .expect(200);
    expect(checkpoint.body.step).toEqual({
      stepId: 'package-download',
      completedWork: 0,
      applied: false,
      receiptDigest: null,
      evidenceDigest: upgradeDigest(proof),
    });
    expect(Buffer.byteLength(JSON.stringify(checkpoint.body))).toBeLessThan(1024);
    const reference = {
      ...body,
      eventId: randomUUID(),
      expectedSequence: 1,
      payload: {
        stepId: 'package-download',
        completedWork: 0,
        totalWork: 1,
        stage: 'downloading',
        evidenceDigest: checkpoint.body.step.evidenceDigest,
      },
    };
    await compact('/commit-receipt', reference).expect(200);
    expect(store.step(attemptId, 'package-download').evidence).toEqual(proof);
    expect((await compact('/commit-receipt', body).expect(200)).body).toMatchObject({
      eventSequence: 1,
      sequence: 2,
    });
    const before = history();
    await compact('/lease-renew', {
      fence,
      generation: body.generation,
      controllerId: 'wrong-holder',
    }).expect(409);
    await compact('/authority-check', { fence: fence + 1 }).expect(409);
    await request(app.getHttpServer())
      .get(prefix + '/progress-checkpoint')
      .query({ fence, generation: body.generation })
      .expect(403);
    expect(history()).toEqual(before);
  });

  it('preserves evidence above the public default, durable event digest, exact replay and sequence', async () => {
    const proof = evidence(),
      body = command(proof);
    expect(Buffer.byteLength(JSON.stringify(body))).toBeGreaterThan(102400);
    await post(body).expect(200);
    const found = await request(app.getHttpServer())
      .get('/internal/upgrades/' + attemptId + '/steps/package-download')
      .set('X-Platform-Internal-Key', key)
      .set('X-Platform-Instance-Id', instanceId)
      .expect(200);
    expect(found.body.evidence).toEqual(proof);
    expect(upgradeDigest(found.body.evidence)).toBe(upgradeDigest(proof));
    expect(
      sqlite.prepare('SELECT event_digest FROM upgrade_events WHERE event_id=?').get(body.eventId),
    ).toEqual({ event_digest: upgradeDigest(body) });
    expect(store.attempt(attemptId).sequence).toBe(1);
    const once = history();
    await post(body).expect(200);
    expect(history()).toEqual(once);
    const changed = { ...body, payload: { ...body.payload, evidence: { changed: true } } };
    await post(changed).expect(409);
    expect(history()).toEqual(once);
    const applied = {
      ...body,
      expectedSequence: 1,
      eventId: randomUUID(),
      kind: 'step-applied',
      payload: { ...body.payload, completedWork: 1, receiptDigest: upgradeDigest(proof) },
    };
    await post(applied).expect(200);
    const receipt = await request(app.getHttpServer())
      .get('/internal/upgrades/' + attemptId + '/steps/package-download')
      .set('X-Platform-Internal-Key', key)
      .set('X-Platform-Instance-Id', instanceId)
      .expect(200);
    expect(receipt.body).toMatchObject({
      applied: true,
      completedWork: 1,
      receiptDigest: upgradeDigest(proof),
      evidence: proof,
    });
    expect(store.attempt(attemptId).sequence).toBe(2);
  });
  it('rejects a private UTF-8 body above 24 MiB with 413 and no state commit', async () => {
    const body = command({ description: '界'.repeat(9 * 1024 * 1024) });
    expect(Buffer.byteLength(JSON.stringify(body))).toBeGreaterThan(INTERNAL_UPGRADE_JSON_LIMIT);
    const before = history();
    const denied = await post(body).expect(413);
    expect(denied.body.code).not.toBe('INTERNAL');
    expect(history()).toEqual(before);
  });
  it('keeps the public parser default and parses ordinary public bodies', async () => {
    await request(app.getHttpServer())
      .post('/api/public-body-fixture')
      .send({ actual: 7 })
      .expect(201, { actual: 7 });
    const before = history();
    // Existing public parser errors remain unchanged; this test forbids raising
    // its limit or accidentally suppressing Nest's default parser altogether.
    const denied = await request(app.getHttpServer())
      .post('/api/public-body-fixture')
      .send({ value: 'a'.repeat(103000) });
    expect(denied.status).toBeGreaterThanOrEqual(400);
    expect(history()).toEqual(before);
  });
  it.each([
    ['wrong controller key', 'incorrect-controller-key', instanceId],
    ['wrong instance', key, 'other-instance'],
  ])('rejects %s despite a legitimate large private body', async (_name, auth, instance) => {
    const before = history();
    const denied = await post(command(evidence()), auth, instance).expect(403);
    expect(denied.body.code).toBe(
      instance === instanceId ? 'UPGRADE_INTERNAL_AUTH' : 'UPGRADE_INSTANCE_MISMATCH',
    );
    expect(history()).toEqual(before);
  });
});
