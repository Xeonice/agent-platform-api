import http from 'node:http';
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '@platform/shared-kernel';
import { SANDBOX_PROVIDER_REGISTRY } from '@platform/contracts';
import type { ProviderRegistry } from '@platform/contracts';
import type { DiagnoseCheck, DiagnoseCheckResult, DiagnoseContext } from './check.types';
import { defaultSubstrate, type Substrate } from './substrate';

/**
 * 诊断第 ① 项：**容器运行时可达**（P21-5 §3「✅ 容器运行时可达（aio）· socket proxy 可达」）。
 *
 * ⚠️ **为什么这里自己发一个 HTTP `/_ping`，而不是复用 `createDockerClient()`。**
 * 那个工厂住在 `packages/modules/sandbox/src/infrastructure/providers/docker/`，既没有从
 * `@platform/sandbox` 的公共出口导出，也**不该**为一次诊断而导出 —— 导出一个基础设施
 * 工厂等于把 dockerode 变成 `apps/api` 的依赖，而诊断需要的只是「这个 socket 上有没有
 * 一个 docker 在应答」。`/_ping` 是 docker 自己为这件事准备的端点，它返回一行 `OK`。
 *
 * ⚠️ **`DOCKER_HOST` 的三种写法必须都认**（与 `createDockerClient` 同源，shared/11 §1）：
 * 生产上它指向 docker-socket-proxy（`tcp://docker-proxy:2375`），而本机开发是 unix
 * socket。只认 socket 会让生产环境的诊断永远报「运行时不可达」——**在一个一切正常的
 * 部署上**，那比不做这项检查更糟。
 *
 * ── 本轮两处修改（2026-09-05 实测）────────────────────────────────────────────
 *
 * **① ✅ 必须有证据，不能只是「有东西回了 200」。**「socket 文件在」≠「daemon 活着」，
 * 而「200」也还差一步：那个 socket / 端口上可能坐着别的进程。docker 的 `/_ping` 会带
 * `Api-Version` 响应头并回一行 `OK` —— 认这两个之一才算 ✅，否则如实说「端口上有服务在
 * 应答，但它不像一个容器运行时」（与第 ⑤ 项 `/v2/` 那条「不像一个镜像仓库」同一口径）。
 * ⚠️ **一个假 ✅ 比报错更危险**：它让人完全不去查 docker。
 *
 * **② ❌ 的判据挂在「谁需要它」上，而不是无条件要求 docker 在。**
 * 默认档由 `hostPreferredProvider()` 按宿主定：`darwin ⇒ boxlite`。在一台 mac 上 boxlite
 * 走 Hypervisor.framework，**不需要 Docker、不需要守护进程**，此时报 ❌「容器运行时不可达」
 * 是在一个完全健康的部署上亮红灯，还会把用户支去装一个他根本不需要的东西。
 *   · 默认档就是容器档（aio）⇒ ❌，它真的挡住了开箱即用的那条路；
 *   · 默认档是微 VM 档（boxlite）⇒ ℹ️，如实说「当前默认档不需要它」；
 *   · 默认档是第三方 provider ⇒ ⚠️「不知道它要不要」—— 不猜（见 `substrateOf`）。
 */
@Injectable()
export class ContainerRuntimeCheck implements DiagnoseCheck {
  readonly id = 'container-runtime' as const;
  readonly label = '容器运行时可达';

  constructor(
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(SANDBOX_PROVIDER_REGISTRY) private readonly providers: ProviderRegistry,
  ) {}

  async run(ctx: DiagnoseContext): Promise<DiagnoseCheckResult> {
    const target = dockerTarget();
    const started = this.clock.now().getTime();
    try {
      const pong = await ping(target, ctx);
      const ms = String(this.clock.now().getTime() - started);
      return {
        status: 'ok',
        summary: `容器运行时可达（${target.describe}，${ms}ms${pong.server === null ? '' : ` · ${pong.server}`}）`,
        detail: {
          endpoint: target.describe,
          apiVersion: pong.apiVersion,
          server: pong.server,
          response: pong.body.slice(0, 32),
        },
      };
    } catch (e) {
      const reason = (e as Error).message;
      const { provider, substrate } = defaultSubstrate(this.providers);
      return {
        ...unreachableVerdict(substrate, provider, target.describe, reason),
        detail: { endpoint: target.describe, kind: target.kind, defaultProvider: provider },
      };
    }
  }
}

/**
 * 不可达时报多重 —— **完全由「当前默认档需不需要它」决定**。
 *
 * ⚠️ ℹ️ 那一支的 hint 要把「怎么装」也写出来（有人确实想用 aio 档），但**必须先说清
 * 默认档不需要它**，否则这条建议又会变成「去装 docker」的第四个入口。
 */
