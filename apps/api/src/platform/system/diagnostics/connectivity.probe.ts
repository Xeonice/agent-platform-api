import http from 'node:http';
import tls from 'node:tls';
import { Injectable, Inject } from '@nestjs/common';
import { builtinImageRef, CLOCK, type Clock } from '@platform/shared-kernel';
import { parseImageRef, type ConnectivityResult, type ProxyConfig } from '@platform/contracts';
import { SystemSettingsService } from '../system-settings.service';

/**
 * 探测需要的**全部**：当前生效的代理是什么。
 *
 * ⚠️ 依赖声明成这个而不是 `SystemSettingsService` 本身，是因为它确实只用得上这一个读。
 * 收窄的直接好处在测试里：替身写 `{ proxyConfig: () => … }` 就够了，不必为了满足一个
 * 十来个方法的类去打 `as unknown as` 双重断言 —— 而那个断言一旦打下去，
 * **将来这个类改了签名，替身也不会红**。DI token 仍是那个类（`@Inject` 显式给出）。
 */
export interface ProxySource {
  proxyConfig(): ProxyConfig | undefined;
}

/**
 * 一个探测目标。
 *
 * ⚠️ **`host` 与 `port` 必须分开存**，这一位是 2026-08-28 实测踩出来的：`registryHostOf`
 * 曾经把 `localhost:5001/platform/sandbox:v2` 的第一段整个当主机名返回（`localhost:5001`），
 * 而 `tls.connect({host:'localhost:5001'})` 必然 `ENOTFOUND` ⇒ 一个 `curl` 得到 200 的、
 * 好好活着的本地 registry 被报成「不可达」，hint 还让用户去配一个**根本不需要的代理**。
 * **把好的东西报成坏的，比没有这项检查更糟。**
 */
interface Target {
  host: string;
  port: number;
  /**
   * 用 TLS 握手探（`true`），还是明文 HTTP 探 registry 的 `/v2/`（`false`）。
   *
   * ⚠️ **只有 loopback 才降级成明文。** Docker 自己的规则就是这条：`localhost` /
   * `127.0.0.0/8` / `::1` 默认按 insecure registry 对待，别的地址一律要 TLS。
   * ⛔ **不能因为「带了显式端口」就降级** —— `registry.corp:5000` 依然要 TLS，
   * 除非运维显式配了 insecure。为了让某一台机器变绿而把外部 registry 的 TLS 校验一起放掉，
   * 是「多报是撒谎」的那一侧：检查会在一个中间人面前照样报绿。
   */
  tls: boolean;
  modelApi: boolean;
  why: string;
}

/** 展示用的权威字符串：非默认端口要带出来，否则用户认不出说的是哪个 registry。 */
function labelOf(t: Pick<Target, 'host' | 'port' | 'tls'>): string {
  const defaultPort = t.tls ? 443 : 80;
  return t.port === defaultPort ? t.host : `${t.host}:${String(t.port)}`;
}

/**
 * loopback ⇒ ① 不走代理（代理修不了本机的东西，而且 loopback 本来就不该出网），
 * ② 允许明文（与 Docker 对 insecure registry 的默认口径一致）。
 */
