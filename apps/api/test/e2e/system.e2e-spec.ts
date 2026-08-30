import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import request from 'supertest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import {
  DIAGNOSE_CHECK_IDS,
  IMAGE_SPEC_REGISTRY,
  PROJECT_FACADE,
  SANDBOX_PROVIDER_REGISTRY,
  WORKSPACE_PREPARER,
} from '@platform/contracts';
import type {
  ConnectivityResult,
  DiagnoseCheckFrame,
  DiagnoseDoneFrame,
  DiagnoseServerFrame,
  DiagnoseStartFrame,
} from '@platform/contracts';
import { AppModule } from '../../src/app.module';
import { configurePlatformApp } from '../../src/bootstrap/configure-app';
import { ConnectivityProbe } from '../../src/platform/system/diagnostics/connectivity.probe';
import { MEMORY_SOURCES, type MemorySources } from '../../src/platform/system/memory.probe';
import { AuditRepository } from '../../src/platform/audit/audit.repository';
import {
  makeFakeImageSpecRegistry,
  registerDefaultImage,
  fakeProjectFacade,
  fakeWorkspace,
  makeFakeRegistry,
} from './_fakes';
import { useEnv } from './_env';

/**
 * 系统状态与初始化的六个端点（10 §6.6 / P21-5 / P21-8 §2）。
 *
 * ⚠️ **出网探测被替身接管，其余一律走真实实现。** 一个会真的去连 api.anthropic.com 的
 * e2e 在内网 CI 上是随机红的，而且它测的是那台机器的网络而不是这段代码。替身只换
 * `ConnectivityProbe` 这一层 —— 「模型 API 全挂时要不要拦」这条产品规则仍然由真的
 * `InitializationService` 判。
 */
let app: INestApplication;

/** 可切换的出网结论 —— 离线那条门是本组最重要的断言之一，必须两个方向都测到。 */
let connectivity: ConnectivityResult[] = [];

const fakeProbe = {
  targets: () => [],
  run: () => Promise.resolve(connectivity),
};

const ONLINE: ConnectivityResult[] = [
  { target: 'api.anthropic.com', ok: true, latencyMs: 12, modelApi: true },
  { target: 'api.openai.com', ok: true, latencyMs: 15, modelApi: true },
  { target: 'ghcr.io', ok: true, latencyMs: 20, modelApi: false },
];
const OFFLINE: ConnectivityResult[] = [
  { target: 'api.anthropic.com', ok: false, modelApi: true, hint: '配置 HTTPS_PROXY 后重试' },
  { target: 'api.openai.com', ok: false, modelApi: true, hint: '配置 HTTPS_PROXY 后重试' },
  { target: 'ghcr.io', ok: true, latencyMs: 20, modelApi: false },
];

/**
 * 确定的内存读数替身。
 *
 * ⚠️ 不替身的话这条用例只能断言「level 是三个值之一」—— 而那正是**出事时也成立**的断言：
 * 上线时后端报 96.3%/critical，那句断言照样绿。喂一份已知的 vm_stat 之后，
 * 「探测 → 判定 → DTO」整条链就有了确定的期望值。
 */
