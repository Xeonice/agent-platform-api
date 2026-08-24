import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterAll, beforeAll, afterEach, describe, it, expect } from 'vitest';
import { FsWorkspacePreparer } from '../../src/infrastructure/workspace/workspace-preparer';

/**
 * `preparing-workspace` 的选分支一步 (docs/backend/03 §7.2★ / §7.6 step 2.5) — against
 * a REAL git baseline.
 *
 * ── THE MUTATIONS THIS FILE EXISTS FOR ────────────────────────────────────────────
 *   ① delete the `checkoutBranch(...)` call from `prepare()` → the workspace silently
 *      stays on the baseline's default branch. That is the WORST failure mode this
 *      feature has: the Task runs, the terminal opens, everything looks fine, and the
 *      agent is editing the wrong code. Nothing but a working-tree assertion catches it.
 *   ② strip `checkoutEnv()` back to `{...process.env}` → an ambient `GIT_DIR` makes
 *      git act on a DIFFERENT repository and the hijack test below goes red.
 *   ③ write the argv as `['checkout', '--', branch]` instead of
 *      `['checkout', branch, '--']` → git reads the name as a PATH ("discard local
 *      edits to this file"), so a branch whose name also names a tracked file reverts a
 *      file and leaves HEAD where it was. The `branch-named-like-a-file` case below is
 *      the guard for exactly that, and it is red under ③ while green under ①'s absence.
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
    '\n\x1b[33m[workspace-branch] SKIPPED — no `git` on PATH. This is the 建 Task 选分支 ' +
      'acceptance. NOT fake-passed.\x1b[0m\n',
  );
}

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

describe.skipIf(!gitOk)('workspace preparation switches to the requested branch', () => {
  let root: string;
  let baseline: string;
  const previousDataRoot = process.env.DATA_ROOT;

  beforeAll(() => {
    root = mkdtempSync(resolve(tmpdir(), 'platform-wsbranch-'));
    process.env.DATA_ROOT = resolve(root, 'data');

    // The BASELINE is built by plain git here on purpose: this file is about what
    // `FsWorkspacePreparer` does to a copy, not about how the baseline was produced.
    // (`SimpleGitCloner`'s own full-clone guarantee is pinned in the project module's
    // `full-clone-branches.spec.ts`.) It IS a full clone, so it holds every ref —
    // which is the precondition the checkout below depends on.
    const work = resolve(root, 'work');
    execFileSync('git', ['init', '-q', '-b', 'main', work], { env: GIT_ENV });
    writeFileSync(resolve(work, 'README.md'), 'baseline\n');
    // a tracked file whose NAME is also a branch name — the trap for argv order.
    writeFileSync(resolve(work, 'release'), 'on main\n');
    git(work, 'add', '-A');
    git(work, 'commit', '-q', '-m', 'init');
    git(work, 'checkout', '-q', '-b', 'feature/x');
    writeFileSync(resolve(work, 'only-on-feature.txt'), 'feature\n');
    git(work, 'add', '-A');
    git(work, 'commit', '-q', '-m', 'feature');
    git(work, 'checkout', '-q', '-b', 'release');
    writeFileSync(resolve(work, 'release'), 'on release\n');
    git(work, 'add', '-A');
    git(work, 'commit', '-q', '-m', 'release');
    git(work, 'checkout', '-q', 'main');
    const origin = resolve(root, 'origin.git');
    execFileSync('git', ['clone', '-q', '--bare', work, origin], { env: GIT_ENV });
    baseline = resolve(root, 'baseline');
    execFileSync('git', ['clone', '-q', origin, baseline], { env: GIT_ENV });
  });

  afterEach(() => {
    rmSync(resolve(root, 'data', 'workspaces'), { recursive: true, force: true });
  });

  afterAll(() => {
    if (previousDataRoot === undefined) delete process.env.DATA_ROOT;
    else process.env.DATA_ROOT = previousDataRoot;
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it('a requested branch lands in the workspace WORKING TREE, not just in HEAD', async () => {
    const ws = await new FsWorkspacePreparer().prepare('sbx-branch', {
      baselinePath: baseline,
      branch: 'feature/x',
    });
    expect(git(ws.hostPath, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('feature/x');
    // the file exists ONLY on that branch — this is what "the agent edits the right
    // code" actually means, and it is what a HEAD-only assertion would miss.
    expect(existsSync(resolve(ws.hostPath, 'only-on-feature.txt'))).toBe(true);
  }, 60_000);

  it('a branch whose name is also a tracked file switches the BRANCH (argv order)', async () => {
    const ws = await new FsWorkspacePreparer().prepare('sbx-ambiguous', {
      baselinePath: baseline,
      branch: 'release',
    });
    expect(git(ws.hostPath, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('release');
    // `git checkout -- release` would have "restored" the FILE and left HEAD on main,
    // leaving this content at its main value.
    expect(git(ws.hostPath, 'show', 'HEAD:release')).toContain('on release');
  }, 60_000);

  it('an ambient GIT_DIR cannot redirect the checkout at another repository', async () => {
    // `cwd` alone does NOT decide which repo git acts on — GIT_DIR/GIT_WORK_TREE
    // outrank it. Inherited from a git hook or a harness (vitest already leaks
    // `EDITOR` into children), they would make this checkout succeed against SOMEONE
    // ELSE'S repo while the workspace quietly stayed on the default branch.
    const decoy = resolve(root, 'decoy');
    execFileSync('git', ['init', '-q', '-b', 'main', decoy], { env: GIT_ENV });
    writeFileSync(resolve(decoy, 'x'), 'x\n');
    git(decoy, 'add', '-A');
    git(decoy, 'commit', '-q', '-m', 'decoy');

    const previousGitDir = process.env.GIT_DIR;
    process.env.GIT_DIR = resolve(decoy, '.git');
    try {
      const ws = await new FsWorkspacePreparer().prepare('sbx-hijack', {
        baselinePath: baseline,
        branch: 'feature/x',
      });
      expect(git(ws.hostPath, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('feature/x');
      expect(existsSync(resolve(ws.hostPath, 'only-on-feature.txt'))).toBe(true);
    } finally {
      if (previousGitDir === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = previousGitDir;
    }
  }, 60_000);

  it('no branch requested ⇒ the baseline’s own checkout is kept untouched', async () => {
    const ws = await new FsWorkspacePreparer().prepare('sbx-default', { baselinePath: baseline });
    expect(git(ws.hostPath, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('main');
    expect(existsSync(resolve(ws.hostPath, 'only-on-feature.txt'))).toBe(false);
  }, 60_000);
});