function isLoopback(host: string): boolean {
  const h = host.toLowerCase();
  if (h === 'localhost' || h === '::1' || h === '[::1]') return true;
  if (h.endsWith('.localhost')) return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/**
 * 出网可达性探测 —— **`POST /api/system/init` 与 `POST /api/system/diagnose` 第 ⑤ 项
 * 共用的同一段代码**（10 §6.6：「出网检测复用 `/diagnose`」；P21-8 §2：「向导内的检测
 * 能力与 21-5 诊断复用同一后端接口」）。
 *
 * ⚠️ **共用不是省代码，是防两套结论。** 两份实现意味着向导说「通了」而诊断说「不通」，
 * 而用户没有任何办法判断该信哪一个 —— 他会得出「这平台的检测不准」，此后两个都不看。
 *
 * ── 探测方式：TLS 握手，不是 HTTP 请求 ──────────────────────────────────────
 * ⚠️ **刻意不发 HTTP 请求**。`GET https://api.anthropic.com/` 在网络完好时会返回 401 /
 * 404，把「连得上」与「HTTP 语义」搅在一起 —— 而且真发请求就要处理重定向、UA、限流。
 * 我们要回答的只有一件事：**这台机器能不能和那个主机建立加密连接**。TLS 握手成功
 * 就是那件事的充要证据，而且它比裸 TCP 更强：中间的透明代理/门户会接受 TCP 但握不出
 * 正确的证书链。
 *
 * ── 代理：走 CONNECT，不是「连上代理就算通」 ─────────────────────────────────
 * ⚠️ 配了代理时，**能连上代理**证明不了**能通过代理到达目标** —— 企业代理最常见的
 * 故障恰恰是「代理活着，但这个域名不在白名单/需要认证」。所以配了代理就发一次真的
 * `CONNECT host:443`，按它的状态码判定：200 才算通，407 要单说（那是**认证**问题，
 * 下一步是补 userinfo，不是改地址）。
 */
@Injectable()
export class ConnectivityProbe {
  constructor(
    @Inject(SystemSettingsService) private readonly settings: ProxySource,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * 探测清单。
   *
   * ⚠️ **镜像仓库那一条是从 `SANDBOX_DEFAULT_IMAGE` 推出来的，不是硬编码 `ghcr.io`。**
   * 离线/内网部署会把预制镜像推到自建 registry，此时去探 ghcr.io 探到的是一个与这台
   * 机器无关的结论：探通了不代表镜像拉得到，探不通也不代表拉不到 —— 两个方向都在撒谎。
   */
  targets(): Target[] {
    return [
      {
        host: 'api.anthropic.com',
        port: 443,
        tls: true,
        modelApi: true,
        why: 'claude-code 的模型 API',
      },
      { host: 'api.openai.com', port: 443, tls: true, modelApi: true, why: 'codex 的模型 API' },
      {
        ...registryTargetOf(builtinImageRef()),
        modelApi: false,
        why: '预制镜像所在的镜像仓库（由 SANDBOX_DEFAULT_IMAGE 推出）',
      },
    ];
  }

  /**
   * 跑一轮。`proxyOverride` 给 `/init` 用 —— 向导里用户刚填的代理**还没落库**，而
   * [重新检测] 要按他刚填的那份来测（P21-8 §2 Step 2）。缺省用库里存着的那份。
   */
  async run(opts: {
    timeoutMs: number;
    signal: AbortSignal;
    proxyOverride?: ProxyConfig;
  }): Promise<ConnectivityResult[]> {
    const proxy = opts.proxyOverride ?? this.settings.proxyConfig();
    return Promise.all(
      this.targets().map((t) => probeOne(t, proxy, opts.timeoutMs, opts.signal, this.clock)),
    );
  }
}

/**
 * 坐标 → 探测目标（host + port + 用不用 TLS）。
 *
 * ⚠️ **第一段有 `.` 或 `:` 才是 registry 权威部分**（`ghcr.io/x/y` / `localhost:5001/x`）；
 * 否则是 Docker Hub 的短名（`alpine:3.20` / `library/alpine`），实际 registry 是
 * `registry-1.docker.io` —— 把 `alpine` 当 host 去 DNS 解析必然失败，然后诊断会报
 * 「镜像仓库不可达」，而真正的问题是这个坐标压根不该被解析成主机名。
 *
 * ⚠️ **端口必须从权威部分里切出来，这是上面那条的另一半，而它漏掉过。**
 * `localhost:5001` 整个当主机名 ⇒ `ENOTFOUND` ⇒ 一个 200 的 registry 被报成不可达
 * （2026-08-28 实测）。两半是同一类错误：**把坐标的一段当成了它不是的东西**。
 */
export function registryTargetOf(ref: string): { host: string; port: number; tls: boolean } {
  const { name } = parseImageRef(ref.trim());
  const first = name.split('/')[0] ?? '';
  const isAuthority = first.includes('.') || first.includes(':') || first === 'localhost';
  const authority = isAuthority ? first : 'registry-1.docker.io';
  const { host, port } = splitHostPort(authority);
  const tls = !isLoopback(host);
  return { host, port: port ?? (tls ? 443 : 80), tls };
}

/** `host:port` / `host` / `[::1]:port` → 两半。端口缺席回 `null`（由调用方按 TLS 与否定默认值）。 */
function splitHostPort(authority: string): { host: string; port: number | null } {
  if (authority.startsWith('[')) {
    const close = authority.indexOf(']');
    const host = authority.slice(0, close + 1);
    const rest = authority.slice(close + 1);
    return { host, port: rest.startsWith(':') ? Number(rest.slice(1)) : null };
  }
  const colon = authority.lastIndexOf(':');
  if (colon < 0) return { host: authority, port: null };
  const port = Number(authority.slice(colon + 1));
  // 不是数字 ⇒ 那个冒号不是端口分隔符，整段都是 host。
  if (!Number.isInteger(port) || port <= 0) return { host: authority, port: null };
  return { host: authority.slice(0, colon), port };
}

/**
 * 探一个目标。
 *
 * ⚠️ **导出是为了让测试探得动一个目标而不是三个。** `run()` 会把模型 API 一起探，
 * 那意味着任何一条针对 registry 的用例都要**真的出网** —— 慢（3×TLS 往返）、
 * 而且让单测的结论取决于跑它的那台机器有没有网。这个 seam 让回环那几条用例
 * 完全跑在 127.0.0.1 上。
 */
export async function probeOne(
  target: Target,
  proxy: ProxyConfig | undefined,
  timeoutMs: number,
  signal: AbortSignal,
  clock: Clock,
): Promise<ConnectivityResult> {
  const label = labelOf(target);
  const proxyUrl = pickProxy(proxy, target);
  const started = clock.now().getTime();
  try {
    if (proxyUrl !== null) {
      await connectThroughProxy(proxyUrl, target, timeoutMs, signal);
    } else if (target.tls) {
      await tlsHandshake(target.host, target.port, timeoutMs, signal);
    } else {
      await registryV2Probe(target, timeoutMs, signal);
    }
    return {
      target: label,
      ok: true,
      latencyMs: clock.now().getTime() - started,
      modelApi: target.modelApi,
    };
  } catch (e) {
    return {
      target: label,
      ok: false,
      modelApi: target.modelApi,
      hint: hintFor(e as Error, target, proxyUrl !== null),
    };
  }
}

/**
 * 明文 registry 探测（**仅 loopback**）：`GET /v2/`。
 *
 * ⚠️ **不是裸 TCP connect。** 端口上有个 listener 只证明「有东西在」，而这一项要回答的是
 * 「预制镜像拉不拉得到」。`/v2/` 是 registry 自己为这件事准备的端点：
 *   · **200 或 401 都算通** —— 401 是「registry 在，只是要认证」，那与「registry 没起来」
 *     对用户是两件完全不同的事，把 401 判成不可达会让一个配了认证的本地 registry 常年报红；
 *   · 其它状态码 ⇒ 端口上有东西但它不像 registry（很可能被别的进程占了），
 *     这个区分正是端口那一项之外我们唯一能给出的线索。
 */
function registryV2Probe(target: Target, timeoutMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: target.host, port: target.port, path: '/v2/', method: 'GET' },
      (res) => {
        res.resume();
        const code = res.statusCode ?? 0;
        if ((code >= 200 && code < 300) || code === 401) resolve();
        else
          reject(
            new Error(
              `${labelOf(target)}/v2/ 返回 HTTP ${String(code)} —— 端口上有服务在应答，但它不像一个镜像仓库`,
            ),
          );
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`${String(timeoutMs)}ms 内无应答`)));
    signal.addEventListener('abort', () => req.destroy(new Error('已取消')), { once: true });
    req.on('error', reject);
    req.end();
  });
}