export function unreachableVerdict(
  substrate: Substrate,
  provider: string,
  endpoint: string,
  reason: string,
): Pick<DiagnoseCheckResult, 'status' | 'summary' | 'hint'> {
  const unix = !endpoint.startsWith('tcp://');
  // ⚠️ 建议要**按连接方式分岔**。socket 不存在时叫用户去改 DOCKER_HOST 是错的
  // （他大概率只是没起 docker）；而 tcp 不通时叫他 `systemctl start docker` 同样
  // 错（那台机器上根本没有 docker）。同一句话覆盖两种环境 = 对其中一种撒谎。
  const howToFix = unix
    ? `确认 docker 守护进程在跑：docker info；socket 路径不是默认值时用 DOCKER_HOST=unix:///path/to/docker.sock 指过去（当前：${endpoint}）`
    : `确认 ${endpoint} 可达（docker-socket-proxy 起了没有、网络策略放行没有）：curl -s ${endpoint}/_ping`;

  if (substrate === 'micro-vm') {
    return {
      status: 'info',
      summary:
        `${endpoint} 上没有容器运行时在应答（${reason}）—— ` +
        `**当前默认档 '${provider}' 是微 VM，不需要它**，这不挡任何默认路径`,
      hint: `只有显式选容器档（aio）的任务才用得上它；真要用就装好 docker 再重跑诊断（${howToFix}）`,
    };
  }
  if (substrate === 'unknown') {
    return {
      status: 'warn',
      summary:
        `${endpoint} 上没有容器运行时在应答（${reason}）—— ` +
        `当前默认档 '${provider}' 不是内置的 aio/boxlite，平台无法断定它要不要容器运行时`,
      hint: `若这个 provider 靠容器跑：${howToFix}；若不靠，这一项可以忽略`,
    };
  }
  return {
    status: 'fail',
    summary: `容器运行时不可达：${endpoint} —— ${reason}（当前默认档 '${provider}' 就是容器档，这一项挡住了新建任务）`,
    hint: howToFix,
  };
}

interface DockerTarget {
  kind: 'unix' | 'tcp';
  socketPath?: string;
  host?: string;
  port?: number;
  describe: string;
}

/** 与 `createDockerClient()` 同一套解析（shared/11 §1）——两处改动要同步。 */
function dockerTarget(): DockerTarget {
  const host = process.env.DOCKER_HOST;
  if (host && host.startsWith('tcp://')) {
    const url = new URL(host);
    const port = Number(url.port || 2375);
    return {
      kind: 'tcp',
      host: url.hostname,
      port,
      describe: `tcp://${url.hostname}:${String(port)}`,
    };
  }
  if (host && host.startsWith('unix://')) {
    const p = host.replace('unix://', '');
    return { kind: 'unix', socketPath: p, describe: p };
  }
  const p = process.env.DOCKER_SOCKET ?? '/var/run/docker.sock';
  return { kind: 'unix', socketPath: p, describe: p };
}

interface Pong {
  body: string;
  apiVersion: string | null;
  server: string | null;
}

/**
 * 真发一次 `GET /_ping` 并**验证应答确实来自 docker**。
 *
 * ⛔ 「connect 成功」不是结论，「HTTP 200」也还差一步。docker 的 `/_ping` 一定带
 * `Api-Version` 响应头（实测 `Api-Version: 1.54` + `Server: Docker/29.5.3 (linux)`）
 * 并回一行 `OK`；两者都没有的 200 说明这个 socket / 端口上坐着**别的**服务。
 */
function ping(target: DockerTarget, ctx: DiagnoseContext): Promise<Pong> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      target.kind === 'unix'
        ? { socketPath: target.socketPath, path: '/_ping', method: 'GET' }
        : { host: target.host, port: target.port, path: '/_ping', method: 'GET' },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => (body += c));
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(new Error(`/_ping 返回 HTTP ${String(res.statusCode)}`));
            return;
          }
          const apiVersion = headerOf(res, 'api-version');
          const server = headerOf(res, 'server');
          if (apiVersion === null && body.trim() !== 'OK') {
            reject(
              new Error(
                '/_ping 回了 200，但既没有 Api-Version 响应头也不是一行 OK —— 这个地址上有服务在应答，但它不像一个容器运行时',
              ),
            );
            return;
          }
          resolve({ body, apiVersion, server });
        });
      },
    );
    // 单项预算也压在这次 IO 上（见 `DiagnoseContext.timeoutMs` 的注释）：只靠外层
    // 竞速的话，socket 存在但守护进程不应答时这条连接会一直挂着。
    req.setTimeout(ctx.timeoutMs, () =>
      req.destroy(new Error(`${String(ctx.timeoutMs)}ms 内无应答`)),
    );
    ctx.signal.addEventListener('abort', () => req.destroy(new Error('已取消')), { once: true });
    req.on('error', (e) => reject(e));
    req.end();
  });
}

function headerOf(res: http.IncomingMessage, name: string): string | null {
  const v = res.headers[name];
  if (typeof v === 'string') return v;
  return Array.isArray(v) ? (v[0] ?? null) : null;
}
