import { InvalidRepoUrlError } from '../errors/project-errors';

/**
 * RepoUrl value object (docs/backend/23 §6, I-PRJ). Validates the shape of a git
 * remote AND blocks SSRF to internal targets so a project clone can never be used
 * to reach the host's loopback / link-local (cloud metadata 169.254.169.254) /
 * private networks. S2 targets PUBLIC repos: `https://…(.git)`, `http://…`,
 * `git://…`, or scp-like `user@host:path`; the raw string is preserved.
 *
 * BOUNDARY (S2): we block by literal HOST / IP only. A hostname that *resolves* to
 * an internal address (DNS rebinding) is NOT caught here — the mitigation is to
 * resolve + pin the IP at clone time, tracked as a follow-up. This VO is the
 * first, cheap gate.
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
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 127) return true; // loopback 127/8
  if (a === 10) return true; // private 10/8
  if (a === 172 && b >= 16 && b <= 31) return true; // private 172.16/12
  if (a === 192 && b === 168) return true; // private 192.168/16
  if (a === 169 && b === 254) return true; // link-local + metadata 169.254/16
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
  if (head.startsWith('fe8') || head.startsWith('fe9') || head.startsWith('fea') || head.startsWith('feb')) {
    return true; // fe80::/10 link-local
  }
  if (head.startsWith('fc') || head.startsWith('fd')) return true; // fc00::/7 unique-local
  return false;
}
