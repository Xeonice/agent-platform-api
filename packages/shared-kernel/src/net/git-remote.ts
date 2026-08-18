/**
 * Shared "reachable git host" parser + SSRF blocklist (docs/backend/03 §7.3 C4).
 *
 * ONE source of truth for BOTH the clone path (project `RepoUrl`) and the test path
 * (credential `parseGitTarget`), so `git ls-remote` / `git clone` can never reach a
 * host the OTHER path would have blocked, and so both agree on which URL SHAPES are
 * acceptable. Pure network utility — it carries no business concepts (no credential
 * kinds, no allowedHosts), so it can live in the shared kernel that both bounded
 * contexts already depend on.
 *
 * SUPPORTED SHAPES: `https://…`, `http://…`, `git://…`, `ssh://…[:port]/…`, and
 * scp-like `user@host:path` (which carries no port).
 *
 * NORMALISATION (closes obfuscated-IP bypasses): the host of every shape is
 * canonicalised via `new URL`. Because Node only IPv4-normalises the host of a
 * SPECIAL scheme (http/https/ws/wss/ftp/file) — `ssh:` and `git:` are NON-special, so
 * their host is left verbatim (e.g. `0177.0.0.1`, `127.0.0.1.`) — the extracted host
 * token is ALWAYS re-run through the special `http:` scheme. That reduces octal
 * (`0177.0.0.1`), hex (`0x7f000001`), decimal (`2130706433`), trailing-dot
 * (`127.0.0.1.`) IPv4 and IPv4-mapped IPv6 to their canonical form BEFORE the
 * blocklist runs. A naive dotted-decimal regex misses all of these.
 *
 * BLOCKLIST (addresses that are NEVER a legitimate git host and only serve SSRF):
 * loopback (127/8, ::1), link-local + cloud metadata (169.254/16 incl. the
 * 169.254.169.254 metadata endpoint, fe80::/10), the unspecified address (0/8, ::),
 * and `localhost`. Private LAN ranges (10/8, 172.16-31/12, 192.168/16, fc00::/7) are
 * ALLOWED — internal self-hosted git is a core use case on a single-machine on-prem
 * deploy (C4). WHERE a credential may be SENT is governed separately by the caller's
 * `allowedHosts` whitelist; this blocklist is a different, always-on layer.
 *
 * BOUNDARY: this blocks by literal HOST / IP only. A hostname that RESOLVES to a
 * blocked address (DNS rebinding) is not caught here; for credentialed use the hard
 * closures are TLS cert validation (HTTPS) and pinned known_hosts (SSH). This is the
 * first, cheap gate.
 */

export type GitRemoteScheme = 'http' | 'https' | 'ssh' | 'git';

export interface ParsedGitRemote {
  /** The URL scheme (drives the scheme-aware credential-helper key, C4). */
  scheme: GitRemoteScheme;
  /**
   * Canonical lowercase host, IPv6 WITHOUT brackets and numeric IPv4 reduced to
   * dotted-decimal (`127.0.0.1`, `::1`, `git.company.com`) — the input to the
   * SSRF blocklist.
   */
  host: string;
  /**
   * Canonical AUTHORITY: the bare host when the port is the scheme default, else
   * `host:port`. git ≥ 2.50 credential matching is port-sensitive, so a non-default
   * port MUST be retained (03 §7.3 C4).
   */
  authority: string;
  /** The parsed port, or null when absent / the scheme default. */
  port: number | null;
}

const HTTP_LIKE = /^https?:\/\/[^\s]+$/i;
const GIT_PROTO = /^git:\/\/[^\s]+$/i;
const SSH_PROTO = /^ssh:\/\/[^\s]+$/i;
const SCP_LIKE = /^[A-Za-z0-9._-]+@([A-Za-z0-9._-]+):[^\s]+$/;

const DEFAULT_PORTS: Record<GitRemoteScheme, number> = { https: 443, http: 80, ssh: 22, git: 9418 };

function normalizeScheme(scheme: string): GitRemoteScheme {
  return scheme === 'http' || scheme === 'https' || scheme === 'ssh' || scheme === 'git'
    ? scheme
    : 'https';
}

