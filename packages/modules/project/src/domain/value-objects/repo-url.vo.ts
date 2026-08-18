import { parseGitRemote, isBlockedGitHost } from '@platform/shared-kernel';
import type { GitRemoteScheme, ParsedGitRemote } from '@platform/shared-kernel';
import { InvalidRepoUrlError } from '../errors/project-errors';

/**
 * RepoUrl value object (docs/backend/23 §6, I-PRJ). Validates the SHAPE of a git
 * remote AND blocks SSRF to internal targets so a project clone can never be used to
 * reach the host's loopback / link-local (cloud metadata 169.254.169.254) /
 * unspecified address. S2 targets PUBLIC repos: `https://…(.git)`, `http://…`,
 * `git://…`, `ssh://host[:port]/…`, or scp-like `user@host:path`; the raw string is
 * preserved.
 *
 * BOTH the shape parsing and the SSRF blocklist are delegated to the shared-kernel
 * `parseGitRemote` / `isBlockedGitHost` so the clone path (this VO) and the credential
 * TEST path (`parseGitTarget`) share ONE source of truth — they accept the SAME URL
 * shapes and block the SAME hosts, including obfuscated IPv4 (octal / hex / decimal /
 * trailing-dot) and IPv4-mapped IPv6 that a naive regex would miss.
 *
 * THREAT MODEL (03 §7.3 C4): single-machine on-prem deploy. Enterprise self-hosted git
 * commonly lives on 10.x / 172.16.x / 192.168.x — cloning INTERNAL private repos is a
 * CORE use case, so private LAN ranges are ALLOWED. Token/key EXFILTRATION is
 * controlled by `allowedHosts`, NOT by banning private IPs.
 */
export class RepoUrl {
  private constructor(
    readonly value: string,
    private readonly parsed: ParsedGitRemote,
  ) {}

  static create(raw: string): RepoUrl {
    const v = raw.trim();
    if (v.length === 0 || v.length > 2048) throw new InvalidRepoUrlError(raw);
    const parsed = parseGitRemote(v);
    if (parsed === null) throw new InvalidRepoUrlError(raw);
    if (isBlockedGitHost(parsed.host)) throw new InvalidRepoUrlError(raw);
    return new RepoUrl(v, parsed);
  }

  toString(): string {
    return this.value;
  }

  /**
   * Which git credential kind this URL needs (docs/backend/23 §6.3, S3). `ssh://` /
   * scp-form ⇒ `git-ssh-key`; `https://` / `http://` / `git://` ⇒ `git-https-token`
   * (`git://` is anonymous and carries no auth anyway). The project side computes this
   * and passes the ENUM across the facade (it never hands the RepoUrl to the credential
   * context, A3).
   */
  credentialKind(): 'git-ssh-key' | 'git-https-token' {
    return this.parsed.scheme === 'ssh' ? 'git-ssh-key' : 'git-https-token';
  }

  /**
   * The target AUTHORITY (lowercased host, plus `:port` when the port is NOT the
   * scheme default) — passed across the facade as the credential scope. git ≥ 2.50
   * credential matching is port-sensitive: `credential.https://h.helper` does NOT
   * match `https://h:8443/`, so a non-default port MUST be kept. `https://h/` and
   * `https://h:443/` both → `h`; `https://h:8443/` → `h:8443` (03 §7.3 C4).
   */
  host(): string {
    return this.parsed.authority;
  }

  /**
   * The URL SCHEME (03 §7.3 C4) — passed across the facade alongside `host()` so the
   * HTTPS credential helper key is scheme-aware. git credential matching is
   * scheme+authority sensitive: `credential.https://h.helper` does NOT match a
   * plaintext `http://h/` remote, so a plaintext internal git host would never receive
   * its token unless the helper is keyed on the ACTUAL scheme.
   */
  scheme(): GitRemoteScheme {
    return this.parsed.scheme;
  }
}