const FAKE_VMSTAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                    43280.
Pages active:                                 820588.
Pages inactive:                               803419.
Pages speculative:                             20576.
Pages wired down:                             181171.
Pages purgeable:                               32933.
`;
const fakeMemorySources: MemorySources = {
  readProcMeminfo: () => Promise.resolve('MemTotal: 33554432 kB\nMemAvailable: 13565988 kB\n'),
  runVmStat: () => Promise.resolve(FAKE_VMSTAT),
  totalBytes: () => 34359738368,
};

let restoreEnv: () => void;

beforeAll(async () => {
  process.env.DATABASE_URL = ':memory:';
  // 预制镜像那一项要有一个**确定的**坐标才能断言链走到了第 5 步（`_fakes` 的
  // ImageSpecRegistry 会把它解析成一张声明了 platform.tmux 的镜像）。
  restoreEnv = useEnv({ SANDBOX_DEFAULT_IMAGE: 'registry.test/platform/sandbox:v1' });
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(SANDBOX_PROVIDER_REGISTRY)
    .useValue(makeFakeRegistry())
    .overrideProvider(WORKSPACE_PREPARER)
    .useValue(fakeWorkspace)
    .overrideProvider(PROJECT_FACADE)
    .useValue(fakeProjectFacade)
    .overrideProvider(IMAGE_SPEC_REGISTRY)
    .useValue(makeFakeImageSpecRegistry())
    .overrideProvider(ConnectivityProbe)
    .useValue(fakeProbe)
    .overrideProvider(MEMORY_SOURCES)
    .useValue(fakeMemorySources)
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

describe('GET /api/system/init-status（冷启动首屏的第一跳）', () => {
  it('全新平台：未初始化，且没有上次检测结果', async () => {
    const res = await request(app.getHttpServer()).get('/api/system/init-status').expect(200);
    expect(res.body).toMatchObject({ initialized: false });
    expect(res.body.lastConnectivityCheck).toBeUndefined();
  });
});

describe('PUT /api/system/settings —— ⚠️ 只存配置、不放行', () => {
  it('存了代理，但 initialized 一个字都没动', async () => {
    // ⚠️ 这条是两个端点边界的落点。把「保存了代理」顺手当成「初始化完成」，
    //    运行期改一次代理就会悄悄重放一次初始化语义 —— 而没有任何东西会报错。
    const res = await request(app.getHttpServer())
      .put('/api/system/settings')
      .send({ proxyConfig: { httpProxy: 'http://proxy.corp:3128' } })
      .expect(200);
    expect(res.body.proxyConfig).toEqual({ httpProxy: 'http://proxy.corp:3128' });
    expect(res.body.initialized).toBe(false);

    const status = await request(app.getHttpServer()).get('/api/system/init-status').expect(200);
    expect(status.body.initialized).toBe(false);
  });

  it('⛔ 响应里没有口令 hash，只有「启没启用」', async () => {
    const res = await request(app.getHttpServer()).get('/api/system/settings').expect(200);
    expect(JSON.stringify(res.body)).not.toContain('Hash');
    expect(res.body).toHaveProperty('accessPasscodeEnabled');
    expect(res.body.version.platform).toBeTypeOf('string');
  });

  it('null 是清空，缺席是不改', async () => {
    const cleared = await request(app.getHttpServer())
      .put('/api/system/settings')
      .send({ proxyConfig: null })
      .expect(200);
    expect(cleared.body.proxyConfig).toBeUndefined();

    const untouched = await request(app.getHttpServer())
      .put('/api/system/settings')
      .send({ publicBaseUrl: 'https://platform.internal' })
      .expect(200);
    expect(untouched.body.publicBaseUrl).toBe('https://platform.internal');
    expect(untouched.body.proxyConfig).toBeUndefined();
  });
});

describe('POST /api/system/init —— 一次性、不幂等（P2-4）', () => {
  /**
   * ⭐ **两种 409 各自的码，是本组最容易全绿着出错的一对断言。**
   *
   * 这两条用例（本条与下面「已初始化再调」）此前都只断言 `code: 'INVALID_STATE'` ——
   * 于是**把两处 throw 的码互换，两条用例照样全绿**：它们各自都"完整"，合起来什么都没守住。
   * 而调用方要做的事恰好相反（放行进工作台 / 留在向导里），认错一次的样子就是
   * 一台没初始化的机器被放进了工作台。⇒ 两条各自钉死自己的码，且**互相点名对方**。
   */
  it('模型 API 全挂而未确认 ⇒ 409 `OFFLINE_NOT_ACKNOWLEDGED`，且**什么都没写**（sideEffectFree）', async () => {
    connectivity = OFFLINE;
    const res = await request(app.getHttpServer()).post('/api/system/init').send({}).expect(409);
    expect(res.body).toMatchObject({
      code: 'OFFLINE_NOT_ACKNOWLEDGED',
      retryable: false,
      sideEffectFree: true,
    });
    // ⛔ 这一条不许退化成「是个 409 就行」：`ALREADY_INITIALIZED` 也是 409，
    //    而它的含义（已经初始化过了 ⇒ 放行）在这里是句彻底的假话。
    expect(res.body.code).not.toBe('ALREADY_INITIALIZED');
    expect(res.body.message).toContain('离线');
    // ⚠️ 「零副作用」不能只写在信封里 —— 要真的没写。
    const status = await request(app.getHttpServer()).get('/api/system/init-status').expect(200);
    expect(status.body.initialized).toBe(false);
  });

  it('带 acknowledgeOffline ⇒ 放行（P21-8 §2「仍可[继续]」）', async () => {
    connectivity = OFFLINE;
    const res = await request(app.getHttpServer())
      .post('/api/system/init')
      .send({ acknowledgeOffline: true, proxyConfig: { httpsProxy: 'http://u:p@proxy.corp:3128' } })
      .expect(201);
    expect(res.body.initialized).toBe(true);
    expect(res.body.initializedAt).toBeTypeOf('string');
    // 附上这一轮的检测结果 —— 向导下次进来直接渲染它，不重跑。
    expect(res.body.lastConnectivityCheck).toHaveLength(3);
    expect(res.body.lastConnectivityCheckAt).toBeTypeOf('string');
  });

  it('已初始化再调 ⇒ 409 `ALREADY_INITIALIZED`，不是幂等 200', async () => {
    connectivity = ONLINE;
    const res = await request(app.getHttpServer()).post('/api/system/init').send({}).expect(409);
    expect(res.body.code).toBe('ALREADY_INITIALIZED');
    // ⛔ 与上面那条对偶：别退回「是个 409 就行」——两种 409 的处置相反。
    expect(res.body.code).not.toBe('OFFLINE_NOT_ACKNOWLEDGED');
    expect(res.body.message).toContain('PUT /api/system/settings');
    expect(res.body).toMatchObject({ retryable: false, sideEffectFree: true });
  });

  /**
   * ⭐ **同一台已初始化的机器 + 模型 API 全挂 ⇒ 仍然是 `ALREADY_INITIALIZED`。**
   *
   * 两个判定的**先后**也是契约的一部分：离线那道门排在「已初始化」之后的话，一台已经开好
   * 的离线平台重复调用会拿到 `OFFLINE_NOT_ACKNOWLEDGED`，前端于是把它留在向导里 ——
   * 而它明明早就初始化完了。这条用例把顺序钉住：单看上面两条，把 if 换个位置照样全绿。
   */
  it('已初始化 + 模型 API 全挂 ⇒ 仍是 `ALREADY_INITIALIZED`（已初始化的判定在前）', async () => {
    connectivity = OFFLINE;
    const res = await request(app.getHttpServer()).post('/api/system/init').send({}).expect(409);
    expect(res.body.code).toBe('ALREADY_INITIALIZED');
  });

  it('审计里有 system.initialized，且**代理凭证已脱敏**', async () => {
    const rows = app.get(AuditRepository).list({ category: 'system', limit: 50 });
    const initialized = rows.items.filter((e) => e.type === 'system.initialized');
    expect(initialized).toHaveLength(1);
    // 离线确认过 ⇒ warn（这是日后排查「为什么 Agent 用不了」的第一条线索）。
    expect(initialized[0]!.severity).toBe('warn');
    const serialized = JSON.stringify(initialized[0]!.detail);
    // ⛔ `http://u:p@proxy.corp:3128` 里的 userinfo 一个字都不许落库：
    //    log-redactor 认的是密钥形状、审计键名黑名单里也没有 httpsProxy，
    //    这条断言守的是那第三道防线（proxy-redaction.ts）。
    expect(serialized).not.toContain('u:p@');
    expect(serialized).toContain('proxy.corp:3128');
  });
});

