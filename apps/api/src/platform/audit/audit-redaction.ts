import { redactLogLine } from '../logging';

/**
 * 审计 `detail` / `summary` 的**写入口**脱敏（13 §2.8.2「脱敏在写入口」/ 05 §4 /
 * P21-5 §10.5）。
 *
 * ⚠️ **为什么必须在写入口而不是读出口**：明文一旦落库，**导出、备份、DB 文件**三条路
 * 都漏，读出口脱敏只挡住第一条。
 *
 * 两层，缺一不可：
 *   ① **按值**：复用运行日志那一套正则（`redactLogLine`）—— 13 §2.8.2 写的「与 05 §4
 *      日志脱敏同源」就是这个意思，不是"另写一套差不多的"。
 *   ② **按键名**：值里看不出是密钥、但键名已经写明了的（`token` / `secret` /
 *      `password` / `apiKey` / `authorization` / …）。正则永远追不上"下一个格式的
 *      密钥"，键名可以。
 */

/**
 * 键名黑名单。命中即整值替换，**不看值长什么样**。
 *
 * ⚠️ `env` 在列上：04 §2.3★ 记着 agent 把 env 物化成 `export K=V` 拼进命令串、
 * 沙箱内 `ps` 全文可见 —— 所以审计**记 argv 形状、不记 env 值**（13 §2.8.2 对
 * `sandbox.probe` 的特别叮嘱）。写 `sandbox.probe` 的调用点本来就不该把 env 递进来，
 * 这一条是**结构上的兜底**：递进来了也落不进库。
 */
const SENSITIVE_WORDS = new Set([
  'env',
  'envs',
  'environ',
  'environment',
  'token',
  'tokens',
  'secret',
  'secrets',
  'password',
  'passwd',
  'passphrase',
  'passcode',
  'credential',
  'credentials',
  'authorization',
  'auth',
  'apikey',
  'privatekey',
  'signingkey',
  'cookie',
  'cookies',
]);

/**
 * 键名是否敏感。
 *
 * ⚠️ **必须拆 camelCase，不能只按 `._-` 分段。** 第一版写的是
 * `/(^|[._-])(token|secret|…)([._-]|$)/i`，它对 `access_token` 有效、对
 * **`accessToken` 无效** —— 而这个仓里的 detail 键名一律是 camelCase（DTO 风格
 * P1-5）。也就是说那一版在真实调用点上**一个都遮不住**，而测试如果只喂
 * `access_token` 就会全绿。
 *
 * 相邻两词再拼一次是为了 `apiKey` / `privateKey` 这类：单看 `api` / `key` 都不该
 * 触发（`{key: 'runtime'}` 是正当的 detail），拼起来才是密钥。
 */
function isSensitiveKey(key: string): boolean {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w !== '');
  if (words.some((w) => SENSITIVE_WORDS.has(w))) return true;
  for (let i = 0; i + 1 < words.length; i++) {
    if (SENSITIVE_WORDS.has(`${words[i]!}${words[i + 1]!}`)) return true;
  }
  return false;
}

/** 值被遮住时留下的占位。**不是空串** —— 「有这么个字段但被遮了」与「没有这个字段」不同。 */
export const REDACTED = '[redacted]';

/** 递归深度上限：detail 是结构化细节，不是任意深的对象图。超过即截断。 */
const MAX_DEPTH = 6;
/** 单个字符串值的长度上限 —— 探测输出的尾部若干行，不是整份日志（13 §2.8.2）。 */
const MAX_STRING = 4000;
/** 数组元素上限：一条审计不是一份清单。 */
const MAX_ARRAY = 200;

/**
 * 脱敏一段自由文本（`summary`，以及 detail 里的字符串值）。
 */
export function redactAuditText(text: string): string {
  const redacted = redactLogLine(text);
  return redacted.length > MAX_STRING ? `${redacted.slice(0, MAX_STRING)}…[truncated]` : redacted;
}

