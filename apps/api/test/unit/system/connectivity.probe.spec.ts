import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import type { Clock } from '@platform/shared-kernel';
import type { ConnectivityResult, ProxyConfig } from '@platform/contracts';
import {
  ConnectivityProbe,
  matchesNoProxy,
  probeOne,
  registryTargetOf,
  type ProxySource,
} from '../../../src/platform/system/diagnostics/connectivity.probe';

const clock: Clock = { now: () => new Date(1_700_000_000_000) };

/**
 * 出网探测（诊断第 ⑤ 项 / `POST /api/system/init` 共用）。
 *
 * ⚠️ **本组的起因是一次「把好的东西报成坏的」**（2026-08-28 实测）：本机 `localhost:5001`
 * 上的 registry `curl` 返回 200，诊断却报「不可达」，hint 还让用户去配一个根本不需要的代理。
 * 根因是三重叠加，下面三组分别钉住其中一条 —— 只修其中任何两条，剩下那条仍然会让这个
 * registry 报红。
 */
describe('registryTargetOf —— 坐标拆成 host / port / 要不要 TLS', () => {
  it('⚠️ 带端口的权威部分必须拆开（本次事故的第 1 条）', () => {
    // `localhost:5001` 整个当主机名 ⇒ tls.connect 必然 ENOTFOUND。
    expect(registryTargetOf('localhost:5001/platform/sandbox:v2')).toEqual({
      host: 'localhost',
      port: 5001,
      tls: false,
    });
  });

  it('⚠️ 端口要真的用上，不是硬编码 443（第 2 条）', () => {
    expect(registryTargetOf('127.0.0.1:5001/x').port).toBe(5001);
    expect(registryTargetOf('registry.corp:5000/a/b:v1').port).toBe(5000);
  });

  it('⚠️ loopback 才降级成明文（第 3 条）—— 本地 registry 是 HTTP', () => {
    expect(registryTargetOf('localhost:5001/x').tls).toBe(false);
    expect(registryTargetOf('127.0.0.1:5001/x').tls).toBe(false);
    expect(registryTargetOf('127.5.5.5:5001/x').tls).toBe(false);
    expect(registryTargetOf('[::1]:5001/x')).toEqual({ host: '[::1]', port: 5001, tls: false });
  });

  it('⛔ **外部 registry 不因为带端口就降级 TLS** —— 别为了让本机变绿而放掉校验', () => {
    // registry.corp:5000 依然要 TLS（Docker 也是这个口径：非 loopback 一律 TLS，
    // 除非运维显式配 insecure）。降级掉的话，检查会在一个中间人面前照样报绿。
    expect(registryTargetOf('registry.corp:5000/a/b:v1').tls).toBe(true);
    expect(registryTargetOf('ghcr.io/x/y:latest')).toEqual({
      host: 'ghcr.io',
      port: 443,
      tls: true,
    });
  });

  it('Docker Hub 短名不当主机名（原有的另一半，别改回去）', () => {
    expect(registryTargetOf('alpine:3.20').host).toBe('registry-1.docker.io');
    expect(registryTargetOf('library/alpine:3.20').host).toBe('registry-1.docker.io');
  });
});

describe('matchesNoProxy —— 存了就要用', () => {
  it('后缀与本身都匹配，`.` 前缀可选', () => {
    expect(matchesNoProxy('a.corp', '.corp')).toBe(true);
    expect(matchesNoProxy('a.corp', 'corp')).toBe(true);
    expect(matchesNoProxy('corp', '.corp')).toBe(true);
    expect(matchesNoProxy('evilcorp', '.corp')).toBe(false);
  });
  it('多值 / 带端口 / 通配', () => {
    expect(matchesNoProxy('registry.internal', 'localhost,.internal')).toBe(true);
    expect(matchesNoProxy('registry.internal', 'registry.internal:5000')).toBe(true);
    expect(matchesNoProxy('anything.example', '*')).toBe(true);
    expect(matchesNoProxy('a.corp', '')).toBe(false);
  });
});

/** 一台**只在回环上**的假 registry —— 整组测试不碰外网。 */
let server: http.Server | undefined;
function startRegistry(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void) {
  return new Promise<number>((resolve) => {
    server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve((server!.address() as AddressInfo).port));
  });
}
afterEach(() => {
  server?.close();
  server = undefined;
});

/**
 * 只探 registry 那一个目标。
 *
 * ⚠️ 刻意**不走 `probe.run()`** —— 它会把两个模型 API 一起探，于是一条本该跑在
 * 127.0.0.1 上的用例变成一次真实出网：慢，而且结论取决于跑它的机器有没有网。
 */
function probeRegistry(proxy?: ProxyConfig): Promise<ConnectivityResult> {
  const settings: ProxySource = { proxyConfig: () => proxy };
  const probe = new ConnectivityProbe(settings, clock);
  const target = probe.targets().find((t) => !t.modelApi)!;
  return probeOne(target, proxy, 3000, new AbortController().signal, clock);
}