describe('GET /api/system/resources（P1-9：磁盘是真实瓶颈）', () => {
  it('三条水位都带 level，磁盘量的是 DATA_ROOT 那个文件系统', async () => {
    const res = await request(app.getHttpServer()).get('/api/system/resources').expect(200);
    expect(res.body.cpu.cores).toBeGreaterThan(0);
    for (const key of ['cpu', 'ram', 'disk']) {
      expect(['ok', 'warn', 'critical']).toContain(res.body[key].level);
    }

    // ⛔ RAM 走**可用内存**，不是 os.freemem()。喂进去的样本真实占用约 59%：
    //    可用 = (43280 + 803419 + 20576) × 16384 = 13.23 GB / 32 GB ⇒ 已用 58.6%。
    //    出事那版会把同一台机器报成 96.3% / critical ⇒ 前端整页「资源耗尽，无法创建新 Task」。
    // ⚠️ 两个平台各喂了一份样本（darwin 的 vm_stat / linux 的 /proc/meminfo），
    //    所以**期望值必须跟着当前平台走**。本行此前只按 darwin 那份算 ⇒ macOS 上绿、
    //    Linux CI 上必红（实测 `expected 20468166656 to be 20150304768`）——一条
    //    「本地绿、CI 红」的断言，而它防的恰恰是跨平台读数错误本身。
    const TOTAL_MEM_BYTES = 34_359_738_368; // 32 GB —— 两份样本的 MemTotal/hw.memsize 一致
    const expectedAvailable =
      process.platform === 'linux'
        ? 13_565_988 * 1024 // readProcMeminfo 样本里的 MemAvailable
        : (43280 + 803419 + 20576) * 16384; // vm_stat 样本：free + inactive + speculative
    expect(res.body.ram.totalBytes).toBe(TOTAL_MEM_BYTES);
    expect(res.body.ram.usedBytes).toBe(TOTAL_MEM_BYTES - expectedAvailable);
    // ⚠️ 百分比也**从同一个 expectedAvailable 推**，不要再手抄一个字面量：
    //    上一轮只改了 expectedAvailable、把这行的 58.6 留着，于是 CI 又红一次
    //    （linux 样本算出来是 59.6）。两处手抄同一个事实，就会漏改其中一处。
    const expectedUsedPercent = ((TOTAL_MEM_BYTES - expectedAvailable) / TOTAL_MEM_BYTES) * 100;
    expect(res.body.ram.usedPercent).toBeCloseTo(expectedUsedPercent, 1);
    expect(res.body.ram.level).toBe('ok');
    expect(res.body.disk.totalBytes).toBeGreaterThan(0);
    expect(res.body.disk.reservedPercent).toBe(15);
    expect(res.body.retainedVolumes).toMatchObject({ count: 0, truncated: false });
    expect(res.body.activeTasks).toBeTypeOf('number');
  });
});

