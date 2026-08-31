import { AutomationInvariantError } from '../errors/automation-errors';

/**
 * SSRF 谓词的**纯函数那一半**（03 §8.5 「安全」行）。
 *
 * ⚠️ 拆成两半是刻意的：这里只回答「**这个 IP** 能不能发」，DNS 解析（IO）在
 * infrastructure 的 `WebhookSender` 里。分开之后 T-AUT-31 的四条断言全部是纯函数
 * 调用 —— 不需要起 DNS、不会因为跑测试的机器 resolv.conf 不同而飘。
 *
 * ── 判据（03 §8.5）─────────────────────────────────────────────────────────
 *   · 环回 `127.0.0.0/8`、`::1`                → **永远拒**
 *   · 链路本地 / 云元数据 `169.254.0.0/16`、`fe80::/10` → **永远拒**
 *   · 未指定 `0.0.0.0`、`::`                    → **永远拒**（等价于环回）
 *   · 私网 `10/8`、`172.16/12`、`192.168/16`、`fc00::/7` → **默认放行**
 *        私有化部署里内网 webhook 是主要用法。开关
 *        `automation.webhook.allowPrivateNetwork`（默认 true）。
 *   · 其余（公网）                              → 放行
 *
 * ★ **放行私网有前提（审计 P2-12）**：未启用访问口令时（11 §3.1），私网放行**自动
 * 降级为拒绝**。否则「能建规则的人」= 「能让平台向内网任意地址发 POST 的人」——
 * 一个没有门的部署里，这两者是同一群陌生人。
 */
export type SsrfVerdict = 'allow' | 'deny-loopback' | 'deny-link-local' | 'deny-private';

export interface SsrfPolicyOptions {
  /** `automation.webhook.allowPrivateNetwork`，默认 true。 */
  allowPrivateNetwork: boolean;
  /** 11 §3.1 的访问口令是否启用。false ⇒ 私网放行降级为拒绝。 */
  accessGateEnabled: boolean;
}

export function classifyAddress(ip: string): 'loopback' | 'link-local' | 'private' | 'public' {
  const v4 = parseIpv4(ip);
  if (v4 !== null) {
    const [a, b] = v4;
    if (a === 127 || a === 0) return 'loopback';
    if (a === 169 && b === 254) return 'link-local'; // 含 169.254.169.254 云元数据
    if (a === 10) return 'private';
    if (a === 172 && b >= 16 && b <= 31) return 'private';
    if (a === 192 && b === 168) return 'private';
    return 'public';
  }
  const v6 = ip
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .split('%')[0];
  if (v6 === '::1' || v6 === '::') return 'loopback';
  // IPv4-mapped (`::ffff:127.0.0.1`) 必须按它映射的 v4 判 —— 否则环回可以靠换个写法绕过。
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6);
  if (mapped) return classifyAddress(mapped[1]);
  if (/^fe[89ab][0-9a-f]:/.test(v6)) return 'link-local';
  if (/^f[cd][0-9a-f]{2}:/.test(v6)) return 'private'; // fc00::/7 ULA
  return 'public';
}

export function judge(ip: string, opts: SsrfPolicyOptions): SsrfVerdict {
  switch (classifyAddress(ip)) {
    case 'loopback':
      return 'deny-loopback';
    case 'link-local':
      return 'deny-link-local';
    case 'private':
      // 两个条件**都要**满足才放行：开关开着，且部署真的有门（P2-12）。
      return opts.allowPrivateNetwork && opts.accessGateEnabled ? 'allow' : 'deny-private';
    case 'public':
      return 'allow';
  }
}

/** URL 形状：只允许 http/https（I-AUT-6）。返回解析结果供调用方取 hostname。 */
export function parseWebhookUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AutomationInvariantError(
      `webhook url '${raw}' is not a valid absolute URL (I-AUT-6)`,
    );
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new AutomationInvariantError(
      `webhook url must use http or https, got '${url.protocol.replace(':', '')}' (I-AUT-6)`,
    );
  }
  return url;
}

function parseIpv4(ip: string): [number, number, number, number] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const parts = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])] as [
    number,
    number,
    number,
    number,
  ];
  return parts.every((p) => p >= 0 && p <= 255) ? parts : null;
}