/**
 * 建议文案 —— 按**用户下一步要做什么**分岔，而不是按错误类型堆术语。
 *
 * ⚠️ 「代理返回 407」与「DNS 解析不了」都是 `ok:false`，但一个要补口令、一个要配代理。
 * 一句「网络不通」把两者说成一件事，用户只能靠猜。
 */
function hintFor(e: Error, target: Target, viaProxy: boolean): string {
  const msg = e.message;
  const label = labelOf(target);
  // ⛔ **loopback 永远不要提代理。** 代理修不了本机上没起来的东西，而这条错误建议正是
  //    2026-08-28 实测那次的第二半伤害：诊断不但把一个好的 registry 报成坏的，还把用户
  //    支去配一个根本不需要的代理。「说错下一步比不说更贵」。
  //
  // ⛔ **也不要无条件说 `docker run`**（2026-09-05 实测补的第二条）。这一项本身是对的
  //    —— 微 VM 档（boxlite）确实要这个本地 HTTP 镜像站（`boxlite-runtime.ts`：BoxLite
  //    自己的 store 没有断点续传，十几 GB 的预制镜像靠它中转）。但在「mac + boxlite +
  //    没装 docker」下，一条只给 `docker run` 的建议**执行不了**，还会让人以为平台依赖
  //    docker —— 而 boxlite 官方明确写着不需要（"no root, no background service"）。
  //    这一条躲过了「支去配代理」，却掉进了同一个坑的另一半：**支去装 docker**。
  // ⇒ 文案要回答三件事：**谁**要它、**为什么**要、以及一条**不依赖 docker** 的路。
  if (isLoopback(target.host)) {
    return (
      `本机 registry ${label} 没有应答（${msg}）。它是**微 VM 档（boxlite）**用来中转大镜像的本地镜像站` +
      `（BoxLite 自己的镜像库不支持断点续传）—— ⛔ 平台本身不需要 Docker。三条路任选：` +
      `① 起任意一个 OCI registry 监听 ${String(target.port)}（zot 是单个二进制，不必有 docker）；` +
      `② 有 docker 就一条命令：docker run -d -p ${String(target.port)}:5000 --name registry registry:2；` +
      `③ 把 SANDBOX_DEFAULT_IMAGE 指向一个已经可达的仓库（公网也行，如 ghcr.io/agent-infra/sandbox:latest）。` +
      `⚠️ 这一项与代理无关 —— loopback 不出网`
    );
  }
  if (msg.includes('407')) {
    return `代理要求认证（407）。在代理地址里带上凭证：http://用户名:口令@代理主机:端口（${target.why}）`;
  }
  if (viaProxy) {
    return `代理无法到达 ${label}（${target.why}）：${msg}。确认代理白名单放行了该域名，或把它加进 NO_PROXY 走直连`;
  }
  if (msg.includes('ENOTFOUND') || msg.includes('EAI_AGAIN')) {
    return `DNS 解析不了 ${target.host}（${target.why}）。内网环境通常要配代理：在初始化向导 / 系统设置里填 HTTP_PROXY / HTTPS_PROXY`;
  }
  return `无法连接 ${label}（${target.why}）：${msg}。出网需代理时在系统设置里填 HTTPS_PROXY 后重试`;
}

