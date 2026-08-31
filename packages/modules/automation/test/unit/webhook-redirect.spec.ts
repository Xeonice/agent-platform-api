import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { networkInterfaces } from 'node:os';
import { HttpWebhookSender } from '../../src/infrastructure/webhook/http-webhook.sender';

/**
 * ⭐⭐ 重定向后的 SSRF 复检（2026-08-31，code review 实测复现后补）。
 *
 * 病灶：`assertSendable` 只查**原始 URL**，而 `fetch` 上一版没传 `redirect` ⇒ undici
 * 默认 `follow`（20 跳）。目标只要回一个 `307 Location: http://169.254.169.254/...`，
 * POST 连同 JSON body 就被原样重放进内网 —— SSRF 谓词形同虚设。
 * ⛔ `POST /api/automations/webhook-test` 更把它放大成一个由公开 API 驱动的内网扫描器。
 *
 * ⚠️ **这条用例必须真起服务器**：谓词是纯函数、早有测试且全绿，漏掉的恰恰是
 * 「fetch 到底跟不跟随」——只有真发一次请求才看得见。
 *
 * ⚠️ **第一跳必须落在一个能过谓词的地址上**，否则请求根本发不出去、跟不跟随都一样绿
 * （我第一版就是用 127.0.0.1 起的 redirector，`deny-loopback` 无条件拒绝，测了个寂寞）。
 * 环回是**无条件**拒的，私网只在 `allowPrivateNetwork + 口令已启用` 时放行 ⇒ 用本机私网网卡。
 */
function privateIpv4(): string | undefined {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const [x, y] = a.address.split('.').map(Number);
      if (x === 10) return a.address;
      if (x === 172 && y !== undefined && y >= 16 && y <= 31) return a.address;
      if (x === 192 && y === 168) return a.address;
    }
  }
  return undefined;
}

const HOST = privateIpv4();

describe.skipIf(HOST === undefined)('webhook 重定向：每一跳都要重新过 SSRF 判定', () => {
  let redirector: Server;
  let internal: Server;
  let internalHits = 0;
  let redirectTo = '';

  beforeEach(async () => {
    internalHits = 0;
    internal = createServer((_req, res) => {
      internalHits += 1;
      res.writeHead(200).end('internal');
    });
    await new Promise<void>((r) => internal.listen(0, '127.0.0.1', r));

    redirector = createServer((_req, res) => {
      res.writeHead(307, { location: redirectTo }).end();
    });
    await new Promise<void>((r) => redirector.listen(0, HOST, r));
  });

  afterEach(async () => {
    await new Promise<void>((r) => {
      redirector.close(() => {
        r();
      });
    });
    await new Promise<void>((r) => {
      internal.close(() => {
        r();
      });
    });
  });

  it('⭐⭐ 307 指向 loopback ⇒ 被复检拒绝，内网端点一次都没被打到', async () => {
    const internalPort = (internal.address() as AddressInfo).port;
    const redirectorPort = (redirector.address() as AddressInfo).port;
    redirectTo = `http://127.0.0.1:${String(internalPort)}/metadata`;

    process.env['AUTOMATION_WEBHOOK_ALLOW_PRIVATE_NETWORK'] = '1';
    const sender = new HttpWebhookSender({ isEnabled: () => true });
    const result = await sender.test(`http://${String(HOST)}:${String(redirectorPort)}/hook`);

    // ⭐ 主断言：跟随重定向时**内网端点绝不能被打到**。
    //   退回 `redirect: 'follow'` 这里就是 1。
    expect(internalHits).toBe(0);
    // 而且要如实回报成拒绝，不能悄悄当成功。
    expect(result.ok).toBe(false);
  });
});
