import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Body, Controller, Get, Post, Req, Res, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LegacyUpgradeSecurity } from '../../support/legacy-upgrade-security';
import { requireUpgrade } from '../../../apps/api/src/platform/upgrade/upgrade-trust';
import { UpgradePlanSchema } from '@platform/contracts';
import { fromEpochMs } from '@platform/shared-kernel';
import { configurePlatformApp } from '../../../apps/api/src/bootstrap/configure-app';
import { DeploymentState } from '../../../apps/api/src/platform/deployment/deployment-state';
import { PasscodeGuard } from '../../../apps/api/src/platform/access-passcode/passcode.guard';
import { PasscodeService } from '../../../apps/api/src/platform/access-passcode/passcode.service';
import { PasscodeAttemptLimiter } from '../../../apps/api/src/platform/access-passcode/passcode-attempt-limiter';
import { UpgradeSecurity } from '../../../apps/api/src/platform/access-passcode/upgrade-security.service';
import { SESSION_COOKIE } from '../../../apps/api/src/platform/access-passcode/session-cookie';
import { UpgradeController } from '../../../apps/api/src/platform/upgrade/upgrade.controller';
import { UpgradeInspector } from '../../../apps/api/src/platform/upgrade/upgrade-inspector';
import { UpgradeService } from '../../../apps/api/src/platform/upgrade/upgrade-service';
import { UpgradeStore } from '../../../apps/api/src/platform/upgrade/upgrade-store';
import { upgradeDigest } from '../../../apps/api/src/platform/upgrade/upgrade-trust';
import { currentDatabase } from '../../support/sqlite';
import { useEnv } from '../../support/strict-ports';

type HttpRequest = Parameters<UpgradeSecurity['principal']>[0];
type HttpResponse = Parameters<UpgradeSecurity['principal']>[1];
const instanceId = 'auth-continuity-lookup-protocol';
const publicOrigin = 'http://127.0.0.1:49213';
const upgradeKey = 'synthetic-legacy-upgrade-key-32-characters';
const sessionSecret = 'synthetic-upgrade-session-secret-32';
const passcodeSecret = 'synthetic-passcode-session-secret-32';
const clock = { now: () => fromEpochMs(Date.now()) };
const ids = { next: randomUUID };
const digest = upgradeDigest({ scope: 'authorization-state-fixture-only' });
let restore: () => void, db: ReturnType<typeof currentDatabase>, store: UpgradeStore;
let sourceSecurity: UpgradeSecurity, sourcePasscodes: PasscodeService, inspector: UpgradeInspector;
let attemptId: string, requestId: string;
let app: INestApplication;
const applications: INestApplication[] = [];