describe('TLS 探测真的用坐标里的端口（不是硬编码 443）', () => {
  let tcp: net.Server | undefined;
  afterEach(() => {
    tcp?.close();
    tcp = undefined;
  });

  it('⛔ 拨的是 5001 那个端口 —— 硬编码 443 会让这条红', async () => {
    // ⚠️ 这条补的是一次**变异存活**：把 `tls.connect` 的 port 改回硬编码 443 之后，
    //    原有 12 条用例全绿 —— 因为回环那几条走的是明文 `/v2/` 分支，**一条都没碰
    //    TLS 分支**。而端口硬编码正是本次事故的第 2 条根因。
    //    做法：在随机端口上开一个**普通 TCP** 监听并记下连入次数。TLS 握手当然会失败
    //    （对面不是 TLS 服务端），但「有没有连到这个端口」是可以直接观测的事实。
    let connections = 0;
    const port = await new Promise<number>((resolve) => {
      tcp = net.createServer((sock) => {
        connections += 1;
        sock.destroy();
      });
      tcp.listen(0, '127.0.0.1', () => resolve((tcp!.address() as AddressInfo).port));
    });

    const target = {
      host: '127.0.0.1',
      port,
      tls: true, // 强制走 TLS 分支（正常情况下 loopback 会走明文，这里是为了钉住端口）
      modelApi: false,
      why: 'test',
    };
    const r = await probeOne(target, undefined, 3000, new AbortController().signal, clock);

    expect(r.ok).toBe(false); // 对面不是 TLS 服务端，握手失败是预期的
    expect(connections).toBe(1); // ← 真正的断言：我们拨到了这个端口
    expect(r.target).toBe(`127.0.0.1:${String(port)}`);
  });
});

describe('本地 registry 的真实回环探测（本次事故的回归测试）', () => {
  const saved = process.env.SANDBOX_DEFAULT_IMAGE;
  afterEach(() => {
    if (saved === undefined) delete process.env.SANDBOX_DEFAULT_IMAGE;
    else process.env.SANDBOX_DEFAULT_IMAGE = saved;
  });

  it('✅ /v2/ 回 200 的本地 registry ⇒ 可达（此前它被报成不可达）', async () => {
    const port = await startRegistry((req, res) => {
      res.writeHead(req.url === '/v2/' ? 200 : 404).end('{}');
    });
    process.env.SANDBOX_DEFAULT_IMAGE = `127.0.0.1:${String(port)}/platform/sandbox:v2`;
    const r = await probeRegistry();
    expect(r.ok).toBe(true);
    // 展示名要带端口，否则用户认不出说的是哪个 registry。
    expect(r.target).toBe(`127.0.0.1:${String(port)}`);
    expect(r.modelApi).toBe(false);
  });

  it('401 也算可达 —— 「要认证」与「没起来」是两件事', async () => {
    const port = await startRegistry((_req, res) => {
      res.writeHead(401).end('unauthorized');
    });
    process.env.SANDBOX_DEFAULT_IMAGE = `127.0.0.1:${String(port)}/x:v1`;
    const r = await probeRegistry();
    expect(r.ok).toBe(true);
  });

  it('端口上有东西但不是 registry ⇒ 说清楚是这种情况', async () => {
    const port = await startRegistry((_req, res) => {
      res.writeHead(404).end('nope');
    });
    process.env.SANDBOX_DEFAULT_IMAGE = `127.0.0.1:${String(port)}/x:v1`;
    const r = await probeRegistry();
    expect(r.ok).toBe(false);
    expect(r.hint).toContain('docker run');
  });

  it('⛔ 本地 registry 没起来时 **hint 一个字都不许提代理**', async () => {
    // 拿一个刚关掉的端口 ⇒ ECONNREFUSED。
    const port = await startRegistry((_req, res) => res.end());
    server?.close();
    server = undefined;
    process.env.SANDBOX_DEFAULT_IMAGE = `127.0.0.1:${String(port)}/x:v1`;
    const r = await probeRegistry();
    expect(r.ok).toBe(false);
    // ⚠️ 这是事故的第二半伤害：把用户支去配一个根本不需要的代理。
    expect(r.hint).not.toContain('HTTPS_PROXY');
    expect(r.hint).not.toContain('HTTP_PROXY');
    expect(r.hint).toContain('loopback 不出网');
  });

  it('⛔ 配了代理也不许把 loopback 送进代理', async () => {
    const port = await startRegistry((req, res) => {
      res.writeHead(req.url === '/v2/' ? 200 : 404).end('{}');
    });
    process.env.SANDBOX_DEFAULT_IMAGE = `127.0.0.1:${String(port)}/x:v1`;
    // 一个**不存在**的代理：只要走了它，这次探测必然失败。
    const r = await probeRegistry({ httpsProxy: 'http://127.0.0.1:9/' });
    expect(r.ok).toBe(true);
  });
});
