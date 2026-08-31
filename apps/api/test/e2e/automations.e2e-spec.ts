import { mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { AppModule } from '../../src/app.module';
import { configurePlatformApp } from '../../src/bootstrap/configure-app';
import { useEnv } from './_env';

/**
 * automation 的 11 个 REST 端点（10 §6.5 / 27 §8）走真 HTTP 一遍。
 *
 * ── 这个文件证明的是什么 ────────────────────────────────────────────────────────
 * 单测证明了不变量与决策表；这里证明的是**壳真的接上了**：
 *   · controller 真的注册进了 `controllers` 数组（否则 build 挂、emit 拿旧 dist 照样
 *     「成功」—— 上一轮就是这么漏掉三个端点的）；
 *   · zod 管道真的把非法入参挡在 400（`VALIDATION_FAILED`，不是 500）；
 *   · ★ **`timezone` 在 PUT 里缺席时不被改写**（I-AUT-9）—— 这一条只有跑真请求才算数，
 *     因为「顺手补一个默认值」最容易发生在 DTO 与管道那一层，而不是聚合里。
 *
 * ── 每条断言钉住的变异 ──────────────────────────────────────────────────────────
 *  ① `UpdateAutomationSchema` 把 `timezone` 写成必填/带默认 ⇒ 「PUT 不改时区」红
 *  ② 应用层在 create 之前不查项目 ⇒ 「未知项目 404」红（会变成 500 外键异常）
 *  ③ I-AUT-7 的应用层计数去掉 ⇒ 「第 21 条 409」红
 *  ④ 控制器忘了注册 ⇒ 全红（404）
 */
let app: INestApplication;
let dataRoot: string;
let restoreEnv: () => void;
let projectId: string;

const baseRule = {
  name: 'nightly regression',
  runtime: 'codex',
  prompt: 'run the regression suite and summarise failures',
  scheduleKind: 'daily' as const,
  scheduleConfig: { time: '03:00' },
  timezone: 'Asia/Shanghai',
  timeoutMinutes: 120 as const,
  artifactRetentionDays: 7 as const,
};

beforeAll(async () => {
  dataRoot = mkdtempSync(resolve(process.cwd(), 'tmp-automation-e2e-'));
  restoreEnv = useEnv({
    DATABASE_URL: ':memory:',
    DATA_ROOT: dataRoot,
    // 定时器不该在 e2e 里自己跑（与 DISABLE_VOLUME_REAPER 同理）
    DISABLE_AUTOMATION_SCHEDULER: '1',
    DISABLE_VOLUME_REAPER: '1',
  });
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  configurePlatformApp(app);
  await app.init();
  await app.listen(0);

  const created = await request(app.getHttpServer())
    .post('/api/projects')
    .send({ name: `aut-e2e-${String(Date.now())}`, sourceType: 'empty' })
    .expect(202);
  projectId = created.body.id as string;
}, 60_000);

afterAll(async () => {
  await app?.close();
  restoreEnv?.();
  if (dataRoot) rmSync(dataRoot, { recursive: true, force: true });
});

const http = () => request(app.getHttpServer());

describe('automation CRUD（10 §6.5）', () => {
  it('POST /api/projects/:id/automations 建规则，回显创建字段 + 算好 nextTriggerAt', async () => {
    const res = await http()
      .post(`/api/projects/${projectId}/automations`)
      .send(baseRule)
      .expect(201);

    expect(res.body.projectId).toBe(projectId);
    expect(res.body.timezone).toBe('Asia/Shanghai');
    expect(res.body.enabled).toBe(true);
    expect(res.body.degraded).toBe(false);
    expect(res.body.consecutiveFailures).toBe(0);
    expect(res.body.triggerOn).toBe('failure');
    // 当地 03:00 = 前一天 19:00Z
    expect(res.body.nextTriggerAt).toMatch(/T19:00:00\.000Z$/);
  });

  it('GET /api/projects/:id/automations 列出该项目的规则', async () => {
    const res = await http().get(`/api/projects/${projectId}/automations`).expect(200);
    expect(res.body.length).toBeGreaterThanOrEqual(1);
    expect(res.body[0].projectId).toBe(projectId);
  });

  it('★ 未知项目 ⇒ 404（而不是一个外键约束 500）', async () => {
    await http().post('/api/projects/prj-does-not-exist/automations').send(baseRule).expect(404);
  });

  it('非法入参走 zod 管道 ⇒ 400 VALIDATION_FAILED（信封形状）', async () => {
    const res = await http()
      .post(`/api/projects/${projectId}/automations`)
      .send({ ...baseRule, timeoutMinutes: 45 })
      .expect(400);
    expect(res.body.code).toBe('VALIDATION_FAILED');
    expect(res.body.retryable).toBe(false);
  });

  it('非 IANA 时区被领域拒绝 ⇒ 400（zod 只管长度，真解那一票在 Schedule 里）', async () => {
    const res = await http()
      .post(`/api/projects/${projectId}/automations`)
      .send({ ...baseRule, timezone: 'Asia/NotACity' })
      .expect(400);
    expect(res.body.code).toBe('VALIDATION_FAILED');
    expect(res.body.sideEffectFree).toBe(true);
  });

  it('★ PUT 只改 prompt ⇒ timezone 与 nextTriggerAt 一毫秒都不动（I-AUT-9）', async () => {
    const created = (
      await http().post(`/api/projects/${projectId}/automations`).send(baseRule).expect(201)
    ).body;

    const updated = (
      await http()
        .put(`/api/automations/${created.id}`)
        .send({ prompt: 'a different instruction' })
        .expect(200)
    ).body;

    expect(updated.prompt).toBe('a different instruction');
    expect(updated.timezone).toBe('Asia/Shanghai');
    expect(updated.nextTriggerAt).toBe(created.nextTriggerAt);
  });

  it('显式传新 timezone 才改，且触发时刻随之重算', async () => {
    const created = (
      await http().post(`/api/projects/${projectId}/automations`).send(baseRule).expect(201)
    ).body;
    const updated = (
      await http().put(`/api/automations/${created.id}`).send({ timezone: 'UTC' }).expect(200)
    ).body;
    expect(updated.timezone).toBe('UTC');
    expect(updated.nextTriggerAt).toMatch(/T03:00:00\.000Z$/);
  });

  it('enable / disable 是动作：disable 之后 nextTriggerAt 缺席，enable 清零计数', async () => {
    const created = (
      await http().post(`/api/projects/${projectId}/automations`).send(baseRule).expect(201)
    ).body;

    const disabled = (await http().post(`/api/automations/${created.id}/disable`).expect(200)).body;
    expect(disabled.enabled).toBe(false);
    expect(disabled.nextTriggerAt).toBeUndefined();

    const enabled = (await http().post(`/api/automations/${created.id}/enable`).expect(200)).body;
    expect(enabled.enabled).toBe(true);
    expect(enabled.degraded).toBe(false);
    expect(enabled.consecutiveFailures).toBe(0);
    expect(enabled.nextTriggerAt).toBeDefined();
  });

  it('GET / DELETE /api/automations/:id —— 删完再取 404', async () => {
    const created = (
      await http().post(`/api/projects/${projectId}/automations`).send(baseRule).expect(201)
    ).body;
    await http().get(`/api/automations/${created.id}`).expect(200);
    await http().delete(`/api/automations/${created.id}`).expect(204);
    await http().get(`/api/automations/${created.id}`).expect(404);
  });

  it('★ 审计真的写进去了 —— `automation.created` 出现在平台审计流里', async () => {
    // ⚠️ `AuditRecorder.record` 是「同步、永不抛」的（contracts 的接口纪律），所以一个
    // **非法的 category** 不会让创建端点失败，它会静默丢掉那条审计。这条断言就是为了
    // 让那种静默出声：`audit_events.category` 的 CHECK 只认五个值，automation 借用的是
    // `project`（库里没有 `automation` 这一档，加一档要动 migration，不在本切片内）。
    const res = await http().get('/api/system/audit?limit=100').expect(200);
    const types = (res.body.items as { type: string }[]).map((e) => e.type);
    expect(types).toContain('automation.created');
  });

  it('未知规则 ⇒ 404（get / put / delete / enable / runs 一致）', async () => {
    await http().get('/api/automations/nope').expect(404);
    await http().put('/api/automations/nope').send({ prompt: 'x' }).expect(404);
    await http().delete('/api/automations/nope').expect(404);
    await http().post('/api/automations/nope/enable').expect(404);
    await http().get('/api/automations/nope/runs').expect(404);
  });
});

describe('automation 运行历史与日志', () => {
  it('GET /api/automations/:id/runs 回分页信封（10 §7.2），新规则是空的', async () => {
    const created = (
      await http().post(`/api/projects/${projectId}/automations`).send(baseRule).expect(201)
    ).body;
    const res = await http().get(`/api/automations/${created.id}/runs`).expect(200);
    expect(res.body).toEqual({ items: [], hasMore: false });
  });

  it('GET /api/automations/runs/:runId ⇒ 未知 run 404', async () => {
    await http().get('/api/automations/runs/nope').expect(404);
    await http().get('/api/automations/runs/nope/logs').expect(404);
  });
});

describe('POST /api/automations/webhook-test（03 §8.5）', () => {
  it('★ 环回地址被 SSRF 谓词拒绝 —— 200 + ok:false + HOST_NOT_ALLOWED', async () => {
    const res = await http()
      .post('/api/automations/webhook-test')
      .send({ url: 'http://127.0.0.1:9/hook' })
      .expect(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.errorCode).toBe('HOST_NOT_ALLOWED');
  });

  it('★ 云元数据地址同样被拒', async () => {
    const res = await http()
      .post('/api/automations/webhook-test')
      .send({ url: 'http://169.254.169.254/latest/meta-data/' })
      .expect(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.errorCode).toBe('HOST_NOT_ALLOWED');
  });

  it('非 http/https ⇒ VALIDATION_FAILED（仍是 200 + ok:false，不是 HTTP 400）', async () => {
    const res = await http()
      .post('/api/automations/webhook-test')
      .send({ url: 'ftp://example.com/hook' })
      .expect(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.errorCode).toBe('VALIDATION_FAILED');
  });

  it('缺 url ⇒ zod 管道 400（这一层仍然是真的 400）', async () => {
    await http().post('/api/automations/webhook-test').send({}).expect(400);
  });
});

describe('I-AUT-7：每项目 ≤ 20 条规则', () => {
  it('★ 第 21 条 ⇒ 409 AUTOMATION_LIMIT_REACHED，零副作用', async () => {
    const scoped = (
      await http()
        .post('/api/projects')
        .send({ name: `aut-limit-${String(Date.now())}`, sourceType: 'empty' })
        .expect(202)
    ).body.id as string;

    for (let i = 0; i < 20; i += 1) {
      await http()
        .post(`/api/projects/${scoped}/automations`)
        .send({ ...baseRule, name: `rule-${String(i)}` })
        .expect(201);
    }
    const res = await http()
      .post(`/api/projects/${scoped}/automations`)
      .send({ ...baseRule, name: 'rule-21' })
      .expect(409);
    expect(res.body.code).toBe('AUTOMATION_LIMIT_REACHED');
    expect(res.body.sideEffectFree).toBe(true);
    // 零副作用：还是 20 条
    const list = await http().get(`/api/projects/${scoped}/automations`).expect(200);
    expect(list.body).toHaveLength(20);
  }, 30_000);
});
