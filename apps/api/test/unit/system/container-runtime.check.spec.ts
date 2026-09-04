import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import type { Clock } from '@platform/shared-kernel';
import type { ProviderRegistry } from '@platform/contracts';
import {
  ContainerRuntimeCheck,
  unreachableVerdict,
} from '../../../src/platform/system/diagnostics/checks/container-runtime.check';
import { substrateOf } from '../../../src/platform/system/diagnostics/checks/substrate';

const clock: Clock = { now: () => new Date(1_700_000_000_000) };
const ctx = { timeoutMs: 3000, signal: new AbortController().signal };

/** 只有 `defaultProvider` 会被读到。 */
function registryWithDefault(name: string): ProviderRegistry {
  return {
    register: () => undefined,
    get: () => {
      throw new Error('本项不该 get provider');
    },
    has: () => false,
    list: () => [],
    defaultProvider: name,
  };
}

/**
 * 一台只在回环上的假 daemon —— 整组测试不碰真的 docker。
 *
 * ⚠️ 走 `DOCKER_HOST=tcp://…` 而不是 unix socket：解析、`/_ping`、状态码与响应头校验
 * 是**同一段代码**，而 tcp 端口在任何平台上都起得来（CI 与开发机都能跑到）。
 */
let server: http.Server | undefined;
const savedHost = process.env.DOCKER_HOST;
function listen(handler: http.RequestListener): Promise<number> {
  return new Promise((resolve) => {
    server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve((server!.address() as AddressInfo).port));
  });
}
afterEach(() => {
  server?.close();
  server = undefined;
  if (savedHost === undefined) delete process.env.DOCKER_HOST;
  else process.env.DOCKER_HOST = savedHost;
});

/**
 * 诊断第 ① 项：**容器运行时可达**。
 *
 * ⚠️ 本组钉两件事，它们各自独立地会造成一个**假 ✅**（比报错更危险 —— 假 ✅ 让人完全
 * 不去查 docker）：
 *   ① 「socket 文件在 / connect 成功 / HTTP 200」都**不是**「daemon 活着」。docker 的
 *      `/_ping` 会带 `Api-Version` 响应头并回一行 `OK`，认这个才算 ✅；
 *   ② ❌ 的判据要挂在「**谁需要它**」上 —— 一台默认跑 boxlite 的 mac 上 docker 本来就
 *      不需要，报 ❌ 是在一个完全健康的部署上亮红灯，还会把用户支去装一个不需要的东西。
 */
describe('/_ping 要有 docker 的证据，不是「有东西回了 200」', () => {
  it('✅ 带 Api-Version 的 200 ⇒ ok，并把版本带进 detail', async () => {
    const port = await listen((req, res) => {
      if (req.url !== '/_ping') {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { 'Api-Version': '1.54', Server: 'Docker/29.5.3 (linux)' }).end('OK');
    });
    process.env.DOCKER_HOST = `tcp://127.0.0.1:${String(port)}`;

    const r = await new ContainerRuntimeCheck(clock, registryWithDefault('aio')).run(ctx);
    expect(r.status).toBe('ok');
    expect(r.detail?.apiVersion).toBe('1.54');
    expect(r.summary).toContain('Docker/29.5.3');
  });

  it('⛔ **200 但既没有 Api-Version 也不是 OK ⇒ 不算 ✅**（端口上坐着别的服务）', async () => {
    // 这条是本次的核心回归：一个「connect 成功 + 200」的假 ✅ 会让人完全不去查 docker。
    const port = await listen((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' }).end('<html>hello</html>');
    });
    process.env.DOCKER_HOST = `tcp://127.0.0.1:${String(port)}`;

    const r = await new ContainerRuntimeCheck(clock, registryWithDefault('aio')).run(ctx);
    expect(r.status).toBe('fail');
    expect(r.summary).toContain('不像一个容器运行时');
  });

  it('只回一行 OK（没有响应头）也算 ✅ —— 老版本 daemon / 代理会剥头', async () => {
    const port = await listen((_req, res) => {
      res.writeHead(200).end('OK');
    });
    process.env.DOCKER_HOST = `tcp://127.0.0.1:${String(port)}`;
    expect(
      (await new ContainerRuntimeCheck(clock, registryWithDefault('aio')).run(ctx)).status,
    ).toBe('ok');
  });

  it('非 200 ⇒ 不可达，并把状态码带出来', async () => {
    const port = await listen((_req, res) => {
      res.writeHead(500).end('boom');
    });
    process.env.DOCKER_HOST = `tcp://127.0.0.1:${String(port)}`;
    const r = await new ContainerRuntimeCheck(clock, registryWithDefault('aio')).run(ctx);
    expect(r.status).toBe('fail');
    expect(r.summary).toContain('500');
  });

  it('⛔ 端口在监听但**从不应答** ⇒ 不许挂着，也不许报 ✅', async () => {
    // 「Docker Desktop 停掉后 socket 文件还在」的等价形态：连得上，问不出话。
    const tcp = net.createServer(() => undefined);
    const port = await new Promise<number>((resolve) => {
      tcp.listen(0, '127.0.0.1', () => resolve((tcp.address() as AddressInfo).port));
    });
    process.env.DOCKER_HOST = `tcp://127.0.0.1:${String(port)}`;
    try {
      const r = await new ContainerRuntimeCheck(clock, registryWithDefault('aio')).run({
        timeoutMs: 300,
        signal: new AbortController().signal,
      });
      expect(r.status).toBe('fail');
      expect(r.summary).toContain('300ms 内无应答');
    } finally {
      tcp.close();
    }
  });

  it('连不上（端口刚关掉）⇒ 不可达', async () => {
    const port = await listen((_req, res) => res.end());
    server?.close();
    server = undefined;
    process.env.DOCKER_HOST = `tcp://127.0.0.1:${String(port)}`;
    const r = await new ContainerRuntimeCheck(clock, registryWithDefault('aio')).run(ctx);
    expect(r.status).toBe('fail');
    expect(r.summary).toContain('ECONNREFUSED');
  });
});

