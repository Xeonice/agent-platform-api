import type { ProxyConfig } from '@platform/contracts';

/**
 * 代理地址进审计 / 日志之前的脱敏。
 *
 * ── 为什么这一段必须单独存在（而不是靠 `log-redactor` 兜住）────────────────────
 * 代理配置里合法地可以带凭证：`http://user:pass@proxy.corp:3128` 是企业内网最常见的
 * 写法之一。而 `redactLogLine` 认的是**密钥的形状**（`sk-ant-…` / `ghp_…` /
 * `Authorization: Bearer …`），**URL userinfo 那一段一条规则都不遮** —— `user:pass@`
 * 里的 `pass` 通常是个普通口令，它不长得像任何一种密钥。
 *
 * ⚠️ 审计侧的键名黑名单也接不住：`audit-redaction.ts` 按键名遮值，而这里的键名是
 * `httpProxy` / `httpsProxy` / `noProxy` —— 拆 camelCase 之后是 `http`/`proxy`，
 * 一个都不在 `SENSITIVE_WORDS` 里。**两道既有防线都不覆盖它**，所以这是第三道，
 * 而且必须在**调用点之前**（写入口脱敏，13 §2.8.2）。
 *
 * ⚠️ 本仓在 `ProjectConvertedToEmpty` 上踩过同一个坑（仓库 URL 里的 token），
 * 那次的解法就是**只记 host**。这里沿用它：审计要回答的是「当时选了什么代理」，
 * host + port 已经足够（排障时问的是「走的是哪个代理」，不是「口令是多少」），
 * 而 userinfo 一旦落库，导出、备份、DB 文件三条路全漏。
 *
 * ⚠️ **不是"把密码替换成 `***`"而是整段丢掉。** 保留 `user:***@` 会泄漏用户名，
 * 而用户名在企业环境里往往就是域账号。
 */
export function redactProxyUrl(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const value = raw.trim();
  if (value === '') return undefined;
  try {
    const url = new URL(value);
    // ⚠️ **解析成功 ≠ 解析对了。** `new URL('alice:s3cr3t@proxy.corp:3128')` 不抛 ——
    //    `alice:` 被当成 scheme，`host` 是空串，于是天真的实现会输出 `alice://`：
    //    既丢掉了 host（排障信息没了），又把**用户名**当成协议名留在了审计里。
    //    没有 host 就说明这不是一个 URL，走下面那条按 `@` 切的路。
    if (url.host === '') throw new Error('no host');
    // 丢掉 username/password/path/query/hash，只留权威部分。
    const auth = url.username !== '' || url.password !== '';
    return `${url.protocol}//${url.host}${auth ? '（含凭证，已省略）' : ''}`;
  } catch {
    // 解析不了的（`proxy.corp:3128` 这种没有 scheme 的写法照样能用）。
    // ⚠️ 仍然要处理 userinfo —— 没有 scheme 不等于没有 `user:pass@`。
    const at = value.lastIndexOf('@');
    if (at >= 0) return `${value.slice(at + 1)}（含凭证，已省略）`;
    return value;
  }
}

/**
 * 整份代理配置的脱敏投影 —— 审计 `detail` 里放的就是它。
 *
 * `noProxy` 是一串 host/后缀，结构上带不了凭证，原样保留（它对排障有直接价值：
 * 「为什么这个内网地址还在走代理」十有八九就在这一行里）。
 */
export function redactProxyConfig(config: ProxyConfig | undefined): Record<string, unknown> {
  if (config === undefined) return { proxy: 'none' };
  const out: Record<string, unknown> = {};
  const http = redactProxyUrl(config.httpProxy);
  const https = redactProxyUrl(config.httpsProxy);
  if (http !== undefined) out.httpProxy = http;
  if (https !== undefined) out.httpsProxy = https;
  if (config.noProxy !== undefined && config.noProxy.trim() !== '') out.noProxy = config.noProxy;
  if (Object.keys(out).length === 0) return { proxy: 'none' };
  return out;
}
