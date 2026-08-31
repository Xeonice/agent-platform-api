import { lookup } from 'node:dns/promises';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ACCESS_GATE_READER } from '@platform/contracts';
import type { AccessGateReader } from '@platform/contracts';
import { judge, parseWebhookUrl } from '../../domain/services/ssrf.policy';
import { AutomationInvariantError } from '../../domain/errors/automation-errors';
import type {
  WebhookDeliveryResult,
  WebhookPayload,
  WebhookSender,
  WebhookTestOutcome,
} from '../../domain/ports/webhook-sender.port';

/** 03 §8.5「投递纪律」：10s 超时；失败重试 2 次（指数退避 5s / 25s）后放弃。 */
/** 手动跟随的跳数上限。⛔ 每一跳都要重新过 SSRF 判定，见 `post()`。 */
const MAX_REDIRECTS = 3;

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

const TIMEOUT_MS = 10_000;
const BACKOFF_MS = [5_000, 25_000] as const;

/**
 * `automation.webhook.allowPrivateNetwork`（03 §8.5）—— **默认 true**。
 * 私有化部署里内网 webhook 是主要用法。
 */
function allowPrivateNetwork(): boolean {
  return process.env.AUTOMATION_WEBHOOK_ALLOW_PRIVATE_NETWORK !== '0';
}

/**
 * 出站 webhook（03 §8.5）。
 *
 * ⚠️ **`deliver` 永不抛**（见端口注释）。整个方法体是一个大 try —— 通知是旁路，
 * 一次投递失败绝不该把一次成功的自动化记成失败。
 */
@Injectable()
export class HttpWebhookSender implements WebhookSender {
  private readonly logger = new Logger('WebhookSender');

  constructor(@Optional() @Inject(ACCESS_GATE_READER) private readonly gate?: AccessGateReader) {}

  async deliver(url: string, payload: WebhookPayload): Promise<WebhookDeliveryResult> {
    try {
      await this.assertSendable(url);
    } catch (e) {
      this.logger.warn(`webhook refused before sending: ${(e as Error).message}`);
      // `skipped` 而不是 `failed`：没有发出去过的东西不算投递失败，而这个区分正是
      // 用户排障时第一件要知道的事（「是我地址填错了」还是「对面没回」）。
      return 'skipped';
    }

    for (let attempt = 0; attempt <= BACKOFF_MS.length; attempt += 1) {
      const outcome = await this.post(url, payload);
      if (outcome.ok) return 'sent';
      if (attempt === BACKOFF_MS.length) {
        this.logger.warn(`webhook to ${redact(url)} gave up after 3 attempts: ${outcome.message}`);
        return 'failed';
      }
      await sleep(BACKOFF_MS[attempt]);
    }
    /* c8 ignore next */
    return 'failed';
  }

  async test(url: string): Promise<WebhookTestOutcome> {
    try {
      await this.assertSendable(url);
    } catch (e) {
      const code = e instanceof SsrfRefusal ? 'HOST_NOT_ALLOWED' : 'VALIDATION_FAILED';
      return { ok: false, errorCode: code, message: (e as Error).message };
    }
    // ⚠️ **测试连接只发一次，不走 deliver 的两次退避重试**：那是 40 秒，而这里的
    // 调用方是一个在等 [测试连接] 转圈的人。
    const outcome = await this.post(url, testPayload());
    if (outcome.ok) return { ok: true, message: `目标返回 ${String(outcome.status ?? 200)}` };
    return {
      ok: false,
      errorCode: outcome.timedOut ? 'TIMEOUT' : 'UPSTREAM_UNAVAILABLE',
      message: outcome.message,
    };
  }