/**
 * 这个目标该不该走代理，走哪一个。
 *
 * ⚠️ **loopback 一律直连。** 把 `localhost:5001` 送进企业代理，代理只会回一个它自己的
 * 错误页 —— 又一次「好的东西被报成坏的」。
 *
 * ⚠️ **`noProxy` 此前是「存了但完全没人读」。** 那本身就是一种撒谎：设置页收下了用户填的
 * 排除清单，探测却照样把内网地址送进代理，于是「配了 NO_PROXY 还是报不通」查无可查。
 * 存了就要用。
 *
 * https 优先、退回 http —— `CONNECT` 隧道本身走的是明文 HTTP，两个变量都可能承载它。
 */
function pickProxy(proxy: ProxyConfig | undefined, target: Target): URL | null {
  if (isLoopback(target.host)) return null;
  if (matchesNoProxy(target.host, proxy?.noProxy)) return null;
  const raw = (proxy?.httpsProxy ?? proxy?.httpProxy ?? '').trim();
  if (raw === '') return null;
  try {
    return new URL(raw.includes('://') ? raw : `http://${raw}`);
  } catch {
    return null;
  }
}

/**
 * `NO_PROXY` 的匹配口径，按事实上的通行约定：逗号分隔；`*` = 全部直连；
 * `.corp` / `corp` 都匹配 `a.corp` 与 `corp` 本身；条目可带端口，端口部分在这里忽略
 * （我们只按主机名判断）。
 */
export function matchesNoProxy(host: string, noProxy: string | undefined): boolean {
  const raw = (noProxy ?? '').trim();
  if (raw === '') return false;
  const h = host.toLowerCase();
  for (const entry of raw.split(',')) {
    const e = entry.trim().toLowerCase().split(':')[0] ?? '';
    if (e === '') continue;
    if (e === '*') return true;
    const bare = e.startsWith('.') ? e.slice(1) : e;
    if (h === bare || h.endsWith(`.${bare}`)) return true;
  }
  return false;
}

function tlsHandshake(
  host: string,
  port: number,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    // ⚠️ 端口来自坐标，**不是硬编码 443**：内网 registry 常年跑在 5000/5001 上，
    //    写死 443 会让它们全部报不可达（2026-08-28 实测的三重叠加之一）。
    const socket = tls.connect({ host, port, servername: host }, () => {
      socket.destroy();
      resolve();
    });
    const fail = (e: Error): void => {
      socket.destroy();
      reject(e);
    };
    socket.setTimeout(timeoutMs, () => fail(new Error(`${String(timeoutMs)}ms 内未完成 TLS 握手`)));
    socket.on('error', fail);
    signal.addEventListener('abort', () => fail(new Error('已取消')), { once: true });
  });
}

function connectThroughProxy(
  proxy: URL,
  target: Target,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (proxy.username !== '' || proxy.password !== '') {
      const raw = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`;
      headers['Proxy-Authorization'] = `Basic ${Buffer.from(raw).toString('base64')}`;
    }
    const req = http.request({
      host: proxy.hostname,
      port: Number(proxy.port || (proxy.protocol === 'https:' ? 443 : 80)),
      method: 'CONNECT',
      path: `${target.host}:${String(target.port)}`,
      headers,
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`${String(timeoutMs)}ms 内代理未应答`)));
    signal.addEventListener('abort', () => req.destroy(new Error('已取消')), { once: true });
    req.on('error', reject);
    req.on('connect', (res, socket) => {
      socket.destroy();
      // ⚠️ 状态码要**原样带进 message**：407 与 502 的下一步不同（见 `hintFor`）。
      if (res.statusCode === 200) resolve();
      else
        reject(new Error(`代理返回 ${String(res.statusCode)} ${res.statusMessage ?? ''}`.trim()));
    });
    req.end();
  });
}