describe('GET /api/system/providers（运维看板，≠ GET /api/providers）', () => {
  it('三个扩展点各自列出来，且失败率无样本时缺席而不是 0%', async () => {
    const res = await request(app.getHttpServer()).get('/api/system/providers').expect(200);
    expect(res.body.providers.length).toBeGreaterThan(0);
    expect(res.body.runtimes.length).toBeGreaterThan(0);
    expect(res.body.imageSpecs.length).toBeGreaterThan(0);
    expect(res.body.healthWindowMs).toBe(3_600_000);
    const p = res.body.providers[0];
    // 七位能力全量下发（与 GET /api/providers 同一个形状，勿另造一套）。
    expect(Object.keys(p.capabilities)).toHaveLength(7);
    // ⚠️ `sampleSize: 0` 是「这一小时没人用过它」——**不是** 0% 失败率。
    expect(p.sampleSize).toBe(0);
    expect(p.recentFailureRate).toBeUndefined();
  });

  it('与 GET /api/providers 是两个端点，形状也不同（扁平数组 vs 信封）', async () => {
    const flat = await request(app.getHttpServer()).get('/api/providers').expect(200);
    expect(Array.isArray(flat.body)).toBe(true);
    expect(flat.body[0]).not.toHaveProperty('sampleSize');
  });
});

