import { RUNTIME_REFRESH_TOKEN_PLACEHOLDER } from '@platform/shared-kernel';
import { stripAnsi } from '../ansi.util';

/**
 * Codex `login --device-auth` output parser (docs/backend/05 §1 ★2, §3). The output
 * is PLAIN TEXT — a verification URL (`https://auth.openai.com/codex/device`) + a
 * device code `XXXX-XXXXX` (15-min expiry). Plain-text regex is robust here (unlike
 * claude's OSC-8). Pure — golden-fixture tested (25 §2.3 CLI-AUTH-PARSE).
 */
const DEVICE_CODE_RE = /\b([A-Z0-9]{4}-[A-Z0-9]{5})\b/;
const VERIFICATION_URL_RE = /(https:\/\/auth\.openai\.com\/[^\s"']+)/i;

export interface CodexDeviceChallenge {
  verificationUrl: string;
  userCode: string;
}

export function parseCodexDeviceChallenge(raw: string): CodexDeviceChallenge | null {
  const text = stripAnsi(raw);
  const code = DEVICE_CODE_RE.exec(text);
  const url = VERIFICATION_URL_RE.exec(text);
  if (!code || !url) return null;
  return { verificationUrl: url[1], userCode: code[1] };
}

/**
 * True once the CLI has confirmed the device login succeeded (poll/complete). Matches
 * PRECISE success phrases only — a bare `includes('logged in')` also fires on the
 * FAILURE line "not logged in" (P2), so it is never used.
 */
export function codexLoginSucceeded(raw: string): boolean {
  const text = stripAnsi(raw).toLowerCase();
  return text.includes('successfully logged in') || text.includes('authentication complete');
}

export interface CodexAuthJson {
  auth_mode?: string;
  OPENAI_API_KEY?: string | null;
  tokens?: {
    id_token?: string;
    access_token?: string;
    refresh_token?: string;
    account_id?: string;
  };
  last_refresh?: string;
}

/**
 * Parse `~/.codex/auth.json` (05 §1 ★2 実測 top-level keys). The `refresh_token` it
 * contains NEVER leaves the platform (P0-3) — see `sanitizeCodexAuthJson`.
 */
export function parseCodexAuthJson(jsonText: string): CodexAuthJson {
  return JSON.parse(jsonText) as CodexAuthJson;
}

/**
 * Produce the SANITIZED `auth.json` that is the ONLY form ever injected into a sandbox
 * (05 §1★★ / §4.3 裁决 D-18 ②): every field preserved verbatim, except
 * `tokens.refresh_token`, whose VALUE becomes the shared-kernel placeholder.
 *
 * Two details are load-bearing and must not be "simplified":
 *  - The FIELD IS KEPT. Deleting it makes codex fail with `missing field
 *    'refresh_token'` (05 §1★★ 実測); only the VALUE is replaced.
 *  - Unknown keys survive. The file's shape is OpenAI's, not ours; rebuilding it from
 *    a known-key allowlist would silently drop whatever the CLI adds next.
 *
 * This runs at credential BIRTH (`completeAuth` / `parseRefreshedAuth`), NOT on the
 * injection path — by the time `injectCredential` runs, the real refresh token is not
 * reachable at all (`InjectableRuntimeCredential` has no `authFile`).
 */
export function sanitizeCodexAuthJson(rawAuthJson: string): string {
  const parsed: unknown = JSON.parse(rawAuthJson);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('codex auth.json is not a JSON object');
  }
  const root = parsed as Record<string, unknown>;
  const tokens = root.tokens;
  const sanitizedTokens: Record<string, unknown> =
    typeof tokens === 'object' && tokens !== null && !Array.isArray(tokens)
      ? { ...(tokens as Record<string, unknown>) }
      : {};
  sanitizedTokens.refresh_token = RUNTIME_REFRESH_TOKEN_PLACEHOLDER;
  return JSON.stringify({ ...root, tokens: sanitizedTokens });
}
