import { parseGitRemote } from '@platform/shared-kernel';
import type { GitRemoteScheme } from '@platform/shared-kernel';
import type { GitObtainedVia } from '../value-objects/obtained-via.vo';

/**
 * Parse a git remote into a `GitTarget` for the TEST endpoint (docs/backend §7.4). The
 * credential context cannot import project's `RepoUrl` VO (boundaries), so both sides
 * delegate to the shared-kernel `parseGitRemote` — the SAME parser + SSRF blocklist —
 * so the test path and the clone path accept the SAME URL shapes and expose the SAME
 * canonical host to the blocklist. `ssh://` / scp-form → ssh-key; `https://` /
 * `http://` / `git://` → https-token. `host` is the canonical AUTHORITY (host, or
 * `host:port` for a non-default port — git credential matching is port-sensitive, C4);
 * `canonicalHost` is the bare host the caller must run through `isBlockedGitHost`.
 * Returns null for an unsupported shape.
 */
export type GitTargetScheme = GitRemoteScheme;

export interface GitTarget {
  kind: GitObtainedVia;
  /** Canonical authority (host, or host:port for a non-default port). */
  host: string;
  /** The remote's URL scheme — carried so the HTTPS helper key is scheme-aware (C4). */
  scheme: GitTargetScheme;
  /** Bare canonical host for the SSRF blocklist (`isBlockedGitHost`). */
  canonicalHost: string;
}

export function parseGitTarget(url: string): GitTarget | null {
  const parsed = parseGitRemote(url);
  if (!parsed) return null;
  const kind: GitObtainedVia = parsed.scheme === 'ssh' ? 'git-ssh-key' : 'git-https-token';
  return {
    kind,
    host: parsed.authority,
    scheme: parsed.scheme,
    canonicalHost: parsed.host,
  };
}
