import { extractOsc8Urls, stripAnsi } from '../ansi.util';

/**
 * Claude `setup-token` output parser (docs/backend/05 §1 ★1, §3). TWO fragile bits,
 * both golden-fixture tested (25 §2.3):
 *   1. the authorization URL is hidden in an OSC-8 escape (the VISIBLE text is
 *      pty-truncated) → parse OSC-8, never `grep https://`.
 *   2. the 1-year token (`sk-ant-oat01-…`) is printed to stdout and FOLDED across
 *      lines by the pty → rejoin the charset-only fold fragments, strip whitespace.
 * Pure — no IO. The caller validates format (PREFIX+LENGTH+CHARSET) and carries the
 * plaintext token in the controlled-plaintext `RuntimeCredential` wrapper (`env`,
 * runtime-adapter.contract) — a裸 string by design (injection writes env/stdin), NOT a
 * `SecretMaterial`; it is `zeroize()`d after injection (05 §4 明文纪律).
 */
const TOKEN_PREFIX = 'sk-ant-oat01-';
const TOKEN_CHAR = /^[A-Za-z0-9_-]+$/;

/** The authorization URL from the OSC-8 hyperlink (first claude.ai/anthropic link). */
export function parseClaudeAuthUrl(raw: string): string | null {
  const urls = extractOsc8Urls(raw);
  const url = urls.find((u) => /^https:\/\//i.test(u));
  return url ?? null;
}

/**
 * Reconstruct the folded setup-token. The token is printed as a block: the prefix
 * line + zero or more charset-only continuation lines. We take the charset run from
 * the prefix on its line, then append every following line that is charset-only
 * (a pty fold), stopping at the first line that isn't — so trailing instructions
 * are never joined in. A misjoined/mangled result is caught downstream by the
 * PREFIX+LENGTH+CHARSET validator (05 §3 P1-4c), never silently stored.
 */
export function parseClaudeSetupToken(raw: string): string | null {
  const clean = stripAnsi(raw);
  const lines = clean.split(/\r?\n/);
  const i = lines.findIndex((l) => l.includes(TOKEN_PREFIX));
  if (i < 0) return null;

  const first = lines[i];
  const start = first.indexOf(TOKEN_PREFIX);
  let head = '';
  for (const ch of first.slice(start)) {
    if (/[A-Za-z0-9_-]/.test(ch)) head += ch;
    else break;
  }
  let token = head;
  for (let j = i + 1; j < lines.length; j++) {
    const l = lines[j].trim();
    if (l.length > 0 && TOKEN_CHAR.test(l)) token += l;
    else break;
  }
  return token;
}
