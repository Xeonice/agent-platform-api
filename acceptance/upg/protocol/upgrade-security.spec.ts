import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Body, Controller, Get, Post, Req, Res, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { configurePlatformApp } from '../../../apps/api/src/bootstrap/configure-app';
import { DeploymentState } from '../../../apps/api/src/platform/deployment/deployment-state';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AUDIT_RECORDER } from '@platform/contracts';
import { CLOCK, ID_GENERATOR, fromEpochMs } from '@platform/shared-kernel';
import { PasscodeService } from '../../../apps/api/src/platform/access-passcode/passcode.service';
import { PasscodeGuard } from '../../../apps/api/src/platform/access-passcode/passcode.guard';
import { PasscodeAttemptLimiter } from '../../../apps/api/src/platform/access-passcode/passcode-attempt-limiter';
import { AccessController } from '../../../apps/api/src/platform/access-passcode/access.controller';
import { currentDatabase } from '../../support/sqlite';
import { UpgradeSecurity } from '../../../apps/api/src/platform/access-passcode/upgrade-security.service';
import { useEnv } from '../../support/strict-ports';

type Request = Parameters<UpgradeSecurity['principal']>[0];
type Response = Parameters<UpgradeSecurity['principal']>[1];
const instance = 'upgrade-auth-protocol-instance';
const origin = 'http://127.0.0.1:44291';
const passcode = 'ordinary-shared-access-passcode';
const internalKey = 'synthetic-controller-key-at-least-32-characters';
let clock = Date.now();
let effects = 0;
@Controller('security-boundary')
class SecurityBoundary {
  constructor(private readonly security: UpgradeSecurity) {}
  @Get('status') status(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.security.principal(req, res, instance);
  }
  @Post('access') access(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() body: { upgradeKey: string },
  ) {
    return this.security.grant(req, res, instance, body.upgradeKey);
  }
  @Post('intent') intent(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const actor = this.security.principal(req, res, instance);
    this.security.mutation(req, actor);
    effects++;
    return { actorId: actor.actorId, effects };
  }
  @Post('internal') internal(@Req() req: Request) {
    this.security.internal(req, instance);
    return { verified: true };
  }
}
let app: INestApplication;
let restore: () => void;
let database: ReturnType<typeof currentDatabase>;
let passcodes: PasscodeService;
beforeEach(async () => {
  effects = 0;
  clock = Date.now();
  restore = useEnv({
    UPGRADE_SESSION_SECRET: 'synthetic-fixed-session-secret-at-least-32',
    UPGRADE_ADMIN_KEY: undefined,
    PASSCODE_COOKIE_SECRET: 'synthetic-existing-access-session-secret-32',
    ACCESS_PASSCODE_ALLOW_LOOPBACK: 'false',
    PLATFORM_CONTROLLER_RPC_KEY: internalKey,
    API_ALLOWED_ORIGINS: origin,
    ACCESS_PASSCODE: passcode,
  });
  database = currentDatabase();
  passcodes = new PasscodeService(database.db);
  await startApp();
});
async function startApp() {
  const limiter = new PasscodeAttemptLimiter();
  const module = await Test.createTestingModule({
    controllers: [SecurityBoundary, AccessController],
    providers: [
      UpgradeSecurity,
      DeploymentState,
      { provide: PasscodeService, useValue: passcodes },
      { provide: PasscodeAttemptLimiter, useValue: limiter },
      { provide: AUDIT_RECORDER, useValue: { record: () => undefined } },
      { provide: CLOCK, useValue: { now: () => fromEpochMs(clock) } },
      { provide: ID_GENERATOR, useValue: { next: () => randomUUID() } },
    ],
  }).compile();
  app = module.createNestApplication();
  app.useGlobalGuards(new PasscodeGuard(passcodes, limiter));
  configurePlatformApp(app, { allowedOrigins: [origin], trustProxy: 'none' });
  // Hold one actual listener for the entire scenario. Supertest's per-request
  // temporary server lifecycle can recycle an ephemeral port into a concurrent
  // real application while the previous HTTP agent still has a socket cached.
  await app.listen(0, '127.0.0.1');
}
afterEach(async () => {
  await app.close();
  database.sqlite.close();
  restore();
});
function cookie(response: { headers: Record<string, unknown> }): string {
  return ((response.headers['set-cookie'] ?? []) as string[])
    .map((v) => v.split(';')[0])
    .join('; ');
}
async function unlock() {
  // Actual AccessController route/guard exemption uses the production /api path.
  const response = await request(app.getHttpServer())
    .post('/api/access/unlock')
    .send({ passcode })
    .expect(200);
  return cookie(response);
}
async function viewer() {
  const session = await unlock();
  const status = await request(app.getHttpServer())
    .get('/api/security-boundary/status')
    .set('Cookie', session)
    .expect(200);
  return {
    cookie: session + '; ' + cookie(status),
    csrf: status.body.csrfToken,
    scope: status.body.userScope,
  };
}

