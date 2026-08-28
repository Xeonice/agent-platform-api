import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import request from 'supertest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { AppModule } from '../../src/app.module';
import { configurePlatformApp } from '../../src/bootstrap/configure-app';
import { AuditRepository } from '../../src/platform/audit/audit.repository';
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
  configurePlatformApp(app);
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
  configurePlatformApp(isolated);
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

/**
 * 口令门的审计（13 §2.8.2 的 `category: 'system'`）。
 *
 * ⚠️ 这一档此前**一个生产者都没有** —— 平台第一道门上的纯安全事件只有一行运行日志，
 * 而运行日志按 05 §4 滚掉、也不在产品面板上（P21-5 §10.1）。「昨晚有人在试口令吗」
 * 因此答不出来。
 */
describe('POST /api/access/unlock —— 审计（category: system）', () => {
  it('成功与失败都进审计流，且口令本身一个字节都不进', async () => {
    const agent = request.agent(app.getHttpServer());
    await agent.post('/api/access/unlock').send({ passcode: PASSCODE }).expect(200);

    const res = await agent.get('/api/system/audit?category=system&limit=500').expect(200);
    const items = res.body.items as { type: string }[];
    const types = items.map((i) => i.type);
    // 本文件前面那条「rejects a wrong passcode」用的是同一个 app / 同一个库。
    expect(types).toContain('system.access.unlock_failed');
    expect(types).toContain('system.access.unlocked');

    // ⛔ **整条流里不许出现口令，也不许出现那次试错用的串。** 这一条是真正的守卫：
    // 上面的 type 断言在「顺手把 body.passcode 塞进 detail」的写法下照样绿。
    const blob = JSON.stringify(items);
    expect(blob).not.toContain(PASSCODE);
    expect(blob).not.toContain('wrong-one');
  });

  it('达到阈值额外落一行 error，锁定期内的每一次再试也各记一行', async () => {
    // 自己的 app ⇒ **自己的 limiter**，计数因此是精确的。
    const isolated = await buildIsolatedApp();
    try {
      const server = isolated.getHttpServer();
      const repo = isolated.get(AuditRepository);
      // ⚠️ **水位线，不是「新 app 所以库是空的」。** `DATABASE_URL=':memory:'` 在同一个
      // 进程里被复用 —— 隔离的 app 换来的是自己的 limiter，**不是自己的库**，本文件
      // 前面几条的审计行都还在。第一版没有这条水位线，`unlock_failed` 数出来是 11。
      const watermark = repo.list({ limit: 1 }).items[0]?.seq ?? 0;
      for (let i = 0; i < 5; i++) {
        await request(server).post('/api/access/unlock').send({ passcode: 'nope' }).expect(401);
      }
      // 被锁之后还在敲 —— 「有人在爆破」最硬的信号，且这些尝试**压根不进 limiter 的
      // 计数**（controller 查到锁定就抛了），不记就彻底没有。
      await request(server).post('/api/access/unlock').send({ passcode: 'nope' }).expect(429);
      await request(server).post('/api/access/unlock').send({ passcode: 'nope' }).expect(429);

      const rows = repo
        .list({ limit: 500 })
        .items.filter((i) => i.seq > watermark && i.category === 'system');
      const count = (t: string): number => rows.filter((i) => i.type === t).length;
      expect(count('system.access.unlock_failed')).toBe(5);
      expect(count('system.access.locked')).toBe(1);
      expect(count('system.access.locked_attempt')).toBe(2);

      // 「试了多少次」由 limiter 交出来的连续计数回答 —— 5 条失败各带自己的序号。
      const ordinals = rows
        .filter((i) => i.type === 'system.access.unlock_failed')
        .map((i) => i.detail?.consecutiveFailures)
        .sort((a, b) => Number(a) - Number(b));
      expect(ordinals).toEqual([1, 2, 3, 4, 5]);

      // 门被锁上那一条是 error 级：运维筛「仅告警」时必须扫得到。
      expect(rows.find((i) => i.type === 'system.access.locked')?.severity).toBe('error');
    } finally {
      await isolated.close();
    }
  });
});
