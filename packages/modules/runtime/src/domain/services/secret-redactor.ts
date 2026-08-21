/**
 * Per-CLI log redaction (docs/backend/05 §4 日志脱敏 P1-4b, §6). Two profiles:
 *   - claude: high-entropy KEY mode — the `sk-ant-oat01-` prefix and any following
 *     fold fragments are masked BEFORE they are joined, so "each fragment doesn't
 *     look like a key but the join is one" cannot slip through.
 *   - codex: the device-code (`XXXX-XXXXX`) is a NON-secret, user-visible value and
 *     is left readable; only real tokens are masked.
 * Terminal transcripts pass through the SAME redactor before persistence.
 */
const CLAUDE_TOKEN_RE = /sk-ant-oat01-[A-Za-z0-9_-]*/g;
// A partial (fold) fragment: the prefix alone, or a bare high-entropy run right
// after a known token context. Mask the prefix defensively.
const CLAUDE_PREFIX_RE = /sk-ant-oat01-/g;
const API_KEY_RE = /sk-ant-[A-Za-z0-9_-]{8,}/g;
const OPENAI_KEY_RE = /\bsk-[A-Za-z0-9]{16,}\b/g;

/** Mask claude token material (prefix + body) — safe to call on a raw fold fragment. */
export function redactClaude(text: string): string {
  return text
    .replace(CLAUDE_TOKEN_RE, 'sk-ant-oat01-***')
    .replace(API_KEY_RE, 'sk-ant-***')
    .replace(OPENAI_KEY_RE, 'sk-***')
    .replace(CLAUDE_PREFIX_RE, 'sk-ant-oat01-');
}

/** Mask codex tokens while KEEPING the user-facing device-code readable. */
export function redactCodex(text: string): string {
  // access/refresh/id tokens are long JWT-ish runs; the device-code XXXX-XXXXX and
  // the verification URL are non-secret and preserved.
  return text
    .replace(OPENAI_KEY_RE, 'sk-***')
    .replace(/"(access_token|refresh_token|id_token)"\s*:\s*"[^"]+"/g, '"$1":"***"');
}
