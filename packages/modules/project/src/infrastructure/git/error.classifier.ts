import type { CloneErrorCode } from '../../domain/entities/project.entity';

/**
 * A credential was definitely rejected: the remote answered the auth handshake
 * and said no. `401` / `403` / `Authentication failed` / `Permission denied
 * (publickey)` only happen once a name has been offered and turned down.
 */
const PERMISSION_RE =
  /authentication failed|authentication required|permission denied|could not read username|could not read password|unable to get password from user|access denied|invalid username or password|terminal prompts disabled|\b401\b|\b403\b|publickey/;

/**
 * The remote did not open. ⚠️ This is NOT the same fact as "permission denied",
 * and the two must not share a code (see `CloneErrorCodeSchema` in contracts).
 *
 * `Repository not found` / `404` is what a host returns BOTH for a private repo
 * fetched without a credential AND for a URL with a typo in it — deliberately so,
 * since answering `403` for the first would leak the existence of private repos.
 * The server therefore genuinely does not know which one happened, and the code
 * it emits must say only what it knows.
 */
const NOT_FOUND_RE = /repository not found|\bnot found\b|\b404\b/;

/**
 * Map git stderr → clone error taxonomy (docs/backend/03 §7.5). PERMISSION and
 * NOT_FOUND are matched BEFORE NETWORK; anything else falls through to NETWORK.
 * TIMEOUT / INTERRUPTED are decided by the orchestration (timer / startup scan),
 * not here.
 *
 * ⚠️ Order matters where both patterns hit the same stderr: a `403` that also
 * contains the word `not found` is a genuine rejection (the host answered the
 * handshake), so PERMISSION wins. Only a bare not-found — nothing said about
 * credentials — is left ambiguous, and that is exactly the case NOT_FOUND names.
 */
export function classifyCloneError(stderr: string): CloneErrorCode {
  const s = stderr.toLowerCase();
  if (/enospc|no space left on device|disk quota exceeded/.test(s)) {
    return 'DISK_INSUFFICIENT';
  }
  if (PERMISSION_RE.test(s)) return 'CLONE_FAILED_PERMISSION';
  if (NOT_FOUND_RE.test(s)) return 'CLONE_FAILED_NOT_FOUND';
  return 'CLONE_FAILED_NETWORK';
}

/**
 * Strip secrets from a git error before it is persisted/emitted (03 §7.5):
 * URL userinfo (`user:pass@`) and common token formats. Truncated for safety.
 */
export function sanitizeCloneMessage(raw: string): string {
  // Redact whole `Authorization:` lines FIRST (03 §7.3 G): a curl trace can print
  // `Authorization: Basic base64(x-access-token:PAT)` — the PAT must never survive.
  let s = raw.replace(/authorization:\s*\S+.*$/gim, 'Authorization: ***');
  s = s.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+(?::[^\s/@]*)?@/gi, '$1');
  s = s
    .replace(/\bghp_[A-Za-z0-9]{20,}\b/g, '***')
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '***')
    .replace(/\bx-access-token:[^\s@]+/gi, 'x-access-token:***')
    // query-string secrets: ?token=… / &access_token=… / &password=…
    .replace(/([?&](?:access_token|password|token)=)[^\s&]+/gi, '$1***');
  return s.replace(/\s+/g, ' ').trim().slice(0, 500);
}