/**
 * Canonicalise a raw host token (any IPv4 radix / trailing dot / bracketed IPv6) into
 * a lowercase, unbracketed host — or null if it is not a valid host. Always routed
 * through the SPECIAL `http:` scheme so non-special (`ssh:`/`git:`) and scp hosts get
 * the same IPv4 normalisation as an `http://` host.
 */
function canonicalHost(token: string): string | null {
  const t = token.trim();
  if (t.length === 0) return null;
  // IPv6 must be bracketed for the URL parser; a bare `::1` would throw.
  const bracketed = t.startsWith('[') ? t : t.includes(':') ? `[${t}]` : t;
  try {
    const h = new URL(`http://${bracketed}/`).hostname;
    return h.toLowerCase().replace(/^\[|\]$/g, '');
  } catch {
    return null;
  }
}

/** Canonical authority from parts: bare host on the scheme default port, else host:port. */
function toAuthority(host: string, port: number | null, scheme: GitRemoteScheme): string {
  const dflt = DEFAULT_PORTS[scheme];
  if (port === null || port === dflt) return host;
  return `${host}:${port}`;
}

/**
 * Parse a supported git remote URL into `{ scheme, host, authority, port }`, or null
 * if the shape is unsupported / the host is invalid. Does NOT apply the blocklist —
 * call `isBlockedGitHost(parsed.host)` for that (kept separate so callers can attach
 * their own error type / result shape).
 */
export function parseGitRemote(raw: string): ParsedGitRemote | null {
  const v = raw.trim();
  if (v.length === 0) return null;
  if (HTTP_LIKE.test(v) || GIT_PROTO.test(v) || SSH_PROTO.test(v)) {
    try {
      const u = new URL(v);
      const scheme = normalizeScheme(u.protocol.replace(/:$/, ''));
      const host = canonicalHost(u.hostname);
      if (host === null) return null;
      const port = u.port ? Number(u.port) : null;
      return { scheme, host, port, authority: toAuthority(host, port, scheme) };
    } catch {
      return null;
    }
  }
  const scp = SCP_LIKE.exec(v); // user@host:path — scp form carries no port
  if (scp) {
    const host = canonicalHost(scp[1]);
    if (host === null) return null;
    return { scheme: 'ssh', host, port: null, authority: host };
  }
  return null;
}

/**
 * SSRF blocklist over a CANONICAL host (as produced by `parseGitRemote`): loopback /
 * link-local + cloud metadata / unspecified / `localhost`. Private LAN ranges are
 * ALLOWED (see the file header). Expects an already-canonical, unbracketed host.
 */
export function isBlockedGitHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  if (h.length === 0) return true;
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h.includes(':')) return isBlockedIpv6(h);
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return isBlockedIpv4(h);
  return false;
}

function isBlockedIpv4(ip: string): boolean {
  const p = ip.split('.').map((o) => Number(o));
  if (p.length !== 4 || p.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) return true;
  const [a, b] = p;
  if (a === 0) return true; // 0.0.0.0/8 (unspecified)
  if (a === 127) return true; // loopback 127/8
  if (a === 169 && b === 254) return true; // link-local + cloud metadata 169.254/16
  // Private LAN (10/8, 172.16-31/12, 192.168/16) is ALLOWED — see the file header.
  return false;
}

function isBlockedIpv6(ip: string): boolean {
  const lower = ip.toLowerCase().replace(/^\[|\]$/g, '');
  if (lower === '::1' || lower === '::') return true; // loopback / unspecified
  // IPv4-mapped, dotted form (::ffff:a.b.c.d)
  const dotted = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(lower);
  if (dotted) return isBlockedIpv4(dotted[1]);
  // IPv4-mapped, hex form the URL parser normalises to (::ffff:7f00:1)
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(lower);
  if (hex) {
    const hi = Number.parseInt(hex[1], 16);
    const lo = Number.parseInt(hex[2], 16);
    return isBlockedIpv4(`${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`);
  }
  const head = lower.split(':')[0];
  if (
    head.startsWith('fe8') ||
    head.startsWith('fe9') ||
    head.startsWith('fea') ||
    head.startsWith('feb')
  ) {
    return true; // fe80::/10 link-local
  }
  // fc00::/7 unique-local (IPv6 private) is ALLOWED — same as the IPv4 private ranges.
  return false;
}
