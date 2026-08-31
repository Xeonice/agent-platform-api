import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import request from 'supertest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import {
  PROJECT_FACADE,
  IMAGE_SPEC_REGISTRY,
  SANDBOX_PROVIDER_REGISTRY,
  WORKSPACE_PREPARER,
} from '@platform/contracts';
import { AppModule } from '../../src/app.module';
import { useEnv } from './_env';
import { configurePlatformApp } from '../../src/bootstrap/configure-app';
import {
  FakeProvider,
  makeFakeImageSpecRegistry,
  registerDefaultImage,
  fakeProjectFacade,
  fakeWorkspace,
  makeFakeRegistry,
} from './_fakes';

/**
 * 03 §3 的准入闸，**端到端**这一遍。
 *
 * ── 为什么在应用层那一套之外还要这一条 ────────────────────────────────────────
 * `resource-admission.spec.ts` 证明的是行为；只有这里看得见两件别处看不见的事：
 *   ① 拒绝是从 `ErrorEnvelopeFilter` 出来的**真信封**（`code` / `retryable` 都在），
 *      而不是 Nest 默认的 `{statusCode, message, error}` —— 后者被前端 `toApiError`
 *      直接丢掉，用户看到的是「请求失败（HTTP 429）」而不是平台写的那句话（10 §6.8 ★）；
 *   ② 状态码真的是 **429**，也就是 `AutomationTaskLauncherAdapter` 那半段
 *      「`HttpException` + body.code」的判据在真链路上成立。
 *
 * ⚠️ 本文件**自己把宿主容量调小**（`_data-root.setup.ts` 给整套 e2e 的是一台很大的假
 * 机器，理由见那里）。调小而不是关掉别的 —— 判定逻辑一行都没被跳过。
 */
let app: INestApplication;
let restoreEnv: () => void;

const PROJECT = 'prj-capacity';
const RUNTIME = 'claude-code';

beforeAll(async () => {
  restoreEnv = useEnv({
    DATABASE_URL: ':memory:',
    ACCESS_PASSCODE: undefined,
    // 假镜像声明 1 核 / 512MB（`_fakes.ts`）⇒ 1 核的池子正好只发得出一份配额。
    SCHEDULER_HOST_CORES: '1',
    SCHEDULER_HOST_RAM_MB: '65536',
    SCHEDULER_SAFETY_MARGIN: '0',
    SCHEDULER_CPU_OVERCOMMIT: '1',
    WORKSPACE_MIN_FREE_BYTES: '0',
  });
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(SANDBOX_PROVIDER_REGISTRY)
    .useValue(makeFakeRegistry([new FakeProvider('aio')]))
    .overrideProvider(WORKSPACE_PREPARER)
    .useValue(fakeWorkspace)
    .overrideProvider(PROJECT_FACADE)
    .useValue(fakeProjectFacade)
    .overrideProvider(IMAGE_SPEC_REGISTRY)
    .useValue(makeFakeImageSpecRegistry())
    .compile();
  app = moduleRef.createNestApplication();
  configurePlatformApp(app);
  await app.init();
  await app.listen(0);
  await registerDefaultImage(app);
});

afterAll(async () => {
  await app?.close();
  restoreEnv?.();
});

const http = () => request(app.getHttpServer());

describe('POST /api/sandboxes —— 容量不足是一个 429 信封（03 §3 / 10 §6.8）', () => {
  it('★★ 第一发成功；第二发 429 + RESOURCE_EXHAUSTED + retryable:true', async () => {
    const first = await http()
      .post('/api/sandboxes')
      .send({ projectId: PROJECT, runtime: RUNTIME })
      .expect(201);
    expect(first.body.id).toBeTruthy();

    const refused = await http()
      .post('/api/sandboxes')
      .send({ projectId: PROJECT, runtime: RUNTIME })
      .expect(429);

    // 信封的三个必填字段都要在 —— 少了 `code`，前端连「操作失败（错误码 XXX）」都
    // 显示不出来；少了 `retryable`，「稍后重试」这条唯一的出路就说不出口。
    expect(refused.body).toMatchObject({
      code: 'RESOURCE_EXHAUSTED',
      retryable: true,
    });
    expect(typeof refused.body.message).toBe('string');
    expect(refused.body.message.length).toBeGreaterThan(0);
  });

  it('★ 被拒的那一发**没有**在任务列表里留下任何东西', async () => {
    const before = (await http().get(`/api/sandboxes?projectId=${PROJECT}`).expect(200)).body;
    await http().post('/api/sandboxes').send({ projectId: PROJECT, runtime: RUNTIME }).expect(429);
    const after = (await http().get(`/api/sandboxes?projectId=${PROJECT}`).expect(200)).body;

    // 若登记与落库不同事务（或登记发生在落库之后），这里每被拒一次就多一个空壳沙箱。
    expect(after.length).toBe(before.length);
  });

  it('★ 销毁一发之后配额回池，下一发又能建 —— 释放路径在真链路上也接上了', async () => {
    const list = (await http().get(`/api/sandboxes?projectId=${PROJECT}`).expect(200)).body;
    const victim: string = list[0].id;
    await http().delete(`/api/sandboxes/${victim}`).send({}).expect(204);

    await http().post('/api/sandboxes').send({ projectId: PROJECT, runtime: RUNTIME }).expect(201);
  });
});
