/**
 * 运行日志脱敏 —— **写入口**，与审计流同源（docs/backend/05 §4「日志脱敏」P1-4b；
 * docs/product/pages/21-5 §10.5「脱敏发生在写入口而非导出时」）。
 *
 * ⚠️ 为什么必须在写入口：明文一旦落盘，**导出、备份、文件**三条路都漏。
 * 读出口脱敏只挡住第一条。
 *
 * ⚠️ 规则与 `packages/modules/runtime/src/domain/services/secret-redactor.ts`
 * （pty 交互日志用的 per-CLI 脱敏器）**同源**。那份没有从 `@platform/runtime` 的
 * `src/index.ts` 导出，包 `exports` 又只开了 `"."` 一个出口 ⇒ 这里够不着它，
 * 只能复述规则。**复述就会漂**，所以 `test/unit/logging/log-redactor.spec.ts` 里
 * 有一条**对账测试**：凡 runtime 侧会遮的样本，本函数必须也遮住。
 * 等 runtime 包把 redactor 提到 shared-kernel（那才是三方都够得着的位置，05 §4.3.2 ③
 * 对占位常量的同一条论证），这里应改成直接 import 并删掉对账测试。
 *
 * 运行日志是**混合流**（claude / codex / git / 平台自身都往里打），所以两套 profile
 * 的规则在这里是**合并**生效的，而不是二选一。codex 的 device-code（`XXXX-XXXXX`）
 * 是给用户看的非密钥，规则刻意不碰它。
 */

/** claude OAuth token：整串。折行分片先各自打码再拼接，防「分片各自不像密钥」。 */
const CLAUDE_OAUTH_RE = /sk-ant-oat01-[A-Za-z0-9_-]*/g;
/** claude API key（`sk-ant-` 家族的其余成员）。 */
const CLAUDE_API_KEY_RE = /sk-ant-[A-Za-z0-9_-]{8,}/g;
/** OpenAI 家族 key。`\b` 边界让 codex 的 device-code 不被误伤。 */
const OPENAI_KEY_RE = /\bsk-[A-Za-z0-9]{16,}\b/g;
/** JSON 报文里的 token 字段（auth.json / 刷新回写 / 第三方库把整份 body 打出来）。 */
const JSON_TOKEN_FIELD_RE = /"(access_token|refresh_token|id_token|client_secret)"\s*:\s*"[^"]*"/g;
/** URL query 里的 state / token —— 05 §4：pty 里的授权 URL 参数不入常规日志。 */
const URL_SECRET_PARAM_RE =
  /([?&](?:state|code|token|access_token|id_token|refresh_token)=)[^&\s"']+/gi;
/** `Authorization: Bearer …` / `Authorization: Basic …`。 */
const AUTHZ_HEADER_RE = /\b(authorization\s*[:=]\s*(?:bearer|basic|token)\s+)\S+/gi;
/** GitHub / GitLab / OpenAI project 等前缀式 PAT。 */
const PREFIXED_PAT_RE = /\b(gh[pousr]_|glpat-|xox[baprs]-)[A-Za-z0-9_-]{8,}/g;

/**
 * 对一行（或一段多行）日志文本做脱敏。**纯函数、无状态**，可在热路径上调用。
 *
 * 顺序有意义：先遮最长最具体的（`sk-ant-oat01-…`），再遮更宽的家族规则，
 * 否则宽规则会把长串截成一半、剩下的一半还留在日志里。
 */
export function redactLogLine(text: string): string {
  return text
    .replace(CLAUDE_OAUTH_RE, 'sk-ant-oat01-***')
    .replace(CLAUDE_API_KEY_RE, 'sk-ant-***')
    .replace(PREFIXED_PAT_RE, '$1***')
    .replace(OPENAI_KEY_RE, 'sk-***')
    .replace(JSON_TOKEN_FIELD_RE, '"$1":"***"')
    .replace(URL_SECRET_PARAM_RE, '$1***')
    .replace(AUTHZ_HEADER_RE, '$1***');
}
