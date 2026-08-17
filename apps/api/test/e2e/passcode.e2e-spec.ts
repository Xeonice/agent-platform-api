import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import request from 'supertest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { ZodValidationPipe } from 'nestjs-zod';
import { AppModule } from '../../src/app.module';
import { PasscodeService } from '../../src/platform/access-passcode/passcode.service';

/**
 * Access passcode Guard enforcement e2e (docs/shared/11 §3.1, MVP). Proves the
 * Guard is ACTIVE: health is exempt, protected routes 401 without a passcode,
 * a valid passcode issues a 7-day cookie, and 5 failures lock for 5 minutes.
 */
const PASSCODE = 'S1TestPasscode99';
let app: INestApplication;

beforeAll(async () => {
  process.env.DATABASE_URL = ':memory:';
  process.env.ACCESS_PASSCODE = PASSCODE; // enables the guard for this process
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ZodValidationPipe());
  await app.init();
});

afterAll(async () => {
  delete process.env.ACCESS_PASSCODE;
  await app?.close();
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
    const server = app.getHttpServer();
    for (let i = 0; i < 5; i++) {
      await request(server).get('/api/sandboxes?projectId=p').set('x-access-passcode', 'wrong');
    }
    const locked = await request(server)
      .get('/api/sandboxes?projectId=p')
      .set('x-access-passcode', 'wrong')
      .expect(429);
    expect(locked.body.code).toBe('PASSCODE_LOCKED');
    expect(locked.body.retryAfterSec).toBeGreaterThan(0);
  });
});
