import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import request from 'supertest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { AppModule } from '../../src/app.module';
import { platformValidationPipe } from '../../src/bootstrap/validation.pipe';
import { expectPasscodeEnabled, useEnv } from './_env';

/**
 * POST /api/access/unlock (docs/shared/11 §3.1): submit the passcode → receive the
 * 7-day signed `ap_session` HttpOnly cookie that both the REST guard and the
 * terminal WS authenticator accept. Proves: wrong passcode 401; correct passcode
 * 200 + Set-Cookie + subsequent protected REST authorized via the cookie; the
 * endpoint itself is passcode-exempt; lockout after 5 failures (429).
 */
const PASSCODE = 'unlock-passcode-abc123';
let app: INestApplication;
let restoreEnv: () => void;

beforeAll(async () => {
  restoreEnv = useEnv({ DATABASE_URL: ':memory:', ACCESS_PASSCODE: PASSCODE });
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api');
  app.useGlobalPipes(platformValidationPipe());
  await app.init();
  await app.listen(0);
  expectPasscodeEnabled(app, true);
});

/**
 * A SEPARATE app (hence a separate `PasscodeAttemptLimiter`) for the lockout case —
 * it ends by design in a 5-minute lock, and leaving that on the shared app would give
 * every other test in this file a 429 where it asserts 401, i.e. the file would pass
 * only in one particular test order.
 */
async function buildIsolatedApp(): Promise<INestApplication> {
  const ref = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const isolated = ref.createNestApplication();
  isolated.setGlobalPrefix('api');
  isolated.useGlobalPipes(platformValidationPipe());
  await isolated.init();
  await isolated.listen(0);
  return isolated;
}

afterAll(async () => {
  await app?.close();
  restoreEnv?.();
});

describe('POST /api/access/unlock', () => {
  it('a protected REST route is 401 without a passcode/session', async () => {
    await request(app.getHttpServer()).get('/api/sandboxes?projectId=prj-x').expect(401);
  });

  it('rejects a wrong passcode with 401 PASSCODE_INVALID', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/access/unlock')
      .send({ passcode: 'wrong-one' })
      .expect(401);
    expect(res.body.code).toBe('PASSCODE_INVALID');
  });

  it('accepts the correct passcode, sets ap_session, and authorizes later REST via the cookie', async () => {
    const agent = request.agent(app.getHttpServer());
    const res = await agent.post('/api/access/unlock').send({ passcode: PASSCODE }).expect(200);
    expect(res.body).toEqual({ unlocked: true });
    const setCookie = res.headers['set-cookie'];
    expect(Array.isArray(setCookie) ? setCookie[0] : setCookie).toMatch(/ap_session=/);
    // the agent carries the cookie → the same protected route now passes.
    await agent.get('/api/sandboxes?projectId=prj-x').expect(200);
  });

  it('locks out after 5 consecutive failures (429 PASSCODE_LOCKED)', async () => {
    // own app ⇒ a FRESH limiter, so the counts are exact rather than "somewhere in
    // the next 8 attempts" — and this case cannot leave a 5-minute lock behind on the
    // app the other tests share.
    const isolated = await buildIsolatedApp();
    try {
      const server = isolated.getHttpServer();
      for (let i = 0; i < 5; i++) {
        const res = await request(server)
          .post('/api/access/unlock')
          .send({ passcode: 'still-wrong' });
        expect(res.status, `attempt ${i + 1} of the first five must still be 401`).toBe(401);
        expect(res.body.code).toBe('PASSCODE_INVALID');
      }
      const locked = await request(server)
        .post('/api/access/unlock')
        .send({ passcode: 'still-wrong' })
        .expect(429);
      expect(locked.body.code).toBe('PASSCODE_LOCKED');
      expect(locked.body.retryAfterSec).toBeGreaterThan(0);
    } finally {
      await isolated.close();
    }
  });
});
