import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { AppModule } from '../../../apps/api/src/app.module';
import { configurePlatformApp } from '../../../apps/api/src/bootstrap/configure-app';
import { useEnv } from '../../support/strict-ports';

const PASSCODE = 'governance-regression-passcode';
let app: INestApplication;
let restore: () => void;
beforeAll(async () => {
  restore = useEnv({ DATABASE_URL: ':memory:', ACCESS_PASSCODE: PASSCODE });
  const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = module.createNestApplication();
  configurePlatformApp(app);
  await app.init();
  await app.listen(0);
});
afterAll(async () => {
  await app?.close();
  restore?.();
});

describe('AC-ACC-005.2: opening the console cannot consume unlock attempts', () => {
  it('allows the first correct unlock after concurrent unauthenticated resource requests', async () => {
    const responses = await Promise.all(
      Array.from({ length: 20 }, () => request(app.getHttpServer()).get('/api/sandboxes')),
    );
    expect(responses.every((r) => r.status === 401)).toBe(true);
    await request(app.getHttpServer())
      .post('/api/access/unlock')
      .send({ passcode: PASSCODE })
      .expect(200);
  });
  it('limits explicit header guesses while an established session remains usable', async () => {
    const unlock = await request(app.getHttpServer())
      .post('/api/access/unlock')
      .send({ passcode: PASSCODE })
      .expect(200);
    const cookie = unlock.headers['set-cookie'];
    for (let attempt = 0; attempt < 5; attempt++) {
      await request(app.getHttpServer())
        .get('/api/projects')
        .set('x-access-passcode', 'wrong')
        .expect(401);
    }
    await request(app.getHttpServer())
      .get('/api/projects')
      .set('x-access-passcode', 'wrong')
      .expect(429);
    await request(app.getHttpServer())
      .post('/api/access/unlock')
      .send({ passcode: PASSCODE })
      .expect(429);
    await request(app.getHttpServer()).get('/api/projects').set('Cookie', cookie).expect(200);
  });
});
