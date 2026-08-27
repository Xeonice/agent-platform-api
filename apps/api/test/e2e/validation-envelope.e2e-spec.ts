import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import request from 'supertest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import {
  SANDBOX_PROVIDER_REGISTRY,
  WORKSPACE_PREPARER,
  PROJECT_FACADE,
  IMAGE_SPEC_REGISTRY,
} from '@platform/contracts';
import { AppModule } from '../../src/app.module';
import { configurePlatformApp } from '../../src/bootstrap/configure-app';
import {
  makeFakeImageSpecRegistry,
  registerDefaultImage,
  fakeProjectFacade,
  fakeWorkspace,
  makeFakeRegistry,
} from './_fakes';

/**
 * DTO 校验失败在**线上那条路**上是什么样 —— 端到端（25 §6.1 / 04 §4 / shared/10 §6.8）。
 *
 * ── 这个文件为什么必须是 e2e，而不是又一组 pipe 单测 ──────────────────────────────
 * 被测的不是「信封长得对不对」（那在 `packages/contracts/test/unit/validation-envelope.spec.ts`
 * 里逐条钉着），而是「**HTTP 上真的出来的是它**」：pipe 有没有装、装的是不是 `main.ts` 装
 * 的那一只、Nest 有没有在序列化时把它改回默认形状。这三件事只有让请求真的走一遍才知道。
 *
 * ── 被拒的那条规则，和它此前的样子 ────────────────────────────────────────────────
 * `initialPrompt` 有 `max(8000)`（10 §7.3，与 Task 面同一口径）。超长时用户此前看到的是
 * 「请求失败（HTTP 400）」—— 因为 `nestjs-zod` 默认管道出线的是
 * `{statusCode:400, message:'Validation failed', errors:[…]}`，没有 `code`、没有
 * `retryable`，前端 `toApiError` 判定「不是信封」后把整个 body 换掉。后端一清二楚地知道是
 * 哪个字段、超了多少，而这句话一次都没到过能据此改请求的人眼前。
 */
let app: INestApplication;

const PROJECT = 'prj-validation-e2e';
/** 独一无二，便于在整个响应体里搜；扮演「不该被回显的用户输入」。 */
const SENTINEL = 'sk-live-DO-NOT-ECHO-9f3a1';

beforeAll(async () => {
  process.env.DATABASE_URL = ':memory:';
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(SANDBOX_PROVIDER_REGISTRY)
    .useValue(makeFakeRegistry())
    .overrideProvider(WORKSPACE_PREPARER)
    .useValue(fakeWorkspace)
    .overrideProvider(PROJECT_FACADE)
    .useValue(fakeProjectFacade)
    // The create door demands a REGISTERED image since 04 §7 时刻③. The whole image
    // chain stays real here — only the registry round-trip is faked, because an e2e
    // must not need a reachable registry.
    .overrideProvider(IMAGE_SPEC_REGISTRY)
    .useValue(makeFakeImageSpecRegistry())
    .compile();
  app = moduleRef.createNestApplication();
  // 与 `main.ts` **同一套装配**（prefix + 管道 + 信封 filter）—— 这一行本身就是被测对象的一半。
  // ⚠️ 此前这里只装前两样，于是**测信封的这个文件测的不是生产的信封**：
  //    出线前那道归一（ErrorEnvelopeFilter）没跑过。
  configurePlatformApp(app);
  await app.init();
  await app.listen(0);
  // The create door needs a REGISTERED image now (04 §7 时刻③); register the
  // platform default once so the creates below can omit `image` as they always did.
  await registerDefaultImage(app);
});

afterAll(async () => {
  await app?.close();
});

/** 一个刚好越界一个字符的指令：违反的规则明确，而且只有这一条。 */
const oversizedPrompt = (marker = 'x') => `${marker}${'x'.repeat(8000)}`;

