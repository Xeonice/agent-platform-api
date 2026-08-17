import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import request from 'supertest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { ZodValidationPipe } from 'nestjs-zod';
import { AppModule } from '../../src/app.module';

/**
 * POST /api/access/unlock (docs/shared/11 §3.1): submit the passcode → receive the
 * 7-day signed `ap_session` HttpOnly cookie that both the REST guard and the
 * terminal WS authenticator accept. Proves: wrong passcode 401; correct passcode
 * 200 + Set-Cookie + subsequent protected REST authorized via the cookie; the
 * endpoint itself is passcode-exempt; lockout after 5 failures (429).
 */
const PASSCODE = 'unlock-passcode-abc123';
let app: INestApplication;

beforeAll(async () => {
  process.env.DATABASE_URL = ':memory:';
  process.env.ACCESS_PASSCODE = PASSCODE;
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ZodValidationPipe());
  await app.init();
});

afterAll(async () => {
  await app?.close();
  delete process.env.ACCESS_PASSCODE;
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
    // fresh IP state is not guaranteed across tests, so drive enough failures to
    // cross the threshold; the request AFTER the 5th failure must be locked.
    let locked = false;
    for (let i = 0; i < 8; i++) {
      const res = await request(app.getHttpServer())
        .post('/api/access/unlock')
        .send({ passcode: 'still-wrong' });
      if (res.status === 429) {
        expect(res.body.code).toBe('PASSCODE_LOCKED');
        expect(res.body.retryAfterSec).toBeGreaterThan(0);
        locked = true;
        break;
      }
      expect(res.status).toBe(401);
    }
    expect(locked).toBe(true);
  });
});