describe('REQ-UPG-005/009 — existing instance access, Origin and CSRF boundary over real HTTP/SQLite', () => {
  it('authorizes an unlocked instance immediately without a separate key or grant cookie', async () => {
    const v = await viewer();
    const before = await request(app.getHttpServer())
      .get('/api/security-boundary/status')
      .set('Cookie', v.cookie)
      .expect(200);
    expect(before.body).toMatchObject({
      canUpgrade: true,
      actorId: 'instance-administrator',
      userScope: v.scope,
    });
    const result = await request(app.getHttpServer())
      .post('/api/security-boundary/intent')
      .set('Origin', origin)
      .set('Cookie', v.cookie)
      .set('X-Upgrade-CSRF', v.csrf)
      .expect(201);
    expect(result.body).toEqual({ actorId: 'instance-administrator', effects: 1 });
    // The compatibility endpoint accepts no secret and never sets a grant cookie.
    const compatible = await request(app.getHttpServer())
      .post('/api/security-boundary/access')
      .set('Origin', origin)
      .set('Cookie', v.cookie)
      .set('X-Upgrade-CSRF', v.csrf)
      .send({})
      .expect(201);
    expect(compatible.body).toMatchObject({ canUpgrade: true, userScope: v.scope });
    expect(cookie(compatible)).not.toContain('ap_upgrade_grant');
  });
  it('rejects anonymous and forged access/viewer/grant cookies before any mutation', async () => {
    const v = await viewer();
    for (const forged of [
      '',
      'ap_session=ordinary-shared-access-passcode',
      'ap_session=%malformed',
      'ap_session=forged; ap_upgrade_viewer=forged; ap_upgrade_grant=forged',
    ]) {
      let status = request(app.getHttpServer()).get('/api/security-boundary/status');
      let intent = request(app.getHttpServer())
        .post('/api/security-boundary/intent')
        .set('Origin', origin)
        .set('X-Upgrade-CSRF', v.csrf);
      if (forged) {
        status = status.set('Cookie', forged);
        intent = intent.set('Cookie', forged);
      }
      await status.expect(401);
      await intent.expect(401);
    }
    expect(effects).toBe(0);
  });
  it('rejects cross origin, missing Origin, wrong or another viewer CSRF before any effect', async () => {
    const first = await viewer(),
      second = await viewer(),
      authorized = first.cookie;
    expect(first.scope).not.toBe(second.scope);
    const forged = await request(app.getHttpServer())
      .post('/api/security-boundary/intent')
      .set('Origin', 'https://evil.invalid')
      .set('Cookie', authorized)
      .set('X-Upgrade-CSRF', first.csrf)
      .expect(403);
    expect(forged.body.code).toBe('FORBIDDEN'); // The production CORS boundary rejects it first.
    await request(app.getHttpServer())
      .post('/api/security-boundary/intent')
      .set('Cookie', authorized)
      .set('X-Upgrade-CSRF', first.csrf)
      .expect(403);
    const csrf = await request(app.getHttpServer())
      .post('/api/security-boundary/intent')
      .set('Origin', origin)
      .set('Cookie', authorized)
      .set('X-Upgrade-CSRF', second.csrf)
      .expect(403);
    expect(csrf.body.code).toBe('UPGRADE_CSRF_INVALID');
    expect(effects).toBe(0);
  });
  it('preserves access/viewer identity across restart and ignores obsolete grant/key state', async () => {
    const v = await viewer();
    await app.close();
    await startApp();
    process.env.UPGRADE_ADMIN_KEY = 'obsolete-key-change-does-not-affect-instance-access';
    const same = await request(app.getHttpServer())
      .get('/api/security-boundary/status')
      .set('Cookie', v.cookie + '; ap_upgrade_grant=obsolete-or-forged')
      .expect(200);
    expect(same.body).toMatchObject({
      canUpgrade: true,
      actorId: 'instance-administrator',
      userScope: v.scope,
      csrfToken: v.csrf,
    });
    const reset = useEnv({ PASSCODE_COOKIE_SECRET: 'rotated-existing-access-session-secret-32' });
    try {
      await request(app.getHttpServer())
        .get('/api/security-boundary/status')
        .set('Cookie', v.cookie)
        .expect(401);
    } finally {
      reset();
    }
    expect(effects).toBe(0);
  });
  it('follows the existing policy when instance access protection is deliberately disabled', async () => {
    await app.close();
    const reset = useEnv({ ACCESS_PASSCODE: '', ACCESS_PASSCODE_AUTO_GENERATE: 'false' });
    try {
      passcodes = new PasscodeService(database.db);
      expect(passcodes.enabled).toBe(false);
      await startApp();
      const status = await request(app.getHttpServer())
        .get('/api/security-boundary/status')
        .expect(200);
      expect(status.body.canUpgrade).toBe(true);
      const result = await request(app.getHttpServer())
        .post('/api/security-boundary/intent')
        .set('Origin', origin)
        .set('Cookie', cookie(status))
        .set('X-Upgrade-CSRF', status.body.csrfToken)
        .expect(201);
      expect(result.body).toEqual({ actorId: 'instance-administrator', effects: 1 });
    } finally {
      reset();
    }
  });
  it('requires the loopback controller key and exact instance on the real HTTP private surface', async () => {
    await request(app.getHttpServer())
      .post('/api/security-boundary/internal')
      .set('X-Access-Passcode', passcode)
      .expect(403);
    await request(app.getHttpServer())
      .post('/api/security-boundary/internal')
      .set('X-Access-Passcode', passcode)
      .set('x-platform-internal-key', internalKey)
      .set('x-platform-instance-id', 'other-instance')
      .expect(403);
    const valid = await request(app.getHttpServer())
      .post('/api/security-boundary/internal')
      .set('X-Access-Passcode', passcode)
      .set('x-platform-internal-key', internalKey)
      .set('x-platform-instance-id', instance)
      .expect(201);
    expect(valid.body).toEqual({ verified: true });
  });
});
