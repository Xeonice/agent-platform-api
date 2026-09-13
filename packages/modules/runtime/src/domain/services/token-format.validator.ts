/**
 * Token / key FORMAT validation (docs/backend/05 §3 入库前校验 P1-4c, §3.1). A
 * captured/pasted secret is checked for PREFIX + LENGTH + CHARSET before it is
 * accepted into the Vault, so a folding-mangled or bad token is rejected as
 * `AUTH_REJECTED` rather than silently stored (which would fail across many
 * sandboxes and risk an account lock). Pure — no IO.
 *
 * ⛔ **这六条理由是给用户看的，所以它们必须真的到达用户。**
 *    2026-09-11 之前，`reason` 精确区分了 prefix / 长度 / 字符集，然后**从不下发** ——
 *    `submitSecret` 把它拼进一句英文 message 里（`invalid api key: … (AUTH_REJECTED)`），
 *    而 `details[]` 只由 zod 校验管道填充；前端 `useRuntimeAuthFlow.reasonsFromError`
 *    读的正是 `details[].message`，于是永远只拿到一句兜底的「格式错误、无权限或额度不足」。
 *    六条精确的判定，一条都没到界面上。
 *
 * ⇒ 现在 `reason` 是**中文人话**，由 `submitSecret` 放进 `details[].message` 出线，
 *    就是用户看到的那一行。
 *
 * ⚠️ `reason` 里不许出现内部说法。`fold misjoin`（终端折行把一行拼错了）就是被点名的那个：
 *    它对写解析器的人有意义，对着屏幕的人只是天书。
 *
 * ⏳ **没有机器可读的细分码**，是因为 adapter 那一层的返回类型
 *    `ApiKeyFormatVerdict`（`@platform/contracts`，第三方 adapter 也实现它）只有
 *    `{ ok, reason }` 两位。加一位 `code` 是**契约变更**（要同步 04 §3 与 testkit），
 *    不在本次范围内 —— 这里刻意不加一个下游读不到的字段，那正是本文件要修的那种病。
 */
export interface FormatVerdict {
  ok: boolean;
  /** 中文人话（进 `details[].message`，直接上屏）。 */
  reason?: string;
}

const OK: FormatVerdict = { ok: true };
const TOKEN_CHARSET = /^[A-Za-z0-9_-]+$/;

/** Claude `setup-token` (`sk-ant-oat01-…`), the 1-year OAuth token (05 §1 ★1). */
export function validateClaudeOauthToken(token: string): FormatVerdict {
  const t = token.trim();
  if (!t.startsWith('sk-ant-oat01-')) {
    return {
      ok: false,
      reason: '开头不是 sk-ant-oat01-，这多半不是授权码（别把 API Key 粘到这里）。',
    };
  }
  // The body (after the prefix) must be a single high-entropy charset run — a
  // fold-mangled token that kept a space/newline fails here (P1-4c).
  const body = t.slice('sk-ant-oat01-'.length);
  if (body.length < 24) {
    return { ok: false, reason: '比正常的授权码短，可能只复制到了前半截。' };
  }
  if (t.length > 512) {
    return { ok: false, reason: '比正常的授权码长，可能多粘了别的内容进来。' };
  }
  if (!TOKEN_CHARSET.test(t.replace('sk-ant-oat01-', ''))) {
    return {
      ok: false,
      // 原文是 `token contains illegal characters (fold misjoin?)` —— `fold misjoin`
      // 是终端折行的内部说法，用户看不懂；这里只说他能核对的那件事。
      reason: '里面混进了空格或换行 —— 从终端里复制时最容易这样，请重新完整复制一遍。',
    };
  }
  return OK;
}

/** Anthropic API key (`sk-ant-…`) or a generic non-empty key (05 §3.1). */
export function validateAnthropicApiKey(key: string): FormatVerdict {
  const k = key.trim();
  if (!k.startsWith('sk-ant-')) {
    return { ok: false, reason: '开头不是 sk-ant-，可能拿错了 key。' };
  }
  if (k.length < 16) {
    return { ok: false, reason: '比正常的 key 短，可能只复制到了一部分。' };
  }
  if (!TOKEN_CHARSET.test(k)) {
    return {
      ok: false,
      reason: '里面混进了空格或换行，请重新完整复制一遍。',
    };
  }
  return OK;
}

/** OpenAI API key (`sk-…`). */
export function validateOpenAiApiKey(key: string): FormatVerdict {
  const k = key.trim();
  if (!k.startsWith('sk-')) {
    return { ok: false, reason: '开头不是 sk-，可能拿错了 key。' };
  }
  if (k.length < 16) {
    return { ok: false, reason: '比正常的 key 短，可能只复制到了一部分。' };
  }
  if (!TOKEN_CHARSET.test(k)) {
    return {
      ok: false,
      reason: '里面混进了空格或换行，请重新完整复制一遍。',
    };
  }
  return OK;
}
