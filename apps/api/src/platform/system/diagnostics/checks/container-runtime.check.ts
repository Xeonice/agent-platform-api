import http from 'node:http';
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '@platform/shared-kernel';
import type { DiagnoseCheck, DiagnoseCheckResult, DiagnoseContext } from './check.types';

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
 */
@Injectable()
export class ContainerRuntimeCheck implements DiagnoseCheck {
  readonly id = 'container-runtime' as const;
  readonly label = '容器运行时可达';

  constructor(@Inject(CLOCK) private readonly clock: Clock) {}

  async run(ctx: DiagnoseContext): Promise<DiagnoseCheckResult> {
    const target = dockerTarget();
    const started = this.clock.now().getTime();
    try {
      const body = await ping(target, ctx);
      return {
        status: 'ok',
        summary: `容器运行时可达（${target.describe}，${String(this.clock.now().getTime() - started)}ms）`,
        detail: { endpoint: target.describe, response: body.slice(0, 32) },
      };
    } catch (e) {
      const reason = (e as Error).message;
      return {
        status: 'fail',
        summary: `容器运行时不可达：${target.describe} —— ${reason}`,
        // ⚠️ 建议要**按连接方式分岔**。socket 不存在时叫用户去改 DOCKER_HOST 是错的
        // （他大概率只是没起 docker）；而 tcp 不通时叫他 `systemctl start docker` 同样
        // 错（那台机器上根本没有 docker）。同一句话覆盖两种环境 = 对其中一种撒谎。
        hint:
          target.kind === 'unix'
            ? `确认 docker 守护进程在跑：docker info；socket 路径不是默认值时用 DOCKER_HOST=unix:///path/to/docker.sock 指过去（当前：${target.describe}）`
            : `确认 ${target.describe} 可达（docker-socket-proxy 起了没有、网络策略放行没有）：curl -s ${target.describe}/_ping`,
        detail: { endpoint: target.describe, kind: target.kind },
      };
    }
  }
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

function ping(target: DockerTarget, ctx: DiagnoseContext): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      target.kind === 'unix'
        ? { socketPath: target.socketPath, path: '/_ping', method: 'GET' }
        : { host: target.host, port: target.port, path: '/_ping', method: 'GET' },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => (body += c));
        res.on('end', () =>
          res.statusCode === 200
            ? resolve(body.trim())
            : reject(new Error(`/_ping 返回 HTTP ${String(res.statusCode)}`)),
        );
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
