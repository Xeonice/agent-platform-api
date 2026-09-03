import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * `HttpWebhookSender` 的**投递语义**（03 §8.5）。
 *
 * ── 为什么要 mock DNS ────────────────────────────────────────────────────────
 * 这一层要验的是「**收到某个响应之后怎么办**」：3xx 算不算重定向、没有 Location 怎么
 * 回、跟随几跳、开关怎么读。要验它就得让请求**真的发出去**，于是需要一个既能 listen、
 * 又能过 SSRF 谓词的地址 —— 而环回是**无条件拒**的。
 *
 * `webhook-redirect.spec.ts` 用「本机私网网卡」解决它，代价是 `describe.skipIf`：
 * 没有 10/172.16/192.168 网卡的机器（CI 容器常常如此）上整组**静默跳过**。那条用例
 * 验的是 SSRF 复检本身，值得付这个代价；这里验的是重定向**分类**，不该也跟着跳过。
 *
 * ⇒ 这里改为把 `lookup` 换成替身：服务器仍然真起在 127.0.0.1 上真收请求，只是「这个
 * 主机名解析成什么地址」由用例说了算。**判定逻辑本身一行没动** —— 谓词吃的是替身给出
 * 的地址，所以「解析到私网/环回会怎样」在这里同样测得了，而且不再靠机器有什么网卡。
 *
 * ⛔ 但正因为 DNS 是替身，**「307 指向内网会不会被复检拦住」这条不在这里测** ——
 * 那条必须用真地址，见 `webhook-redirect.spec.ts`。两个文件不重合。
 */
const dns = vi.hoisted(() => ({ addresses: ['203.0.113.7'] }));
vi.mock('node:dns/promises', () => ({
  lookup: (_host: string) => Promise.resolve(dns.addresses.map((address) => ({ address }))),
}));

const { HttpWebhookSender } = await import('../../src/infrastructure/webhook/http-webhook.sender');

/** 一次请求的记录 —— 否定性断言的**正向执行证据**（29 §3.5.2）。 */
interface Hit {
  url: string;
  method: string;
  contentType: string | undefined;
  body: string;
}

let server: Server;
let hits: Hit[];
/** 用例装配的路由表：path → 这次要回什么。 */
let routes: Map<string, { status: number; location?: string }>;
let base: string;

