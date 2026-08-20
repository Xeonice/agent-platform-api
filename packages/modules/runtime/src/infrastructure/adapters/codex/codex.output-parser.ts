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

/** True once the CLI has confirmed the device login succeeded (poll/complete). */
export function codexLoginSucceeded(raw: string): boolean {
  const text = stripAnsi(raw).toLowerCase();
  return (
    text.includes('successfully logged in') ||
    text.includes('logged in') ||
    text.includes('authentication complete')
  );
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
 * Parse `~/.codex/auth.json` (05 §1 ★2 実測 top-level keys). Returns the access
 * token (short-lived) that gets injected via stdin, plus the whole file for the 0600
 * fallback form. The `refresh_token` NEVER leaves the platform (P0-3).
 */
export function parseCodexAuthJson(jsonText: string): CodexAuthJson {
  return JSON.parse(jsonText) as CodexAuthJson;
}