  /**
   * 形状 + SSRF 谓词。**解析 DNS 之后判 IP**，不是看域名长什么样 —— 一个指向
   * `127.0.0.1` 的公网域名（`localtest.me` 之类）在域名上看不出任何问题。
   */
  private async assertSendable(url: string): Promise<void> {
    const parsed = parseWebhookUrl(url); // 抛 AutomationInvariantError（非 http/https）
    const opts = {
      allowPrivateNetwork: allowPrivateNetwork(),
      // 缺席按「没启用」读 —— 保守的那一边（见 ACCESS_GATE_READER 的端口注释）。
      accessGateEnabled: this.gate?.isEnabled() ?? false,
    };
    let addresses: { address: string }[];
    try {
      addresses = await lookup(parsed.hostname, { all: true });
    } catch {
      throw new AutomationInvariantError(`cannot resolve webhook host '${parsed.hostname}'`);
    }
    for (const { address } of addresses) {
      const verdict = judge(address, opts);
      // ⚠️ **任何一条解析结果被拒就整体拒**，不是「有一条能过就发」：一个域名同时
      // 解析出公网与环回地址时，连接实际走哪一条由 OS 决定，赌不得。
      if (verdict !== 'allow') {
        throw new SsrfRefusal(
          `webhook host '${parsed.hostname}' resolves to ${address}, refused by the SSRF policy ` +
            `(${verdict}). Private ranges are allowed only when the access passcode is enabled ` +
            `(11 §3.1 / 审计 P2-12).`,
        );
      }
    }
  }

  private async post(
    url: string,
    payload: WebhookPayload,
  ): Promise<{ ok: boolean; status?: number; message: string; timedOut?: boolean }> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, TIMEOUT_MS);
    try {
      // ⚠️⚠️ **`redirect: 'manual'` 不是可选项** —— 上一版没传，undici 默认 `follow`（20 跳），
      //   而 `assertSendable` 只查**原始 URL**：目标回一个
      //   `307 Location: http://169.254.169.254/...`，POST 连同 JSON body 会被原样重放到内网，
      //   SSRF 谓词形同虚设。实测复现过（307 → loopback，body 一字不差）。
      //   ⛔ 更糟的是 `POST /api/automations/webhook-test` 把它变成一个由公开 API 驱动的
      //   内网端口/服务扫描器 —— 调用方能从 `目标返回 ${status}` / `UPSTREAM_UNAVAILABLE`
      //   两种回答里读出内网某个地址通不通。
      //
      //   ⇒ 自己跟随，**每一跳都重新过一遍 SSRF 判定**。
      let target = url;
      let res: Response | undefined;
      for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
        res = await fetch(target, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
          signal: controller.signal,
          redirect: 'manual',
        });
        if (!isRedirect(res.status)) break;
        const location = res.headers.get('location');
        if (location === null || location === '') {
          return {
            ok: false,
            status: res.status,
            message: `目标返回 ${String(res.status)} 但没有 Location`,
          };
        }
        // 相对 Location 也要解析成绝对地址再判 —— `/x` 会落回同一个 host（那个已经过检了），
        // 但 `//evil.example.com/x` 是换 host，必须重新判。
        target = new URL(location, target).toString();
        await this.assertSendable(target);
      }
      if (res === undefined || isRedirect(res.status)) {
        return { ok: false, message: `重定向超过 ${String(MAX_REDIRECTS)} 跳，已放弃` };
      }
      return res.ok
        ? { ok: true, status: res.status, message: 'ok' }
        : { ok: false, status: res.status, message: `目标返回 HTTP ${String(res.status)}` };
    } catch (e) {
      const timedOut = controller.signal.aborted;
      return {
        ok: false,
        timedOut,
        message: timedOut ? `投递超时（${String(TIMEOUT_MS / 1000)}s）` : (e as Error).message,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

/** 与「URL 形状不对」分开的一类拒绝 —— 它决定了对外的 `errorCode`。 */
class SsrfRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SsrfRefusal';
  }
}

function testPayload(): WebhookPayload {
  return {
    event: 'test',
    automationId: 'test',
    automationName: '（测试连接）',
    projectId: 'test',
    projectName: '（测试连接）',
    runtimeId: 'test',
    triggeredAt: '1970-01-01T00:00:00.000Z',
    status: 'success',
  };
}

/** 日志里不带 query —— webhook URL 的 query 常常就是它的鉴权 token。 */
function redact(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return '(unparseable url)';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}
