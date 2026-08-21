/**
 * Token / key FORMAT validation (docs/backend/05 §3 入库前校验 P1-4c, §3.1). A
 * captured/pasted secret is checked for PREFIX + LENGTH + CHARSET before it is
 * accepted into the Vault, so a folding-mangled or bad token is rejected as
 * `AUTH_REJECTED` rather than silently stored (which would fail across many
 * sandboxes and risk an account lock). Pure — no IO.
 */
export interface FormatVerdict {
  ok: boolean;
  reason?: string;
}

const OK: FormatVerdict = { ok: true };
const TOKEN_CHARSET = /^[A-Za-z0-9_-]+$/;

/** Claude `setup-token` (`sk-ant-oat01-…`), the 1-year OAuth token (05 §1 ★1). */
export function validateClaudeOauthToken(token: string): FormatVerdict {
  const t = token.trim();
  if (!t.startsWith('sk-ant-oat01-')) {
    return { ok: false, reason: 'missing sk-ant-oat01- prefix' };
  }
  // The body (after the prefix) must be a single high-entropy charset run — a
  // fold-mangled token that kept a space/newline fails here (P1-4c).
  const body = t.slice('sk-ant-oat01-'.length);
  if (body.length < 24) return { ok: false, reason: 'token body too short' };
  if (t.length > 512) return { ok: false, reason: 'token too long' };
  if (!TOKEN_CHARSET.test(t.replace('sk-ant-oat01-', ''))) {
    return { ok: false, reason: 'token contains illegal characters (fold misjoin?)' };
  }
  return OK;
}

/** Anthropic API key (`sk-ant-…`) or a generic non-empty key (05 §3.1). */
export function validateAnthropicApiKey(key: string): FormatVerdict {
  const k = key.trim();
  if (!k.startsWith('sk-ant-')) return { ok: false, reason: 'missing sk-ant- prefix' };
  if (k.length < 16) return { ok: false, reason: 'api key too short' };
  if (!TOKEN_CHARSET.test(k)) return { ok: false, reason: 'api key contains illegal characters' };
  return OK;
}

/** OpenAI API key (`sk-…`). */
export function validateOpenAiApiKey(key: string): FormatVerdict {
  const k = key.trim();
  if (!k.startsWith('sk-')) return { ok: false, reason: 'missing sk- prefix' };
  if (k.length < 16) return { ok: false, reason: 'api key too short' };
  if (!TOKEN_CHARSET.test(k)) return { ok: false, reason: 'api key contains illegal characters' };
  return OK;
}