describe('POST /api/sandboxes with an over-long initialPrompt', () => {
  it('answers with a real ErrorEnvelope, not `{statusCode, message, errors}`', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/sandboxes')
      .send({ projectId: PROJECT, runtime: 'claude-code', initialPrompt: oversizedPrompt() })
      .expect(400);

    expect(res.body).toMatchObject({
      code: 'VALIDATION_FAILED',
      // 前端 `toApiError` 要求 `code` + `retryable` 都在，才肯把 body 当信封；
      // 少任何一个，下面那句人话就永远到不了用户眼前。
      retryable: false,
      // pipe 跑在 controller 之前 ⇒ 没落库、没进调度、没碰 provider.create。
      // 「什么都没发生」在这里是**构造上**成立的，不是逐条判断。
      sideEffectFree: true,
    });
    // 旧形状彻底消失（否则前端还是会判「不是信封」）。
    expect(res.body).not.toHaveProperty('statusCode');
    expect(res.body).not.toHaveProperty('errors');
  });

  it('says WHICH field and WHAT rule — the whole point of the change', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/sandboxes')
      .send({ projectId: PROJECT, runtime: 'claude-code', initialPrompt: oversizedPrompt() })
      .expect(400);

    const message = res.body.message as string;
    expect(message).not.toBe('Validation failed');
    expect(message).toContain('initialPrompt');
    expect(message).toContain('8000');
    // `details` 带逐项清单：路径 + 规则 + 期望。
    expect(res.body.details).toEqual([
      { path: 'initialPrompt', code: 'too_big', message: '长度超过上限 8000 字符' },
    ]);
  });

  it('`sideEffectFree: true` is a fact, not a claim — nothing was created', async () => {
    await request(app.getHttpServer())
      .post('/api/sandboxes')
      .send({ projectId: PROJECT, runtime: 'claude-code', initialPrompt: oversizedPrompt() })
      .expect(400);

    // 门口之前就被拦下 ⇒ 列表里不该有任何东西可看。信封说「本次请求什么都没改变」，
    // 这一行是它的证据；否则前端那句「本次请求未创建任何任务」就是在撒谎。
    const listed = await request(app.getHttpServer())
      .get('/api/sandboxes')
      .query({ projectId: PROJECT })
      .expect(200);
    expect(listed.body).toEqual([]);
  });

  it('never echoes the prompt body back onto the wire', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/sandboxes')
      .send({
        projectId: PROJECT,
        runtime: 'claude-code',
        initialPrompt: oversizedPrompt(SENTINEL),
      })
      .expect(400);

    // 搜整个响应文本而不是逐字段断言：逐字段只能挡住今天想得到的那几个字段。
    expect(res.text).not.toContain(SENTINEL);
  });
});

describe('the same envelope covers every other DTO violation on the wire', () => {
  it('a missing required field', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/sandboxes')
      .send({ runtime: 'claude-code' })
      .expect(400);

    expect(res.body).toMatchObject({ code: 'VALIDATION_FAILED', retryable: false });
    expect(res.body.details).toEqual([
      { path: 'projectId', code: 'invalid_type', message: '缺少必填字段' },
    ]);
  });

  it('a bad `timeoutMinutes` — and zod’s union internals stay off the wire', async () => {
    // `TimeoutMinutesSchema` 是字面量联合，非法值让 zod 造出 `invalid_union`，其
    // `unionErrors` 子树里每个分支都带 `received: <原始值>`。原样透出 issue 就会把它带上。
    const res = await request(app.getHttpServer())
      .post('/api/sandboxes')
      .send({ projectId: PROJECT, runtime: 'claude-code', timeoutMinutes: 133742 })
      .expect(400);

    expect(res.body).toMatchObject({ code: 'VALIDATION_FAILED', sideEffectFree: true });
    expect(res.text).not.toContain('133742');
    expect(res.body.details).toEqual([
      { path: 'timeoutMinutes', code: 'invalid_union', message: '不满足任何一种允许的形状' },
    ]);
  });

  it('a query-string DTO violation, not just a body one', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/sandboxes')
      .query({ projectId: '' })
      .expect(400);

    expect(res.body).toMatchObject({ code: 'VALIDATION_FAILED', retryable: false });
    expect(res.body.message).toContain('projectId');
  });
});
