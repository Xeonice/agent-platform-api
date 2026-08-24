import { describe, it, expect } from 'vitest';
import { asProjectId } from '@platform/shared-kernel';
import { Project } from '../../src/domain/entities/project.entity';
import { RepoUrl } from '../../src/domain/value-objects/repo-url.vo';
import { CloneStatusVO } from '../../src/domain/value-objects/project-status.vo';
import {
  InvalidRepoUrlError,
  InvalidProjectTransitionError,
  ProjectStateError,
} from '../../src/domain/errors/project-errors';

const NOW = new Date('2026-08-17T00:00:00.000Z');
const base = { id: asProjectId('prj-1'), name: 'demo', baselinePath: '/b/prj-1', now: NOW };

describe('RepoUrl', () => {
  it('accepts https / git / scp-like / ssh:// urls', () => {
    expect(RepoUrl.create('https://github.com/octocat/Hello-World.git').value).toContain('github');
    expect(RepoUrl.create('git://example.com/x.git').value).toBeDefined();
    expect(RepoUrl.create('git@github.com:octocat/Hello-World.git').value).toBeDefined();
    // self-hosted SSH on a NON-default port — scp form cannot express a port, so the
    // ssh:// shape must be accepted end-to-end (parity with the credential test path).
    expect(RepoUrl.create('ssh://git@git.company.com:2222/owner/repo.git').value).toBeDefined();
    expect(RepoUrl.create('ssh://git.company.com/owner/repo.git').value).toBeDefined();
  });
  it('rejects junk', () => {
    for (const bad of ['', '   ', 'not a url', 'ftp://x', 'javascript:alert(1)']) {
      expect(() => RepoUrl.create(bad)).toThrow(InvalidRepoUrlError);
    }
  });

  it('host() returns an AUTHORITY: default port omitted, non-default port kept (C4)', () => {
    // git ≥ 2.50 credential matching is port-sensitive, so the authority carries the
    // non-default port. Self-hosted GitLab/Gitea commonly run on :8443/:3000.
    expect(RepoUrl.create('https://github.com/x/y.git').host()).toBe('github.com');
    expect(RepoUrl.create('https://github.com:443/x/y.git').host()).toBe('github.com'); // default → omit
    expect(RepoUrl.create('https://git.company.com:8443/x/y.git').host()).toBe(
      'git.company.com:8443',
    );
    expect(RepoUrl.create('http://git.company.com:3000/x.git').host()).toBe('git.company.com:3000');
    expect(RepoUrl.create('git@git.company.com:owner/repo.git').host()).toBe('git.company.com'); // scp, no port
    // ssh:// carries a port; authority keeps a non-default one (22 is dropped).
    expect(RepoUrl.create('ssh://git@git.company.com:2222/owner/repo.git').host()).toBe(
      'git.company.com:2222',
    );
    expect(RepoUrl.create('ssh://git@git.company.com:22/owner/repo.git').host()).toBe(
      'git.company.com',
    );
  });

  it('credentialKind() picks by protocol', () => {
    expect(RepoUrl.create('https://git.company.com:8443/x.git').credentialKind()).toBe(
      'git-https-token',
    );
    expect(RepoUrl.create('git@git.company.com:owner/repo.git').credentialKind()).toBe(
      'git-ssh-key',
    );
    expect(RepoUrl.create('ssh://git@git.company.com:2222/x.git').credentialKind()).toBe(
      'git-ssh-key',
    );
  });

  it('scheme() returns the URL scheme (drives the scheme-aware helper key, C4)', () => {
    expect(RepoUrl.create('https://git.company.com/x.git').scheme()).toBe('https');
    expect(RepoUrl.create('http://git.company.com:3000/x.git').scheme()).toBe('http');
    expect(RepoUrl.create('git@git.company.com:owner/repo.git').scheme()).toBe('ssh'); // scp form
    expect(RepoUrl.create('ssh://git@git.company.com:2222/x.git').scheme()).toBe('ssh');
    expect(RepoUrl.create('git://git.company.com/x.git').scheme()).toBe('git');
  });

  it('blocks SSRF to loopback / link-local / metadata (never a git host, 03 §7.3 C4)', () => {
    const blocked = [
      'http://localhost/x.git',
      'https://localhost:8080/x.git',
      'http://127.0.0.1/x.git',
      'https://127.1.2.3/x.git',
      'http://169.254.169.254/latest/meta-data', // cloud metadata
      'http://0.0.0.0/x.git',
      'git://127.0.0.1/x.git',
      'https://[::1]/x.git',
      'http://[fe80::1]/x.git',
      'http://[::ffff:127.0.0.1]/x.git',
      'git@127.0.0.1:owner/repo.git', // scp-like to loopback
      'git@localhost:owner/repo.git',
      // ssh:// to internal targets — the test path accepts ssh://, so the clone path
      // MUST block the same (no ls-remote to metadata / loopback on a non-default port).
      'ssh://git@169.254.169.254/x',
      'ssh://git@127.0.0.1:2222/x',
      'ssh://git@localhost/x',
      // obfuscated IPv4 that a naive dotted-decimal regex misses — canonicalised first.
      'git@0177.0.0.1:x', // octal 127.0.0.1
      'git@127.0.0.1.:x', // trailing-dot 127.0.0.1
      'http://0177.0.0.1/x', // octal loopback over http
      'http://2130706433/x', // decimal loopback
      'http://0x7f000001/x', // hex loopback
    ];
    for (const url of blocked) {
      expect(() => RepoUrl.create(url), url).toThrow(InvalidRepoUrlError);
    }
  });

  it('ALLOWS private LAN hosts — internal self-hosted git is a core use case (C4)', () => {
    // Private ranges are legitimate git hosts on a single-machine on-prem deploy;
    // where a credential may be sent is governed by allowedHosts, not this blocklist.
    for (const url of [
      'http://10.0.0.5/x.git',
      'http://172.16.0.1/x.git',
      'http://172.31.255.1/x.git',
      'http://192.168.1.10/x.git',
      'http://[fc00::1]/x.git',
      'git@192.168.1.10:owner/repo.git', // scp-like to a private LAN host
      'ssh://git@192.168.1.10:2222/x.git', // ssh:// to a private LAN host, non-default port
    ]) {
      expect(() => RepoUrl.create(url), url).not.toThrow();
    }
  });

  it('allows public hosts (incl. public IPs)', () => {
    for (const url of [
      'https://github.com/octocat/Hello-World.git',
      'http://gitlab.com/x/y.git',
      'https://8.8.8.8/x.git',
      'git@github.com:octocat/Hello-World.git',
    ]) {
      expect(() => RepoUrl.create(url), url).not.toThrow();
    }
  });
});