describe('POST /api/system/diagnose —— SSE 八项（02 §5.3）', () => {
  it('首帧按契约顺序列出八项，八项各出一帧，末帧汇总', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/system/diagnose')
      .send({})
      .expect(200)
      .expect('Content-Type', /text\/event-stream/);

    // 版本随头下发（SSE 上它是告知不是门）。
    expect(res.headers['x-schema-hash']).toBe('sb-diagnose-v1');
    // 反代缓冲会让「逐项出结果」这个唯一的产品要求当场失效，且只在生产上失效。
    expect(res.headers['x-accel-buffering']).toBe('no');

    const frames = parseSse(res.text);
    const start = frames.find((f): f is DiagnoseStartFrame => f.event === 'start')!;
    expect(frames[0]!.event).toBe('start');
    expect(start.checks.map((c) => c.id)).toEqual([...DIAGNOSE_CHECK_IDS]);
    expect(start.timeoutMs).toBe(5000);

    const checks = frames.filter((f): f is DiagnoseCheckFrame => f.event === 'check');
    expect(checks).toHaveLength(8);
    expect(new Set(checks.map((c) => c.id))).toEqual(new Set(DIAGNOSE_CHECK_IDS));
    // 每一项都必须给出一句能直接上 UI 的话。
    for (const c of checks) expect(c.summary.length).toBeGreaterThan(0);

    const done = frames.at(-1) as DiagnoseDoneFrame;
    expect(done.event).toBe('done');
    expect(done.okCount + done.infoCount + done.warnCount + done.failCount).toBe(8);
    // 并行 ⇒ 整轮 ≈ 最慢那项，绝不是八项累加（02 §5.3 订正的那一条）。
    expect(done.totalMs).toBeLessThan(8 * 5000);
  }, 30_000);

  it('第 ⑧ 项走完五步链到 staged（本仓真的备齐了预制镜像时的样子）', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/system/diagnose')
      .send({})
      .expect(200);
    const preset = parseSse(res.text)
      .filter((f): f is DiagnoseCheckFrame => f.event === 'check')
      .find((f) => f.id === 'preset-image')!;
    // 播种成功 ⇒ 前四步都过，链走到第 5 步。
    expect(preset.step).toBe('staged');
    // ⚠️ 第 5 步只可能是 ok（已铺开/问不出来）或 info（未铺开）—— **不可能是 warn/fail**。
    expect(['ok', 'info']).toContain(preset.status);
    expect(preset.errorCode).toBeUndefined();
  }, 30_000);

  it('端口那一项报得出**被谁占了**，而不只是「被占用」', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/system/diagnose')
      .send({})
      .expect(200);
    const port = parseSse(res.text)
      .filter((f): f is DiagnoseCheckFrame => f.event === 'check')
      .find((f) => f.id === 'port-conflict')!;
    // ⚠️ 本机端口状态因人而异，所以断言的是**这一项在每种结论下都说得出下一步**，
    //    而不是某个具体结论（那会让用例依赖跑测试的那台机器）。
    if (port.status === 'fail') {
      // P21-5 §9B：端口号 · 进程名与 pid · 平台原本要用它做什么，三样都要有。
      expect(port.summary).toMatch(/pid \d+/);
      expect(port.summary).toContain('平台 HTTP/WS 服务');
      expect(port.hint).toContain('lsof');
    } else {
      expect(['ok', 'warn', 'timeout']).toContain(port.status);
    }
  }, 30_000);
});

/** `event: x\ndata: {...}\n\n` → 帧数组。 */
function parseSse(body: string): DiagnoseServerFrame[] {
  return body
    .split('\n\n')
    .map((block) => /^data: (.*)$/m.exec(block)?.[1])
    .filter((d): d is string => d !== undefined && d !== '')
    .map((d) => JSON.parse(d) as DiagnoseServerFrame);
}
