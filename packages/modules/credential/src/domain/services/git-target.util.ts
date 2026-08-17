import type { GitObtainedVia } from '../value-objects/obtained-via.vo';
import { toAuthority } from './host.util';

/**
 * Parse a git remote into `{ kind, host }` for the test endpoint (docs/backend
 * §7.4). The credential context cannot import project's `RepoUrl` VO (boundaries),
 * so this is a small local parser: `https://` → https-token, `git@host:` / `ssh://`
 * → ssh-key. `host` is the canonical AUTHORITY (host, or `host:port` for a
 * non-default port) — git credential matching is port-sensitive (03 §7.3 C4).
 * Returns null for an unsupported shape.
 */
const HTTP_LIKE = /^https?:\/\/[^\s]+$/i;
const SSH_PROTO = /^ssh:\/\/[^\s]+$/i;
const SCP_LIKE = /^[A-Za-z0-9._-]+@([A-Za-z0-9._-]+):[^\s]+$/;

export type GitTargetScheme = 'http' | 'https' | 'ssh' | 'git';

export interface GitTarget {
  kind: GitObtainedVia;
  host: string;
  /** The remote's URL scheme — carried so the HTTPS helper key is scheme-aware (C4). */
  scheme: GitTargetScheme;
}

function normalizeScheme(scheme: string): GitTargetScheme {
  return scheme === 'http' || scheme === 'https' || scheme === 'ssh' || scheme === 'git'
    ? scheme
    : 'https';
}

function authorityFromUrl(url: string, kind: GitObtainedVia): GitTarget | null {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    const scheme = u.protocol.replace(/:$/, '');
    const port = u.port ? Number(u.port) : null;
    return { kind, host: toAuthority(host, port, scheme), scheme: normalizeScheme(scheme) };
  } catch {
    return null;
  }
}

export function parseGitTarget(url: string): GitTarget | null {
  const v = url.trim();
  if (HTTP_LIKE.test(v)) return authorityFromUrl(v, 'git-https-token');
  if (SSH_PROTO.test(v)) return authorityFromUrl(v, 'git-ssh-key');
  const scp = SCP_LIKE.exec(v); // user@host:path — scp form carries no port
  if (scp) return { kind: 'git-ssh-key', host: scp[1].toLowerCase(), scheme: 'ssh' };
  return null;
}
