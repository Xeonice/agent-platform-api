import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import request from 'supertest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { AppModule } from '../../src/app.module';
import { expectPasscodeEnabled, useEnv } from './_env';
import { PasscodeService } from '../../src/platform/access-passcode/passcode.service';
import { platformValidationPipe } from '../../src/bootstrap/validation.pipe';

/**
 * Access passcode Guard enforcement e2e (docs/shared/11 §3.1, MVP). Proves the
 * Guard is ACTIVE: health is exempt, protected routes 401 without a passcode,
 * a valid passcode issues a 7-day cookie, and 5 failures lock for 5 minutes.
 */
const PASSCODE = 'S1TestPasscode99';
let app: INestApplication;
let restoreEnv: () => void;

beforeAll(async () => {
  // save-and-restore, never a bare delete: the e2e project shares ONE process
  // (singleFork), so erasing a key leaks into every later spec (_env.ts).
  restoreEnv = useEnv({ DATABASE_URL: ':memory:', ACCESS_PASSCODE: PASSCODE });
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api');
  app.useGlobalPipes(platformValidationPipe());
  await app.init();
  await app.listen(0);
  // fail HERE, naming the cause, rather than 20 lines later as `expected 200 to be 401`
  expectPasscodeEnabled(app, true);
});

/**
 * Build a SEPARATE app (and therefore a separate `PasscodeAttemptLimiter`).
 *
 * The lockout case deliberately drives the limiter into a 5-MINUTE lock, and the
 * limiter is per-app in-memory state keyed by client IP. Sharing the app would mean
 * every later test in this file gets 429 instead of the 401 it asserts — i.e. the
 * file would only pass in one particular test order, which is exactly the kind of
 * hidden coupling that makes a suite untrustworthy when the runner reorders it.
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

describe('access passcode guard', () => {
  it('generatePasscode() yields 16 chars with no ambiguous 0/O/l/1', () => {
    const pc = PasscodeService.generatePasscode();
    expect(pc).toHaveLength(16);
    expect(pc).not.toMatch(/[0Ol1]/);
  });

  it('GET /api/health is exempt (200 without passcode)', async () => {
    await request(app.getHttpServer()).get('/api/health').expect(200);
  });

  it('a protected route is 401 without a passcode', async () => {
    await request(app.getHttpServer()).get('/api/sandboxes?projectId=p').expect(401);
  });

  it('a valid passcode is accepted and issues a 7-day HttpOnly cookie', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/sandboxes?projectId=p')
      .set('x-access-passcode', PASSCODE)
      .expect(200);
    const setCookie = res.headers['set-cookie']?.[0] ?? '';
    expect(setCookie).toContain('ap_session=');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Max-Age=604800');
  });

  it('locks for 5 minutes after 5 consecutive failures (429 + retryAfterSec)', async () => {
    // own app ⇒ own limiter: this case ends with a 5-minute lock, and leaving that on
    // the shared app would make every other test here order-dependent.
    const isolated = await buildIsolatedApp();
    try {
      const server = isolated.getHttpServer();
      for (let i = 0; i < 5; i++) {
        await request(server)
          .get('/api/sandboxes?projectId=p')
          .set('x-access-passcode', 'wrong')
          .expect(401); // a fresh limiter ⇒ the first five really are 401, not "≤5"
      }
      const locked = await request(server)
        .get('/api/sandboxes?projectId=p')
        .set('x-access-passcode', 'wrong')
        .expect(429);
      expect(locked.body.code).toBe('PASSCODE_LOCKED');
      expect(locked.body.retryAfterSec).toBeGreaterThan(0);
    } finally {
      await isolated.close();
    }
  });
});
