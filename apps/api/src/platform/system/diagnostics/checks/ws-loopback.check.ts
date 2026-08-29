import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Inject, Injectable } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { CLOCK, type Clock } from '@platform/shared-kernel';
import { env } from '../../../config/env';
import type { DiagnoseCheck, DiagnoseCheckResult, DiagnoseContext } from './check.types';

/**
 * 诊断第 ⑥ 项：**WS 回环**。
 *
 * ── 它测的是 engine.io 握手，而不是建一条 socket.io 连接 ──────────────────────
 * ⚠️ 这个边界要写清楚，否则下一个人会以为它覆盖了它没覆盖的东西。它证明的是：
 * **平台自己的 HTTP 服务在回环地址上活着，且 socket.io 的传输端点真的挂上去了**
 * （`GET /socket.io/?EIO=4&transport=polling` 回 engine.io 的 open 包 `0{"sid":…}`）。
 * 它**不**证明某个 namespace 的握手能过 —— `/events`、`/terminal`、`/tasks` 三条都要
 * 过访问口令（11 §3.1），拿一次没有 cookie 的连接去试，失败是**正确**行为，而把那个
 * 失败报成「WS 回环不通」会在一台一切正常的机器上亮红灯。
 *
 * ⚠️ **为什么这一项仍然值得存在**：它抓的是 02 §5.3 说的那类情况 —— 「诊断要能在 WS
 * 本身出问题时使用」。adapter 没装上、端口被别的进程抢走、回环被防火墙拦掉，这三种
 * 都会让整个实时面板静默失灵（前端只看到无尽重连），而它们在这一项上会当场露出来。
 *
 * ⚠️ **端口取的是实际监听的那个，不是 `PORT` 配置值。** 测试里 `app.listen(0)` 拿的是
 * 随机端口；照着配置值去连会连到别人（或谁也连不上），于是这一项在测试环境里恒红 ——
 * 一个恒红的检查项等于没有检查项。
 */
@Injectable()
export class WsLoopbackCheck implements DiagnoseCheck {
  readonly id = 'ws-loopback' as const;
  readonly label = 'WS 回环';

  constructor(
    private readonly adapterHost: HttpAdapterHost,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async run(ctx: DiagnoseContext): Promise<DiagnoseCheckResult> {
    const port = this.listeningPort();
    if (port === null) {
      return {
        status: 'warn',
        summary: 'HTTP 服务尚未开始监听，无法做回环测试',
        hint: '平台仍在启动中时会出现这一项；稍后重新诊断',
      };
    }
    const started = this.clock.now().getTime();
    try {
      const body = await get(port, '/socket.io/?EIO=4&transport=polling', ctx);
      // engine.io v4 的 open 包以 `0{` 开头并带 sid。只判 HTTP 200 是不够的：
      // 一个把所有路径都回 200 的反代同样能骗过它。
      if (!/^0\{.*"sid"/.test(body.trim())) {
        return {
          status: 'fail',
          summary: `回环可达但 /socket.io/ 没有返回 engine.io 握手包（收到 ${body.slice(0, 40)}…）`,
          hint: '前面可能有反向代理没有透传 WebSocket/长轮询；确认它对 /socket.io/ 放行 Upgrade 与 Connection 头',
          detail: { port, sample: body.slice(0, 120) },
        };
      }
      return {
        status: 'ok',
        summary: `WS 传输端点在 127.0.0.1:${String(port)} 上应答正常（${String(this.clock.now().getTime() - started)}ms）`,
        detail: { port },
      };
    } catch (e) {
      return {
        status: 'fail',
        summary: `回环连接 127.0.0.1:${String(port)} 失败：${(e as Error).message} —— 实时推送（沙箱状态 / 终端 / 任务流）都会失灵`,
        hint: `确认平台自身端口可从本机访问：curl -sv http://127.0.0.1:${String(port)}/api/health`,
        detail: { port },
      };
    }
  }

  /** 实际监听端口；还没 listen 时回 `null`（而不是退回配置值去猜）。 */
  private listeningPort(): number | null {
    const server: unknown = this.adapterHost.httpAdapter?.getHttpServer() as unknown;
    const addr =
      server !== null && typeof server === 'object' && 'address' in server
        ? (server as { address(): AddressInfo | string | null }).address()
        : null;
    if (addr !== null && typeof addr === 'object' && typeof addr.port === 'number')
      return addr.port;
    return env.port > 0 ? env.port : null;
  }
}

function get(port: number, path: string, ctx: DiagnoseContext): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'GET' }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (body += c));
      res.on('end', () =>
        res.statusCode !== undefined && res.statusCode < 400
          ? resolve(body)
          : reject(new Error(`HTTP ${String(res.statusCode)}`)),
      );
    });
    req.setTimeout(ctx.timeoutMs, () =>
      req.destroy(new Error(`${String(ctx.timeoutMs)}ms 内无应答`)),
    );
    ctx.signal.addEventListener('abort', () => req.destroy(new Error('已取消')), { once: true });
    req.on('error', reject);
    req.end();
  });
}
