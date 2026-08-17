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
  it('accepts https / git / scp-like urls', () => {
    expect(RepoUrl.create('https://github.com/octocat/Hello-World.git').value).toContain('github');
    expect(RepoUrl.create('git://example.com/x.git').value).toBeDefined();
    expect(RepoUrl.create('git@github.com:octocat/Hello-World.git').value).toBeDefined();
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
    expect(RepoUrl.create('https://git.company.com:8443/x/y.git').host()).toBe('git.company.com:8443');
    expect(RepoUrl.create('http://git.company.com:3000/x.git').host()).toBe('git.company.com:3000');
    expect(RepoUrl.create('git@git.company.com:owner/repo.git').host()).toBe('git.company.com'); // scp, no port
  });

  it('credentialKind() picks by protocol', () => {
    expect(RepoUrl.create('https://git.company.com:8443/x.git').credentialKind()).toBe('git-https-token');
    expect(RepoUrl.create('git@git.company.com:owner/repo.git').credentialKind()).toBe('git-ssh-key');
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
});