beforeEach(async () => {
  hits = [];
  routes = new Map();
  dns.addresses = ['203.0.113.7'];
  process.env['AUTOMATION_WEBHOOK_ALLOW_PRIVATE_NETWORK'] = '1';
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      hits.push({
        url: req.url ?? '',
        method: req.method ?? '',
        contentType: req.headers['content-type'],
        body: Buffer.concat(chunks).toString('utf8'),
      });
      const route = routes.get(req.url ?? '') ?? { status: 200 };
      const headers: Record<string, string> =
        route.location === undefined ? {} : { location: route.location };
      res.writeHead(route.status, headers).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

afterEach(async () => {
  delete process.env['AUTOMATION_WEBHOOK_ALLOW_PRIVATE_NETWORK'];
  await new Promise<void>((r) => {
    server.close(() => {
      r();
    });
  });
});

const sender = (gateEnabled = true): InstanceType<typeof HttpWebhookSender> =>
  new HttpWebhookSender({ isEnabled: () => gateEnabled });

describe('哪些状态码算重定向（isRedirect）', () => {
  /**
   * ⭐ 用「3xx 但**没有** Location」当探针：两条分支给出的回答肉眼可分 ——
   *   算重定向 ⇒ `目标返回 3xx 但没有 Location`
   *   不算     ⇒ 走 `res.ok` 那一支，`目标返回 HTTP 3xx`
   * 而 `307/308` 恰恰是**保留方法与 body** 的两个，漏判它们等于 POST 连同 JSON
   * 被原样重放却不再过 SSRF 复检（03 §8.5 的整个防线就架在这个判断上）。
   */
  it.each([301, 302, 303, 307, 308])('%i 被判为重定向', async (status) => {
    routes.set('/hook', { status });
    const outcome = await sender().test(`${base}/hook`);

    expect(hits).toHaveLength(1); // 正向证据：请求真的发出去了
    expect(outcome).toEqual({
      ok: false,
      errorCode: 'UPSTREAM_UNAVAILABLE',
      message: `目标返回 ${String(status)} 但没有 Location`,
    });
  });

  it('2xx / 4xx 不是重定向：一跳就结束', async () => {
    routes.set('/ok', { status: 200 });
    routes.set('/created', { status: 201 });
    routes.set('/gone', { status: 404 });

    expect(await sender().test(`${base}/ok`)).toEqual({ ok: true, message: '目标返回 200' });
    // ⚠️ 回报的是**对面真正返回的那个码**，不是"成功就写 200"：接收端常用 201/202
    // 回执，用户拿这句话去和自己的服务端日志对号，写死一个 200 就对不上了。
    expect(await sender().test(`${base}/created`)).toEqual({ ok: true, message: '目标返回 201' });
    expect(await sender().test(`${base}/gone`)).toEqual({
      ok: false,
      errorCode: 'UPSTREAM_UNAVAILABLE',
      message: '目标返回 HTTP 404',
    });
    expect(hits).toHaveLength(3);
  });

  it('Location 是空串，与没有这个头一样处理', async () => {
    // 空 Location 若被当成「有」，`new URL('', target)` 会解析回自己 ⇒ 原地打转
    // 到跳数上限，用户拿到的是「重定向超过 3 跳」这种指错方向的诊断。
    routes.set('/hook', { status: 302, location: '' });
    const outcome = await sender().test(`${base}/hook`);

    expect(hits).toHaveLength(1);
    expect(outcome.message).toBe('目标返回 302 但没有 Location');
  });
});

describe('手动跟随重定向（redirect: manual）', () => {
  it('相对 Location 会被解析成绝对地址，并真的再发一次', async () => {
    routes.set('/hook', { status: 302, location: '/next' });
    routes.set('/next', { status: 200 });

    const outcome = await sender().test(`${base}/hook`);

    // ⭐ 正向证据：两跳都真的打到了服务器上，且第二跳落在相对 Location 指的路径。
    expect(hits.map((h) => h.url)).toEqual(['/hook', '/next']);
    expect(outcome).toEqual({ ok: true, message: '目标返回 200' });
  });

  it('跳数上限是 3 跳 —— 第 4 次响应仍是重定向就放弃', async () => {
    for (const p of ['/h0', '/h1', '/h2', '/h3', '/h4']) {
      routes.set(p, { status: 307, location: `/h${String(Number(p.slice(2)) + 1)}` });
    }
    const outcome = await sender().test(`${base}/h0`);

    // 初次 + 3 次跟随 = 4 个请求；多一个或少一个都说明上限读错了。
    expect(hits.map((h) => h.url)).toEqual(['/h0', '/h1', '/h2', '/h3']);
    expect(outcome).toEqual({
      ok: false,
      errorCode: 'UPSTREAM_UNAVAILABLE',
      message: '重定向超过 3 跳，已放弃',
    });
  });

  it('每一跳都是 POST + JSON，body 一字不差地重发', async () => {
    routes.set('/hook', { status: 308, location: '/next' });
    routes.set('/next', { status: 200 });
    await sender().test(`${base}/hook`);

    expect(hits).toHaveLength(2);
    for (const h of hits) {
      expect(h.method).toBe('POST');
      expect(h.contentType).toBe('application/json');
    }
    expect(hits[0].body).toBe(hits[1].body);
  });
});

describe('[测试连接] 发出去的载荷', () => {
  it('是一条完整的 test 事件，字段与真实投递同形', async () => {
    // 用户拿它当「我的接收端能不能解析」的验证，少一个字段就验了个假 —— 接真事件时
    // 才发现 `event` / `status` 根本没测过。
    routes.set('/hook', { status: 200 });
    await sender().test(`${base}/hook`);

    expect(hits).toHaveLength(1);
    expect(JSON.parse(hits[0].body)).toEqual({
      event: 'test',
      automationId: 'test',
      automationName: '（测试连接）',
      projectId: 'test',
      projectName: '（测试连接）',
      runtimeId: 'test',
      triggeredAt: '1970-01-01T00:00:00.000Z',
      status: 'success',
    });
  });
});

describe('SSRF 判定的三个输入：开关、访问口令、解析结果', () => {
  it('私网默认放行 —— 私有化部署里内网 webhook 是主要用法', async () => {
    dns.addresses = ['10.1.2.3'];
    delete process.env['AUTOMATION_WEBHOOK_ALLOW_PRIVATE_NETWORK'];
    routes.set('/hook', { status: 200 });

    const outcome = await sender(true).test(`${base}/hook`);
    expect(hits).toHaveLength(1); // 正向证据：确实发出去了
    expect(outcome.ok).toBe(true);
  });

  it("开关置 '0' ⇒ 私网转为拒绝，且一个请求都没发", async () => {
    dns.addresses = ['10.1.2.3'];
    process.env['AUTOMATION_WEBHOOK_ALLOW_PRIVATE_NETWORK'] = '0';

    const outcome = await sender(true).test(`${base}/hook`);
    expect(outcome).toMatchObject({ ok: false, errorCode: 'HOST_NOT_ALLOWED' });
    expect(hits).toHaveLength(0);
    // ⚠️ 只有 '0' 关；其它值（含空串）都按「开着」读，否则一个手滑的空环境变量
    // 就会把所有内网 webhook 静默关掉。
    process.env['AUTOMATION_WEBHOOK_ALLOW_PRIVATE_NETWORK'] = '';
    expect((await sender(true).test(`${base}/hook`)).ok).toBe(true);
    expect(hits).toHaveLength(1);
  });

  it('⭐ 没有访问口令的部署里，私网放行自动降级为拒绝（审计 P2-12）', async () => {
    dns.addresses = ['10.1.2.3'];
    // 门关着：能建规则的人 = 能让平台向内网任意地址 POST 的人。
    const closed = await sender(false).test(`${base}/hook`);
    expect(closed).toMatchObject({ ok: false, errorCode: 'HOST_NOT_ALLOWED' });
    expect(hits).toHaveLength(0);

    // ⭐ 同一个地址、同一个开关，只把门打开 ⇒ 就发得出去。这条是上面那条否定断言的
    //   执行证据：拒绝来自「门关着」，不是来自「请求根本构造不出来」。
    routes.set('/hook', { status: 200 });
    expect((await sender(true).test(`${base}/hook`)).ok).toBe(true);
    expect(hits).toHaveLength(1);
  });

  it('⭐ 缺 ACCESS_GATE_READER 时按「门没启用」读，而不是当成启用', async () => {
    // 端口是 @Optional 注入的，缺席在装配上完全合法 ⇒ 必须落在保守的那一边。
    dns.addresses = ['10.1.2.3'];
    const outcome = await new HttpWebhookSender().test(`${base}/hook`);
    expect(outcome).toMatchObject({ ok: false, errorCode: 'HOST_NOT_ALLOWED' });
    expect(hits).toHaveLength(0);
  });

  it('⭐ 一个域名解析出多条地址时，只要有一条被拒就整体拒', async () => {
    // 连接实际走哪一条由 OS 决定，赌不得。
    dns.addresses = ['203.0.113.7', '127.0.0.1'];
    const mixed = await sender().test(`${base}/hook`);
    expect(mixed).toMatchObject({ ok: false, errorCode: 'HOST_NOT_ALLOWED' });
    expect(hits).toHaveLength(0);

    // ⭐ 执行证据：把那条环回换成公网，同一个调用就发得出去 ⇒ 上面拦下它的是判定，
    //   不是「这个 URL 压根发不出去」。
    dns.addresses = ['203.0.113.7', '203.0.113.8'];
    routes.set('/hook', { status: 200 });
    expect((await sender().test(`${base}/hook`)).ok).toBe(true);
    expect(hits).toHaveLength(1);
  });

  it('URL 形状不对与 SSRF 拒绝是两个 errorCode —— 用户要能分清改哪里', async () => {
    const shape = await sender().test('ftp://example.com/hook');
    expect(shape).toMatchObject({ ok: false, errorCode: 'VALIDATION_FAILED' });

    dns.addresses = ['169.254.169.254']; // 云元数据端点
    const ssrf = await sender().test(`${base}/hook`);
    expect(ssrf).toMatchObject({ ok: false, errorCode: 'HOST_NOT_ALLOWED' });
    expect(hits).toHaveLength(0);
  });
});