describe('CloneStatusVO transitions', () => {
  it('cloning → ready|failed; failed → cloning|ready; ready terminal', () => {
    expect(CloneStatusVO.canTransitionTo('cloning', 'ready')).toBe(true);
    expect(CloneStatusVO.canTransitionTo('cloning', 'failed')).toBe(true);
    expect(CloneStatusVO.canTransitionTo('failed', 'cloning')).toBe(true);
    expect(CloneStatusVO.canTransitionTo('failed', 'ready')).toBe(true);
    expect(CloneStatusVO.canTransitionTo('ready', 'cloning')).toBe(false);
    expect(CloneStatusVO.canTransitionTo('cloning', 'cloning')).toBe(false);
  });
});

describe('Project aggregate', () => {
  it('git project starts cloning; empty project is ready immediately', () => {
    const git = Project.create({ ...base, sourceType: 'git', repoUrl: 'https://h/x.git' });
    expect(git.cloneStatus).toBe('cloning');
    expect(git.repoUrl).toBe('https://h/x.git');
    expect(git.baselineSizeBytes).toBeNull();

    const empty = Project.create({ ...base, sourceType: 'empty' });
    expect(empty.cloneStatus).toBe('ready');
    expect(empty.repoUrl).toBeNull();
    expect(empty.baselineSizeBytes).toBe(0);
  });

  it('enforces I-PRJ-1 (git⇒url, empty⇒no url)', () => {
    expect(() => Project.create({ ...base, sourceType: 'git' })).toThrow(ProjectStateError);
    expect(() =>
      Project.create({ ...base, sourceType: 'empty', repoUrl: 'https://h/x.git' }),
    ).toThrow(ProjectStateError);
  });

  it('rejects a malformed repo url at create', () => {
    expect(() => Project.create({ ...base, sourceType: 'git', repoUrl: 'nope' })).toThrow(
      InvalidRepoUrlError,
    );
  });

  it('clone success: cloning → ready with baseline size; only from cloning', () => {
    const p = Project.create({ ...base, sourceType: 'git', repoUrl: 'https://h/x.git' });
    p.markCloneReady(4096, NOW);
    expect(p.cloneStatus).toBe('ready');
    expect(p.baselineSizeBytes).toBe(4096);
    expect(p.cloneErrorCode).toBeNull();
    // ready is terminal — cannot re-ready
    expect(() => p.markCloneReady(1, NOW)).toThrow(InvalidProjectTransitionError);
  });

  it('clone failure sets error code; retry clears it; convert makes it empty', () => {
    const p = Project.create({ ...base, sourceType: 'git', repoUrl: 'https://h/x.git' });
    p.markCloneFailed('CLONE_FAILED_NETWORK', NOW);
    expect(p.cloneStatus).toBe('failed');
    expect(p.cloneErrorCode).toBe('CLONE_FAILED_NETWORK');

    p.retryClone(NOW);
    expect(p.cloneStatus).toBe('cloning');
    expect(p.cloneErrorCode).toBeNull();

    p.markCloneFailed('TIMEOUT', NOW);
    p.convertToEmpty(NOW);
    expect(p.cloneStatus).toBe('ready');
    expect(p.sourceType).toBe('empty');
    expect(p.repoUrl).toBeNull();
    expect(p.cloneErrorCode).toBeNull();
  });

  it('retry/convert only allowed on failed', () => {
    const p = Project.create({ ...base, sourceType: 'git', repoUrl: 'https://h/x.git' });
    expect(() => p.retryClone(NOW)).toThrow(ProjectStateError); // cloning
    expect(() => p.convertToEmpty(NOW)).toThrow(ProjectStateError);
  });

  it('assertCanAcceptTask passes only when ready', () => {
    const cloning = Project.create({ ...base, sourceType: 'git', repoUrl: 'https://h/x.git' });
    expect(() => cloning.assertCanAcceptTask()).toThrow(ProjectStateError);
    const empty = Project.create({ ...base, sourceType: 'empty' });
    expect(() => empty.assertCanAcceptTask()).not.toThrow();
  });

  // ── 基线同步 (03 §7.2★) ────────────────────────────────────────────────────────
  it('syncBaseline refreshes size + updatedAt WITHOUT moving the clone state', () => {
    const p = Project.create({ ...base, sourceType: 'git', repoUrl: 'https://h/x.git' });
    p.markCloneReady(1_000, NOW);
    const later = new Date(NOW.getTime() + 86_400_000);

    p.syncBaseline(7_777, later);

    expect(p.baselineSizeBytes).toBe(7_777);
    expect(p.updatedAt).toEqual(later);
    // `ready → ready` is NOT a transition: `CloneStatusVO` treats `ready` as terminal,
    // so routing a sync through `transition()` would throw InvalidProjectTransition and
    // make the endpoint permanently 409.
    expect(p.cloneStatus).toBe('ready');
  });

  it('syncBaseline is refused on a project with nothing to fetch', () => {
    const cloning = Project.create({ ...base, sourceType: 'git', repoUrl: 'https://h/x.git' });
    expect(() => cloning.syncBaseline(1, NOW)).toThrow(ProjectStateError);
    expect(() => cloning.assertCanSync()).toThrow(ProjectStateError);

    // an EMPTY project is `ready` — the STATE alone would let it through, and then
    // `git fetch` would run inside a directory that is not a repository. The source
    // type is the second half of the guard, and it is the half a state check misses.
    const empty = Project.create({ ...base, sourceType: 'empty' });
    expect(empty.cloneStatus).toBe('ready');
    expect(() => empty.assertCanSync()).toThrow(ProjectStateError);
  });

  it('convert-to-empty then sync: the source is gone, so the sync is too', () => {
    const p = Project.create({ ...base, sourceType: 'git', repoUrl: 'https://h/x.git' });
    p.markCloneFailed('CLONE_FAILED_NETWORK', NOW);
    p.convertToEmpty(NOW);
    expect(() => p.assertCanSync()).toThrow(ProjectStateError);
  });
});
