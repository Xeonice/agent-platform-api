/**
 * Authority normalisation + whitelist membership for git credentials (docs/backend
 * §7.3 C). `allowedHosts` is the ONLY control over where a credential may be sent
 * (a user's explicit authorization). Private LAN hosts are legitimate (internal
 * self-hosted git); we do NOT ban private ranges — see 03 §7.3 C4.
 *
 * PORT-SENSITIVE (git ≥ 2.50): git credential matching is authority-scoped —
 * `credential.https://h.helper` does NOT match `https://h:8443/`. So the whole
 * chain keys on an AUTHORITY: the bare host when the port is the scheme default
 * (https=443, http=80, ssh=22, git=9418), else `host:port`. Enterprise self-hosted
 * git commonly runs on :8443/:8080/:3000, so this is load-bearing.
 */
const DEFAULT_PORTS: Record<string, number> = { https: 443, http: 80, ssh: 22, git: 9418 };

function unbracket(s: string): string {
  return s.startsWith('[') && s.endsWith(']') ? s.slice(1, -1) : s;
}

/** Canonical authority from parts: bare host on the scheme's default port, else host:port. */
export function toAuthority(host: string, port: number | null, scheme: string): string {
  const h = unbracket(host.trim().toLowerCase());
  const dflt = DEFAULT_PORTS[scheme];
  if (port === null || (dflt !== undefined && port === dflt)) return h;
  return `${h}:${port}`;
}

/**
 * Normalise a user-entered allowedHost into a canonical authority, dropping the
 * given default port. `defaultPort` is the scheme default for the credential type
 * (https-token → 443, ssh-key → 22).
 */
export function normalizeAllowedHost(raw: string, defaultPort: number): string {
  const s = raw.trim().toLowerCase();
  if (s.length === 0) return s;
  if (s.startsWith('[')) {
    const end = s.indexOf(']');
    if (end > 0) {
      const host = s.slice(1, end);
      const m = /^:(\d+)$/.exec(s.slice(end + 1));
      const port = m ? Number(m[1]) : null;
      return port === null || port === defaultPort ? host : `${host}:${port}`;
    }
    return s;
  }
  const m = /^([^:]+):(\d+)$/.exec(s); // host:port (bare IPv6 has multiple colons → no match)
  if (m) {
    const port = Number(m[2]);
    return port === defaultPort ? m[1] : `${m[1]}:${port}`;
  }
  return s; // bare host / bare IPv6
}

/** The scheme default port for a git credential kind (used to normalise allowedHosts). */
export function defaultPortForKind(kind: 'git-ssh-key' | 'git-https-token'): number {
  return kind === 'git-ssh-key' ? 22 : 443;
}

/** Authority ∈ allowedHosts — EXACT match (both sides are already canonical authorities). */
export function hostAllowed(authority: string, allowedHosts: string[]): boolean {
  const a = authority.trim().toLowerCase();
  return allowedHosts.some((h) => h.trim().toLowerCase() === a);
}
