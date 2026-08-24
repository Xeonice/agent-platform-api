import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { SimpleGitCloner } from '../../src/infrastructure/git/git-cloner';
import { SimpleGitBaseline } from '../../src/infrastructure/git/baseline-git';

/**
 * 完整克隆 + 建 Task 选分支 (docs/backend/03 §7.2★) — against a REAL git remote.
 *
 * ── THE MUTATION THIS FILE EXISTS FOR ─────────────────────────────────────────────
 * Put `--single-branch` back into `SimpleGitCloner`'s argv (that is exactly what the
 * shallow version passed whenever `repoBranch` was set) and BOTH judgements below go
 * red: `listBranches` collapses to one name, and 「选非默认分支」 dies with
 * `pathspec 'feature/x' did not match any file(s) known to git`. A unit test with a
 * mocked git could not see either — the failure is a property of what git actually
 * fetched, so the remote has to be real.
 *
 * A local bare repo is the remote on purpose: `--single-branch` applies to local
 * clones (verified below), no network is involved, and nothing can flake.
 *
 * ⚠️ `--depth` alone would prove nothing here — git IGNORES `--depth` for a local-path
 * clone ("warning: --depth is ignored in local clones"). `--single-branch` is the half
 * that actually decided 「能不能选分支」, and it is the half under test.
 */
const gitOk = ((): boolean => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();
if (!gitOk) {
  console.warn(
    '\n\x1b[33m[full-clone-branches] SKIPPED — no `git` on PATH. This is the FULL-CLONE ' +
      'acceptance (选分支 depends on it). NOT fake-passed.\x1b[0m\n',
  );
}

/** git refuses to commit without an identity, and CI runners often have none. */
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'platform-test',
  GIT_AUTHOR_EMAIL: 'test@platform.invalid',
  GIT_COMMITTER_NAME: 'platform-test',
  GIT_COMMITTER_EMAIL: 'test@platform.invalid',
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' });
}

function cloneRequest(repoUrl: string, destPath: string, repoBranch: string | null) {
  return {
    repoUrl,
    repoBranch,
    destPath,
    timeoutMs: 60_000,
    signal: new AbortController().signal,
    onProgress: () => {},
  };
}

describe.skipIf(!gitOk)('full clone keeps every branch (03 §7.2★)', () => {
  let root: string;
  let origin: string;

  beforeAll(() => {
    root = mkdtempSync(resolve(tmpdir(), 'platform-fullclone-'));
    // a remote with TWO branches: `main` (default) and `feature/x`, the latter holding
    // a file that exists ONLY there — presence of that file is how a test proves the
    // workspace really moved, rather than just claiming a branch name.
    const work = resolve(root, 'work');
    execFileSync('git', ['init', '-q', '-b', 'main', work], { env: GIT_ENV });
    writeFileSync(resolve(work, 'README.md'), 'baseline\n');
    git(work, 'add', '-A');
    git(work, 'commit', '-q', '-m', 'init');
    git(work, 'checkout', '-q', '-b', 'feature/x');
    writeFileSync(resolve(work, 'only-on-feature.txt'), 'feature\n');
    git(work, 'add', '-A');
    git(work, 'commit', '-q', '-m', 'feature');
    git(work, 'checkout', '-q', 'main');
    origin = resolve(root, 'origin.git');
    execFileSync('git', ['clone', '-q', '--bare', work, origin], { env: GIT_ENV });
  });

  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it('选非默认分支: a COPY of the baseline checks out a non-default branch, locally', async () => {
    // This is 「建 Task 选分支」 reduced to its physics: what preparing-workspace does is
    // copy the baseline and run one local checkout. Under `--single-branch` this
    // throws `pathspec 'feature/x' did not match any file(s) known to git` — the exact
    // measured failure 03 §7.2★ cites as the reason the shallow option is gone.
    //
    // Deliberately the FIRST assertion in its own `it`, so the mutation is caught HERE
    // and not merely as a side effect of the branch list shrinking one test down.
    const dest = resolve(root, 'baseline-checkout');
    await new SimpleGitCloner().clone(cloneRequest(origin, dest, null));
    const copy = resolve(root, 'copy-checkout');
    execFileSync('cp', ['-a', dest, copy]);

    git(copy, 'checkout', 'feature/x', '--');
    expect(git(copy, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('feature/x');
    // the branch-only file proves the WORKING TREE moved, not just a ref name.
    expect(existsSync(resolve(copy, 'only-on-feature.txt'))).toBe(true);
  }, 60_000);

  it('the branch picker sees BOTH branches, read from LOCAL refs', async () => {
    const dest = resolve(root, 'baseline-default');
    await new SimpleGitCloner().clone(cloneRequest(origin, dest, null));
    expect(await new SimpleGitBaseline().listBranches(dest)).toEqual(['feature/x', 'main']);
  }, 60_000);

  it('`--branch` pins the checkout WITHOUT narrowing the fetch (why it survived the change)', async () => {
    // 03 §7.2★ keeps `--branch` and drops `--single-branch`, on the claim that the
    // former only decides WHICH branch ends up checked out. If that claim were wrong,
    // every project created with a `repoBranch` would silently lose branch selection —
    // which is precisely the shape of the original bug.
    const dest = resolve(root, 'baseline-pinned');
    await new SimpleGitCloner().clone(cloneRequest(origin, dest, 'feature/x'));

    expect(git(dest, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('feature/x');
    expect(await new SimpleGitBaseline().listBranches(dest)).toEqual(['feature/x', 'main']);
  }, 60_000);

  it('listBranches drops the symbolic `origin/HEAD -> origin/main` pseudo-ref', async () => {
    const dest = resolve(root, 'baseline-head');
    await new SimpleGitCloner().clone(cloneRequest(origin, dest, null));
    // `git branch -r` really does print that line here…
    expect(git(dest, 'branch', '-r')).toContain('origin/HEAD ->');
    // …and it must never reach a picker, where it would render as a branch called
    // 「HEAD -> origin/main」 that no checkout can use.
    const branches = await new SimpleGitBaseline().listBranches(dest);
    expect(branches).not.toContain('HEAD');
    expect(branches.some((b) => b.includes('->'))).toBe(false);
  }, 60_000);
});
