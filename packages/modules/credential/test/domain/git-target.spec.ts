import { describe, it, expect } from 'vitest';
import { isBlockedGitHost } from '@platform/shared-kernel';
import { parseGitTarget } from '../../src/domain/services/git-target.util';

/**
 * The credential TEST path (`/git/test`) parses the repo URL with `parseGitTarget` —
 * which now shares the SAME parser + SSRF blocklist as the clone path's `RepoUrl`.
 * These prove: (1) the accepted URL SHAPES match RepoUrl (incl. `ssh://host:port`),
 * (2) `canonicalHost` is what the SSRF blocklist must reject, closing the hole where
 * `git ls-remote ssh://git@169.254.169.254/x` could probe cloud metadata / internal
 * hosts, including obfuscated-IPv4 forms a naive regex misses.
 */
describe('parseGitTarget (credential test path — shape + kind + scheme)', () => {
  it('maps scheme → kind and exposes the canonical authority', () => {
    expect(parseGitTarget('https://github.com/o/r.git')).toMatchObject({
      kind: 'git-https-token',
      host: 'github.com',
      scheme: 'https',
      canonicalHost: 'github.com',
    });
    expect(parseGitTarget('http://git.company.com:3000/x.git')).toMatchObject({
      kind: 'git-https-token',
      host: 'git.company.com:3000',
      scheme: 'http',
    });
    expect(parseGitTarget('git@git.company.com:owner/repo.git')).toMatchObject({
      kind: 'git-ssh-key',
      host: 'git.company.com',
      scheme: 'ssh',
    });
    // ssh:// with a non-default port — accepted (RepoUrl accepts it too; no假阳性).
    expect(parseGitTarget('ssh://git@git.company.com:2222/x.git')).toMatchObject({
      kind: 'git-ssh-key',
      host: 'git.company.com:2222',
      scheme: 'ssh',
      canonicalHost: 'git.company.com',
    });
    // git:// is anonymous (no auth) — accepted like RepoUrl (both paths agree).
    expect(parseGitTarget('git://git.company.com/x.git')).toMatchObject({
      kind: 'git-https-token',
      scheme: 'git',
    });
  });

  it('returns null for unsupported shapes', () => {
    for (const bad of ['', '   ', 'not a url', 'ftp://x/y', 'javascript:alert(1)']) {
      expect(parseGitTarget(bad), bad).toBeNull();
    }
  });
});

describe('SSRF blocklist parity — test path rejects the SAME hosts the clone path does', () => {
  it('BLOCKS loopback / link-local+metadata / unspecified / localhost (incl. ssh:// + obfuscated)', () => {
    const blocked = [
      'http://127.0.0.1/x',
      'https://127.1.2.3/x',
      'http://169.254.169.254/latest/meta-data',
      'http://0.0.0.0/x',
      'http://localhost/x',
      'https://[::1]/x',
      'http://[fe80::1]/x',
      'http://[::ffff:127.0.0.1]/x',
      'git://127.0.0.1/x',
      'git@127.0.0.1:owner/repo.git',
      'git@localhost:owner/repo.git',
      // the previously-uncaught test-path holes:
      'ssh://git@169.254.169.254/x',
      'ssh://git@127.0.0.1:2222/x',
      'git@0177.0.0.1:x', // octal loopback (scp)
      'git@127.0.0.1.:x', // trailing-dot loopback (scp)
      'http://2130706433/x', // decimal loopback
      'http://0x7f000001/x', // hex loopback
    ];
    for (const url of blocked) {
      const t = parseGitTarget(url);
      expect(t, `${url} should parse`).not.toBeNull();
      expect(isBlockedGitHost(t!.canonicalHost), `${url} should be blocked`).toBe(true);
    }
  });

  it('ALLOWS private LAN + public hosts (canonicalHost not blocked)', () => {
    for (const url of [
      'http://10.0.0.5/x.git',
      'http://172.16.0.1/x.git',
      'http://192.168.1.10/x.git',
      'ssh://git@192.168.1.10:2222/x.git',
      'https://github.com/o/r.git',
      'https://8.8.8.8/x.git',
      'ssh://git@git.company.com:2222/x.git',
    ]) {
      const t = parseGitTarget(url);
      expect(t, `${url} should parse`).not.toBeNull();
      expect(isBlockedGitHost(t!.canonicalHost), `${url} should be allowed`).toBe(false);
    }
  });
});