@Controller('fixture-auth')
class AccessFixture {
  constructor(private readonly security: UpgradeSecurity) {}
  @Get() viewer(@Req() req: HttpRequest, @Res({ passthrough: true }) res: HttpResponse) {
    return this.security.principal(req, res, instanceId);
  }
  @Post() grant(
    @Req() req: HttpRequest,
    @Res({ passthrough: true }) res: HttpResponse,
    @Body() body: { upgradeKey: string },
  ) {
    return this.security.grant(req, res, instanceId, body.upgradeKey);
  }
}
@Controller('system/upgrade')
class LegacyLookupController {
  constructor(private readonly security: LegacyUpgradeSecurity) {}
  @Get('requests/:requestId') lookup(
    @Req() req: HttpRequest,
    @Res({ passthrough: true }) res: HttpResponse,
  ) {
    const principal = this.security.principal(req, res, instanceId);
    requireUpgrade(principal.canUpgrade, 'UPGRADE_PERMISSION_REQUIRED', 403);
    // Exactly the previous lookup behavior: real old grant parser, no scope header.
    return store.lookup(principal.actorId, String(req.params.requestId));
  }
}
async function startLegacyTarget() {
  const security = new LegacyUpgradeSecurity(clock, ids);
  const passcodes = new PasscodeService(db.db);
  const module = await Test.createTestingModule({
    controllers: [LegacyLookupController],
    providers: [DeploymentState, { provide: LegacyUpgradeSecurity, useValue: security }],
  }).compile();
  const target = module.createNestApplication();
  target.useGlobalGuards(new PasscodeGuard(passcodes, new PasscodeAttemptLimiter()));
  configurePlatformApp(target, { allowedOrigins: [publicOrigin], trustProxy: 'none' });
  await target.listen(0, '127.0.0.1');
  applications.push(target);
  return target;
}
function useLegacyBaseline() {
  const legacy = new LegacyUpgradeSecurity(clock, ids);
  db.sqlite.prepare('UPDATE upgrade_continuity_baselines SET snapshot=? WHERE attempt_id=?').run(
    JSON.stringify({
      authContinuityFingerprint: upgradeDigest({
        upgrade: legacy.continuityFingerprint(instanceId),
        access: sourcePasscodes.issueSessionToken(0),
      }),
    }),
    attemptId,
  );
  return legacy;
}
async function startTarget(upgradeSecret = sessionSecret) {
  const reset = useEnv({ UPGRADE_SESSION_SECRET: upgradeSecret });
  const passcodes = new PasscodeService(db.db),
    security = new UpgradeSecurity(clock, ids, passcodes);
  // UpgradeSecurity captures its signing secret per constructed role. The
  // ordinary PasscodeService intentionally reads its ENV key dynamically.
  reset();
  // The real readonly application path has no Catalog, Web or SDK dependencies
  // here. No boundary is mocked as healthy or represented as native proof.
  const service = new UpgradeService(
    store,
    undefined as never,
    security,
    undefined as never,
    clock,
  );
  const module = await Test.createTestingModule({
    controllers: [UpgradeController, AccessFixture],
    providers: [
      DeploymentState,
      { provide: UpgradeService, useValue: service },
      { provide: UpgradeSecurity, useValue: security },
    ],
  }).compile();
  const target = module.createNestApplication();
  target.useGlobalGuards(new PasscodeGuard(passcodes, new PasscodeAttemptLimiter()));
  configurePlatformApp(target, { allowedOrigins: [publicOrigin], trustProxy: 'none' });
  await target.listen(0, '127.0.0.1');
  applications.push(target);
  return target;
}
beforeEach(async () => {
  restore = useEnv({
    PLATFORM_INSTANCE_ID: instanceId,
    UPGRADE_SESSION_SECRET: sessionSecret,
    UPGRADE_ADMIN_KEY: undefined,
    UPGRADE_LEGACY_AUTH_CONTINUITY_KEY: undefined,
    PASSCODE_COOKIE_SECRET: passcodeSecret,
    ACCESS_PASSCODE: 'ordinary-shared-access-passcode',
    ACCESS_PASSCODE_AUTO_GENERATE: 'false',
    ACCESS_PASSCODE_ALLOW_LOOPBACK: 'false',
    API_ALLOWED_ORIGINS: publicOrigin,
  });
  db = currentDatabase();
  store = new UpgradeStore(db.sqlite, clock, ids);
  sourcePasscodes = new PasscodeService(db.db);
  sourceSecurity = new UpgradeSecurity(clock, ids, sourcePasscodes);
  attemptId = randomUUID();
  requestId = randomUUID();
  // State-only accepted-request metadata: the test proves authentication and
  // readonly identity lookup, not manifest admission or a qualified installation.
  const plan = UpgradePlanSchema.parse({
    schemaVersion: 1,
    releaseId: '0.2.1',
    manifestDigest: digest,
    package: {
      platform: process.platform,
      arch: process.arch,
      name: 'auth-state-only',
      url: 'https://distribution.invalid/fixture.tar',
      digest,
      bytes: 1,
      format: 'native-tar',
    },
    migrationPath: {
      fromRelease: '0.2.0',
      minSchema: 28,
      maxSchema: 28,
      targetSchema: 28,
      bridgeReleases: [],
      migrationPlanDigest: null,
    },
    apiReused: true,
    webReused: true,
    coordinatorReused: true,
    ownerReused: true,
    installerReused: true,
    sourceCoordinatorDigest: digest,
    sourceOwnerDigest: null,
    sourceInstallerDigest: digest,
    sourceInstallerInputFingerprint: digest,
    sourceActivationGeneration: 1,
    sourceApiDigest: digest,
    sourceWebDigest: digest,
    planDigest: digest,
    steps: [{ stepId: 'activation', kind: 'activation', totalWork: 1 }],
    policy: {
      id: 'authentication-only',
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
      maxWalBytes: 1000000,
      minFreeBytes: 1000000,
      fallbacks: [{ releaseId: '0.2.0', apiDigest: digest, webDigest: digest, rehearsed: false }],
      stopUserResources: false,
      restoreLiveVolume: false,
      contractInUpgrade: false,
    },
  });
  const now = clock.now().getTime();
  db.sqlite
    .prepare(
      'INSERT INTO upgrade_attempts(attempt_id,instance_id,actor_id,request_id,request_digest,target_release_id,target_digest,manifest,plan,source_activation,generation,fence,lease_expires_at,accepted_at,observed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    )
    .run(
      attemptId,
      instanceId,
      'instance-administrator',
      requestId,
      digest,
      '0.2.1',
      digest,
      '{}',
      JSON.stringify(plan),
      '{}',
      1,
      1,
      now + 60000,
      now,
      now,
    );
  inspector = new UpgradeInspector(
    store,
    clock,
    undefined as never,
    undefined as never,
    sourceSecurity,
    sourcePasscodes,
    undefined as never,
    undefined as never,
    undefined as never,
  );
  inspector.recordBaseline(attemptId, {
    authContinuityFingerprint: upgradeDigest({
      upgrade: sourceSecurity.continuityFingerprint(instanceId),
      access: sourcePasscodes.issueSessionToken(0),
    }),
  });
  app = await startTarget();
});
afterEach(async () => {
  await Promise.all(applications.splice(0).map((target) => target.close()));
  expect(db.sqlite.prepare('SELECT count(*) n FROM upgrade_events').get()).toEqual({ n: 0 });
  expect(db.sqlite.prepare('SELECT count(*) n FROM upgrade_attempts').get()).toEqual({ n: 1 });
  db.sqlite.close();
  restore();
});
function cookies(r: { headers: Record<string, unknown> }) {
  return (r.headers['set-cookie'] as string[]).map((value) => value.split(';')[0]).join('; ');
}
function accessCookie() {
  return `${SESSION_COOKIE}=${sourcePasscodes.issueSessionToken(clock.now().getTime())}`;
}

describe('actual readonly authentication continuity through original authorized request lookup', () => {
  it('validates the original authenticated actor with an automatic viewer and no separate upgrade grant', async () => {
    const v = await request(app.getHttpServer())
      .get('/api/fixture-auth')
      .set('Cookie', accessCookie())
      .expect(200);
    const viewerCookie = accessCookie() + '; ' + cookies(v);
    expect(v.body.canUpgrade).toBe(true);
    const found = await request(app.getHttpServer())
      .get('/api/system/upgrade/requests/' + requestId)
      .set('Cookie', viewerCookie + '; ap_upgrade_grant=obsolete-or-forged')
      .expect(200);
    expect(found.body.attemptId).toBe(attemptId);
    expect(found.headers['x-upgrade-user-scope']).toBe(v.body.userScope);
    // A fresh automatic viewer and an actual signed access cookie must both survive candidate parsing.
    expect(await inspector.authenticationContinuity(attemptId, 1, await app.getUrl())).toBe(true);
    expect(await inspector.authenticationContinuity(attemptId, 1, await app.getUrl())).toBe(true);
  });
  it('rejects a target with a different upgrade-session HMAC key', async () => {
    const target = await startTarget('synthetic-other-upgrade-session-secret-32');
    const challenge = sourceSecurity.continuityChallenge(instanceId);
    await request(target.getHttpServer())
      .get('/api/system/upgrade/requests/' + requestId)
      .set('Cookie', accessCookie() + '; ' + challenge.cookie)
      .expect(200);
    expect(await inspector.authenticationContinuity(attemptId, 1, await target.getUrl())).toBe(
      false,
    );
  });
  it('rejects an ordinary access-session rotation through the real guard and the continuity baseline', async () => {
    const challenge = sourceSecurity.continuityChallenge(instanceId);
    const signedBeforeRotation = accessCookie() + '; ' + challenge.cookie;
    const reset = useEnv({ PASSCODE_COOKIE_SECRET: 'synthetic-other-access-session-secret-32' });
    try {
      await request(app.getHttpServer())
        .get('/api/system/upgrade/requests/' + requestId)
        .set('Cookie', signedBeforeRotation)
        .expect(401);
      expect(await inspector.authenticationContinuity(attemptId, 1, await app.getUrl())).toBe(
        false,
      );
    } finally {
      reset();
    }
  });
  it('accepts old Coordinator cookies at the new API and preserves the old request actor', async () => {
    const reset = useEnv({ UPGRADE_ADMIN_KEY: upgradeKey });
    try {
      const legacy = useLegacyBaseline();
      const challenge = legacy.continuityChallenge(instanceId);
      await request(app.getHttpServer())
        .get('/api/system/upgrade/requests/' + requestId)
        .set('Cookie', challenge.cookie)
        .expect(401);
      const found = await request(app.getHttpServer())
        .get('/api/system/upgrade/requests/' + requestId)
        .set('Cookie', accessCookie() + '; ' + challenge.cookie)
        .expect(200);
      expect(found.body.attemptId).toBe(attemptId);
      expect(found.headers['x-upgrade-user-scope']).toBe(challenge.userScope);
      expect(await inspector.authenticationContinuity(attemptId, 1, await app.getUrl())).toBe(true);
    } finally {
      reset();
    }
  });
  it('checks an already sealed legacy baseline against the actual old API access and grant parsers', async () => {
    const reset = useEnv({ UPGRADE_ADMIN_KEY: upgradeKey });
    try {
      useLegacyBaseline();
      const target = await startLegacyTarget();
      expect(await inspector.authenticationContinuity(attemptId, 1, await target.getUrl())).toBe(
        true,
      );
      // Even an existing legacy key cannot excuse a missing scope for a newly captured baseline.
      db.sqlite
        .prepare('UPDATE upgrade_continuity_baselines SET snapshot=? WHERE attempt_id=?')
        .run(
          JSON.stringify({
            authContinuityFingerprint: upgradeDigest({
              upgrade: sourceSecurity.continuityFingerprint(instanceId),
              access: sourcePasscodes.issueSessionToken(0),
            }),
          }),
          attemptId,
        );
      expect(await inspector.authenticationContinuity(attemptId, 1, await target.getUrl())).toBe(
        false,
      );
    } finally {
      reset();
    }
  });
  it('does not accept a legacy API after access/viewer/key rotation and supports the optional renamed legacy key', async () => {
    const reset = useEnv({ UPGRADE_ADMIN_KEY: upgradeKey });
    try {
      useLegacyBaseline();
      const target = await startLegacyTarget();
      const renamed = useEnv({
        UPGRADE_LEGACY_AUTH_CONTINUITY_KEY: upgradeKey,
        UPGRADE_ADMIN_KEY: upgradeKey,
      });
      try {
        expect(await inspector.authenticationContinuity(attemptId, 1, await target.getUrl())).toBe(
          true,
        );
        process.env.UPGRADE_LEGACY_AUTH_CONTINUITY_KEY = 'wrong-legacy-key-at-least-32-characters';
        expect(await inspector.authenticationContinuity(attemptId, 1, await target.getUrl())).toBe(
          false,
        );
        process.env.UPGRADE_LEGACY_AUTH_CONTINUITY_KEY = upgradeKey;
        process.env.PASSCODE_COOKIE_SECRET = 'changed-access-session-signing-secret-32';
        expect(await inspector.authenticationContinuity(attemptId, 1, await target.getUrl())).toBe(
          false,
        );
      } finally {
        renamed();
      }
    } finally {
      reset();
    }
  });
});