describe('不可达时的严重度 —— 挂在「谁需要它」上', () => {
  const endpoint = '/var/run/docker.sock';
  const reason = 'connect ECONNREFUSED /var/run/docker.sock';

  it('⛔ 默认档是微 VM（boxlite）⇒ **ℹ️，不是 ❌** —— 这台机器本来就不需要 docker', () => {
    const r = unreachableVerdict('micro-vm', 'boxlite', endpoint, reason);
    expect(r.status).toBe('info');
    expect(r.summary).toContain('不需要它');
    expect(r.summary).toContain('boxlite');
    // 建议仍要给（确实有人想用 aio 档），但**必须先说清默认档不需要它**，
    // 否则这条建议就成了「去装 docker」的又一个入口。
    expect(r.hint).toContain('只有显式选容器档');
  });

  it('默认档是容器档（aio）⇒ ❌，且说清它挡住了什么', () => {
    const r = unreachableVerdict('container', 'aio', endpoint, reason);
    expect(r.status).toBe('fail');
    expect(r.summary).toContain('挡住了新建任务');
    expect(r.hint).toContain('docker info');
  });

  it('⛔ 第三方 provider ⇒ ⚠️「不知道它要不要」，**不猜**', () => {
    const r = unreachableVerdict('unknown', 'my-cloud', endpoint, reason);
    expect(r.status).toBe('warn');
    expect(r.summary).toContain('无法断定');
  });

  it('三种底座的 status 两两不同（合并任意两种都会在这里红）', () => {
    const s = (['container', 'micro-vm', 'unknown'] as const).map(
      (k) => unreachableVerdict(k, 'p', endpoint, reason).status,
    );
    expect(new Set(s).size).toBe(3);
  });

  it('建议按连接方式分岔：unix 说 docker info，tcp 说 socket proxy', () => {
    expect(unreachableVerdict('container', 'aio', '/var/run/docker.sock', reason).hint).toContain(
      'docker info',
    );
    const tcp = unreachableVerdict('container', 'aio', 'tcp://docker-proxy:2375', reason).hint;
    expect(tcp).toContain('docker-socket-proxy');
    expect(tcp).not.toContain('docker info');
  });

  it('整条链路：默认档 boxlite + docker 不在 ⇒ 这一项报 ℹ️', async () => {
    const port = await listen((_req, res) => res.end());
    server?.close();
    server = undefined;
    process.env.DOCKER_HOST = `tcp://127.0.0.1:${String(port)}`;
    const r = await new ContainerRuntimeCheck(clock, registryWithDefault('boxlite')).run(ctx);
    expect(r.status).toBe('info');
    expect(r.detail?.defaultProvider).toBe('boxlite');
  });
});

describe('substrateOf —— 内置两个之外一律「不知道」', () => {
  it('aio 是容器，boxlite 是微 VM', () => {
    expect(substrateOf('aio')).toBe('container');
    expect(substrateOf('boxlite')).toBe('micro-vm');
  });

  it('⛔ 第三方 provider 不许猜成 container（那会让一台不需要 docker 的机器常年红）', () => {
    expect(substrateOf('my-cloud')).toBe('unknown');
    expect(substrateOf('')).toBe('unknown');
  });
});
