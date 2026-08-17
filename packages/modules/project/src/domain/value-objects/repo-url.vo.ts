import { InvalidRepoUrlError } from '../errors/project-errors';

/**
 * RepoUrl value object (docs/backend/23 §6, I-PRJ). Validates the shape of a git
 * remote AND blocks SSRF to internal targets so a project clone can never be used
 * to reach the host's loopback / link-local (cloud metadata 169.254.169.254) /
 * private networks. S2 targets PUBLIC repos: `https://…(.git)`, `http://…`,
 * `git://…`, or scp-like `user@host:path`; the raw string is preserved.
 *
 * THREAT MODEL (03 §7.3 C4, coordinator ruling): this is a SINGLE-MACHINE, private
 * on-prem deployment. Enterprise self-hosted git (e.g. a company GitLab) commonly
 * lives on 10.x / 172.16.x / 192.168.x — cloning INTERNAL private repos is a CORE
 * use case, not an attack. So private LAN ranges are ALLOWED. We still block the
 * addresses that are NEVER a legitimate git host and only serve SSRF: loopback
 * (127/8, ::1), the unspecified address (0.0.0.0/8), and link-local / cloud
 * metadata (169.254/16, fe80::/10 — 169.254.169.254 is the metadata endpoint).
 * Token/key EXFILTRATION is controlled by `allowedHosts` (the user's explicit
 * authorization of where a credential may go), NOT by banning private IPs.
 *
 * BOUNDARY (S2): we block by literal HOST / IP only. A hostname that *resolves* to
 * a blocked address (DNS rebinding) is not caught here; for credentialed clones the
 * hard closures are TLS cert validation (HTTPS) and pinned known_hosts (SSH SaaS),
 * see 03 §7.3 C4/H. This VO is the first, cheap gate.
 */
const HTTP_LIKE = /^https?:\/\/[^\s]+$/i;
const GIT_PROTO = /^git:\/\/[^\s]+$/i;
const SCP_LIKE = /^[A-Za-z0-9._-]+@([A-Za-z0-9._-]+):[^\s]+$/;

export class RepoUrl {
  private constructor(readonly value: string) {}

  static create(raw: string): RepoUrl {
    const v = raw.trim();
    if (v.length === 0 || v.length > 2048) throw new InvalidRepoUrlError(raw);
    const host = extractHost(v);
    if (host === null) throw new InvalidRepoUrlError(raw);
    if (isBlockedHost(host)) throw new InvalidRepoUrlError(raw);
    return new RepoUrl(v);
  }

  toString(): string {
    return this.value;
  }

  /**
   * Which git credential kind this URL needs (docs/backend/23 §6.3, S3). `https://`
   * ⇒ `git-https-token`; `git@host:` / `ssh://` ⇒ `git-ssh-key`; `git://` (anon) ⇒
   * `git-https-token` (no auth carried anyway). This is the domain rule for "pick a
   * credential by protocol" — the project side computes it and passes the ENUM
   * across the facade (it never hands the RepoUrl to the credential context, A3).
   */
  credentialKind(): 'git-ssh-key' | 'git-https-token' {
    return SCP_LIKE.test(this.value) || /^ssh:\/\//i.test(this.value)
      ? 'git-ssh-key'
      : 'git-https-token';
  }

  /**
   * The target AUTHORITY (lowercased host, plus `:port` when the port is NOT the
   * scheme default) — passed across the facade as the credential scope. git ≥ 2.50
   * credential matching is port-sensitive: `credential.https://h.helper` does NOT
   * match `https://h:8443/`, so a non-default port MUST be kept. `https://h/` and
   * `https://h:443/` both → `h`; `https://h:8443/` → `h:8443` (03 §7.3 C4).
   */
  host(): string {
    return extractAuthority(this.value) ?? '';
  }

  /**
   * The URL SCHEME (03 §7.3 C4) — passed across the facade alongside `host()` so the
   * HTTPS credential helper key is scheme-aware. git credential matching is
   * scheme+authority sensitive: `credential.https://h.helper` does NOT match a
   * plaintext `http://h/` remote, so a plaintext internal git host would never
   * receive its token unless the helper is keyed on the ACTUAL scheme. scp-form
   * (`user@host:path`) and `ssh://` ⇒ `ssh`; `git://` (anon) ⇒ `git`. An
   * unrecognised shape falls back to `https` (the historical default).
   */
  scheme(): 'http' | 'https' | 'ssh' | 'git' {
    if (SCP_LIKE.test(this.value)) return 'ssh';
    const s = /^([a-z][a-z0-9+.-]*):\/\//i.exec(this.value)?.[1]?.toLowerCase();
    if (s === 'http' || s === 'https' || s === 'ssh' || s === 'git') return s;
    return 'https';
  }
}

const DEFAULT_PORTS: Record<string, number> = { https: 443, http: 80, git: 9418, ssh: 22 };

/** Host + non-default port (authority) of a supported git URL, or null if unsupported. */
function extractAuthority(v: string): string | null {
  if (HTTP_LIKE.test(v) || GIT_PROTO.test(v)) {
    try {
      const u = new URL(v);
      const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
      const scheme = u.protocol.replace(/:$/, '');
      const port = u.port ? Number(u.port) : null;
      if (port === null || port === DEFAULT_PORTS[scheme]) return host;
      return `${host}:${port}`;
    } catch {
      return null;
    }
  }
  const scp = SCP_LIKE.exec(v); // user@host:path — scp form carries no port
  if (scp) return scp[1].toLowerCase();
  return null;
}

/** Resolve the host of a supported git URL, or null if the shape is unsupported. */
function extractHost(v: string): string | null {
  if (HTTP_LIKE.test(v) || GIT_PROTO.test(v)) {
    try {
      // strips userinfo, port, path; hostname is bracket-free for IPv6.
      return new URL(v).hostname.toLowerCase();
    } catch {
      return null;
    }
  }
  const scp = SCP_LIKE.exec(v);
  if (scp) return scp[1].toLowerCase();
  return null;
}

/** Loopback / link-local / private / metadata host or IP (SSRF blocklist). */
function isBlockedHost(host: string): boolean {
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  const ipv6 = host.startsWith('[') ? host.slice(1, -1) : host;
  if (ipv6.includes(':')) return isBlockedIpv6(ipv6);
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return isBlockedIpv4(host);
  return false;
}

function isBlockedIpv4(ip: string): boolean {
  const p = ip.split('.').map((o) => Number(o));
  if (p.length !== 4 || p.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) return true;
  const [a, b] = p;
  if (a === 0) return true; // 0.0.0.0/8 (unspecified)
  if (a === 127) return true; // loopback 127/8
  if (a === 169 && b === 254) return true; // link-local + cloud metadata 169.254/16
  // NOTE: private LAN ranges (10/8, 172.16/12, 192.168/16) are ALLOWED — internal
  // self-hosted git is a core use case (03 §7.3 C4). allowedHosts governs where a
  // credential may be sent, not this blocklist.
  return false;
}

function isBlockedIpv6(ip: string): boolean {
  const lower = ip.toLowerCase();
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
  // NOTE: fc00::/7 unique-local (the IPv6 private range) is ALLOWED — same reason as
  // the IPv4 private ranges (internal self-hosted git, 03 §7.3 C4).
  return false;
}