/**
 * 脱敏整个 `detail`。返回**新对象**，不改调用方递进来的那个 —— 调用方可能还要用它
 * 去打日志或做别的判断，就地改会变成一次远程作用。
 */
export function redactAuditDetail(
  detail: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (detail === undefined) return undefined;
  const out = redactValue(detail, 0, false);
  // redactValue 对 plain object 一定回 object；这个分支只为收窄类型。
  return typeof out === 'object' && out !== null && !Array.isArray(out)
    ? (out as Record<string, unknown>)
    : undefined;
}

/**
 * 命令行键名。命中时值走 `probeArgvShape` 而不是普通字符串脱敏。
 *
 * ⚠️ **这条规则不可省，普通字符串脱敏挡不住它要挡的东西。** `redactLogLine` 认的是
 * *密钥的形状*（`sk-ant-…` / `ghp_…` / `Authorization: Bearer …`）；而 04 §2.3★ 记着
 * agent 把 env 物化成 `export K=V` 拼进命令串 —— 一个自建网关的 token、一个内网地址、
 * 一个用户自己起名的变量，**都不长得像密钥**，正则一个都不会遮。所以命令行按**形状**
 * 记：可执行名 + 旗标名保留，实参一律 `<arg>`。
 */
const ARGV_KEY_RE = /^(argv|cmd|command|args)$/i;

function redactValue(value: unknown, depth: number, keyIsSensitive: boolean): unknown {
  if (keyIsSensitive) return REDACTED;
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactAuditText(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Date) return value.toISOString();
  if (depth >= MAX_DEPTH) return '[depth-limit]';
  if (Array.isArray(value)) {
    const head = value.slice(0, MAX_ARRAY).map((v) => redactValue(v, depth + 1, false));
    return value.length > MAX_ARRAY
      ? [...head, `…+${String(value.length - MAX_ARRAY)} more`]
      : head;
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (ARGV_KEY_RE.test(k) && !isSensitiveKey(k)) {
        out[k] = shapeCommandValue(v);
        continue;
      }
      out[k] = redactValue(v, depth + 1, isSensitiveKey(k));
    }
    return out;
  }
  // function / symbol / bigint —— 不该出现在 detail 里，落一个不撒谎的占位。
  return `[unsupported:${typeof value}]`;
}

/**
 * `sandbox.probe` 的 argv 形状（13 §2.8.2 / 03 §7.8）。
 *
 * ⚠️ **记形状，不记内容。** 探测要记「实际执行的命令」才有排障价值，但同一个串里
 * 常常就拼着 `export CLAUDE_CODE_OAUTH_TOKEN=…`（04 §2.3★）。所以这里：
 *   · 保留可执行文件名与**看起来像旗标**的部分（`-x` / `--flag`）；
 *   · `--flag=value` 只留 `--flag=<value>`；
 *   · 其余实参一律替换成 `<arg>`，**长度信息也不留**（长度本身能泄漏 token 的种类）。
 * 再对结果跑一遍 `redactAuditText`，防止旗标名本身就带了密钥（有过 `--token=sk-…`
 * 被写成一个整体 argv 元素的先例）。
 */
export function probeArgvShape(argv: readonly string[]): string[] {
  return argv.map((arg, i) => {
    if (i === 0) return redactAuditText(arg);
    if (!arg.startsWith('-')) return '<arg>';
    const eq = arg.indexOf('=');
    if (eq === -1) return redactAuditText(arg);
    return `${redactAuditText(arg.slice(0, eq))}=<value>`;
  });
}

/** `argv` / `cmd` 这类键的值 → 形状。数组按元素走，字符串按空白切开后同样处理。 */
function shapeCommandValue(value: unknown): unknown {
  if (Array.isArray(value) && value.every((v) => typeof v === 'string')) {
    return probeArgvShape(value);
  }
  if (typeof value === 'string') return probeArgvShape(value.split(/\s+/)).join(' ');
  // 既不是 string[] 也不是 string —— 不认识就当普通值走，别为了"看起来处理过了"编一个形状。
  return redactValue(value, 0, false);
}
