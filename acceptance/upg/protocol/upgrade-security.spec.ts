import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Body, Controller, Get, Post, Req, Res, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CLOCK, ID_GENERATOR, fromEpochMs } from '@platform/shared-kernel';
import { UpgradeSecurity } from '../../../apps/api/src/platform/access-passcode/upgrade-security.service';
import { useEnv } from '../../support/strict-ports';

type Request = Parameters<UpgradeSecurity['principal']>[0];
type Response = Parameters<UpgradeSecurity['principal']>[1];
const instance = 'upgrade-auth-protocol-instance';
const origin = 'http://127.0.0.1:44291';
const operatorKey = 'synthetic-independent-operator-key-at-least-32';
const internalKey = 'synthetic-controller-key-at-least-32-characters';
let clock = Date.parse('2026-10-12T02:00:00.000Z');
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
beforeEach(async () => {
  effects = 0;
  clock = Date.parse('2026-10-12T02:00:00.000Z');
  restore = useEnv({
    UPGRADE_SESSION_SECRET: 'synthetic-fixed-session-secret-at-least-32',
    UPGRADE_ADMIN_KEY: operatorKey,
    PLATFORM_CONTROLLER_RPC_KEY: internalKey,
    API_ALLOWED_ORIGINS: origin,
    ACCESS_PASSCODE: 'ordinary-shared-access-passcode',
  });
  const module = await Test.createTestingModule({
    controllers: [SecurityBoundary],
    providers: [
      UpgradeSecurity,
      { provide: CLOCK, useValue: { now: () => fromEpochMs(clock) } },
      { provide: ID_GENERATOR, useValue: { next: () => randomUUID() } },
    ],
  }).compile();
  app = module.createNestApplication();
  // Hold one actual listener for the entire scenario. Supertest's per-request
  // temporary server lifecycle can recycle an ephemeral port into a concurrent
  // real application while the previous HTTP agent still has a socket cached.
  await app.listen(0, '127.0.0.1');
});
afterEach(async () => {
  await app.close();
  restore();
});
function cookie(response: { headers: Record<string, unknown> }): string {
  return (response.headers['set-cookie'] as string[]).map((v) => v.split(';')[0]).join('; ');
}
async function viewer() {
  const status = await request(app.getHttpServer()).get('/security-boundary/status').expect(200);
  return { cookie: cookie(status), csrf: status.body.csrfToken, scope: status.body.userScope };
}
async function grant(v: Awaited<ReturnType<typeof viewer>>) {
  const result = await request(app.getHttpServer())
    .post('/security-boundary/access')
    .set('Origin', origin)
    .set('Cookie', v.cookie)
    .set('X-Upgrade-CSRF', v.csrf)
    .send({ upgradeKey: operatorKey })
    .expect(201);
  return v.cookie + '; ' + cookie(result);
}

describe('REQ-UPG-005/009 — real HTTP installation capability, Origin and CSRF boundary', () => {
  it('ordinary access credentials never grant installation rights, while an explicit independent grant allows a command', async () => {
    const v = await viewer();
    const denied = await request(app.getHttpServer())
      .post('/security-boundary/intent')
      .set('Origin', origin)
      .set('Cookie', v.cookie + '; ap_session=ordinary-shared-access-passcode')
      .set('X-Upgrade-CSRF', v.csrf)
      .expect(403);
    expect(denied.body.code).toBe('UPGRADE_PERMISSION_REQUIRED');
    await request(app.getHttpServer())
      .post('/security-boundary/access')
      .set('Origin', origin)
      .set('Cookie', v.cookie)
      .set('X-Upgrade-CSRF', v.csrf)
      .send({ upgradeKey: 'ordinary-shared-access-passcode' })
      .expect(403);
    expect(effects).toBe(0);
    const authorized = await grant(v);
    const result = await request(app.getHttpServer())
      .post('/security-boundary/intent')
      .set('Origin', origin)
      .set('Cookie', authorized)
      .set('X-Upgrade-CSRF', v.csrf)
      .expect(201);
    expect(result.body).toEqual({ actorId: 'instance-administrator', effects: 1 });
  });
  it('rejects cross origin, missing Origin, wrong or another viewer CSRF before any effect', async () => {
    const first = await viewer(),
      second = await viewer(),
      authorized = await grant(first);
    expect(first.scope).not.toBe(second.scope);
    const forged = await request(app.getHttpServer())
      .post('/security-boundary/intent')
      .set('Origin', 'https://evil.invalid')
      .set('Cookie', authorized)
      .set('X-Upgrade-CSRF', first.csrf)
      .expect(403);
    expect(forged.body.code).toBe('UPGRADE_ORIGIN_INVALID');
    await request(app.getHttpServer())
      .post('/security-boundary/intent')
      .set('Cookie', authorized)
      .set('X-Upgrade-CSRF', first.csrf)
      .expect(403);
    const csrf = await request(app.getHttpServer())
      .post('/security-boundary/intent')
      .set('Origin', origin)
      .set('Cookie', authorized)
      .set('X-Upgrade-CSRF', second.csrf)
      .expect(403);
    expect(csrf.body.code).toBe('UPGRADE_CSRF_INVALID');
    expect(effects).toBe(0);
  });
  it('keeps signed grants usable across a new service object but revokes expiry and independent key rotation', async () => {
    const v = await viewer(),
      authorized = await grant(v);
    await app.close();
    const module = await Test.createTestingModule({
      controllers: [SecurityBoundary],
      providers: [
        UpgradeSecurity,
        { provide: CLOCK, useValue: { now: () => fromEpochMs(clock) } },
        { provide: ID_GENERATOR, useValue: { next: () => randomUUID() } },
      ],
    }).compile();
    app = module.createNestApplication();
    // Hold one actual listener for the entire scenario. Supertest's per-request
    // temporary server lifecycle can recycle an ephemeral port into a concurrent
    // real application while the previous HTTP agent still has a socket cached.
    await app.listen(0, '127.0.0.1');
    const same = await request(app.getHttpServer())
      .get('/security-boundary/status')
      .set('Cookie', authorized)
      .expect(200);
    expect(same.body).toMatchObject({ canUpgrade: true, userScope: v.scope, csrfToken: v.csrf });
    process.env.UPGRADE_ADMIN_KEY = 'synthetic-rotated-independent-operator-key';
    const rotated = await request(app.getHttpServer())
      .get('/security-boundary/status')
      .set('Cookie', authorized)
      .expect(200);
    expect(rotated.body.canUpgrade).toBe(false);
    process.env.UPGRADE_ADMIN_KEY = operatorKey;
    clock += 8 * 24 * 60 * 60 * 1000;
    const expired = await request(app.getHttpServer())
      .get('/security-boundary/status')
      .set('Cookie', authorized)
      .expect(200);
    expect(expired.body.canUpgrade).toBe(false);
    expect(expired.body.userScope).not.toBe(v.scope);
    expect(effects).toBe(0);
  });
  it('requires the loopback controller key and exact instance on the real HTTP private surface', async () => {
    await request(app.getHttpServer()).post('/security-boundary/internal').expect(403);
    await request(app.getHttpServer())
      .post('/security-boundary/internal')
      .set('x-platform-internal-key', internalKey)
      .set('x-platform-instance-id', 'other-instance')
      .expect(403);
    const valid = await request(app.getHttpServer())
      .post('/security-boundary/internal')
      .set('x-platform-internal-key', internalKey)
      .set('x-platform-instance-id', instance)
      .expect(201);
    expect(valid.body).toEqual({ verified: true });
  });
});
