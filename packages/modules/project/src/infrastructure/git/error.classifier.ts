import type { CloneErrorCode } from '../../domain/entities/project.entity';

/**
 * Map git stderr → clone error taxonomy (docs/backend/03 §7.5). PERMISSION is
 * matched BEFORE NETWORK; anything not permission/disk falls through to NETWORK.
 * TIMEOUT / INTERRUPTED are decided by the orchestration (timer / startup scan),
 * not here.
 */
export function classifyCloneError(stderr: string): CloneErrorCode {
  const s = stderr.toLowerCase();
  if (/enospc|no space left on device|disk quota exceeded/.test(s)) {
    return 'DISK_INSUFFICIENT';
  }
  if (
    /authentication failed|authentication required|permission denied|could not read username|could not read password|unable to get password from user|access denied|invalid username or password|terminal prompts disabled|\b401\b|\b403\b|publickey|repository not found|\bnot found\b|\b404\b/.test(
      s,
    )
  ) {
    return 'CLONE_FAILED_PERMISSION';
  }
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
