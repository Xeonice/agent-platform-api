import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { SimpleGitBaseline } from '../../src/infrastructure/git/baseline-git';

/**
 * L-9 存量浅克隆基线的迁移 —— against a REAL git remote.
 *
 * ── 为什么这条必须用真 git ────────────────────────────────────────────────────
 * 因为**文档给的错修法能让假测试变绿**。LIVE-RUN-FINDINGS 的 L-9 写着「探测
 * `.git/shallow`，存在则 `git fetch --unshallow`」，配的验收是「sync 后
 * `git rev-list --count HEAD` 应大于 1」。实测：
 *
 * ```
 *   git clone --depth=1 file://…    → 提交 1，分支 [origin/main]
 *   git fetch --unshallow           → 提交 3，分支 [origin/main]   ← 分支数没变
 * ```
 *
 * 那条验收会绿，**而用户抱怨的那件事（选分支时只有一个分支）一点没修**。`--depth`
 * 隐含 `--single-branch`，refspec 被钉成单分支，`--unshallow` 只按 refspec 加深。
 * 深度和分支是被 `--depth=1` 同时关上的**两扇门**。
 *
 * 所以下面每条都断言**分支**，而不只是提交数 —— 提交数是那个错修法也能满足的指标。
 *
 * ⚠️ 远端用 `file://` URL 而不是裸路径：git 对**本地路径**克隆会忽略 `--depth`
 * （"warning: --depth is ignored in local clones"），那样就造不出浅仓，整个用例会
 * 变成一个测不到东西的空壳。
 *
 * MUTATION: 去掉 `unshallow()` 里的 `remote set-branches` 那一行（即退回 L-9 的原建议）
 * ⇒ 第一条红在分支断言上、绿在提交断言上 —— 正好复现"错修法配错验收"的那一幕。
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
    '\n\x1b[33m[shallow-baseline-migration] SKIPPED — no `git` on PATH. This is the L-9 ' +
      'acceptance (存量浅基线能不能迁移). NOT fake-passed.\x1b[0m\n',
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

function fetchRequest(repoPath: string) {
  return { repoPath, timeoutMs: 60_000, signal: new AbortController().signal };
}

/** Remote-tracking branch names, `origin/HEAD` excluded — what the picker would offer. */
function remoteBranches(repoPath: string): string[] {
  return git(repoPath, 'branch', '-r')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.includes('->'))
    .sort();
}

const commitCount = (repoPath: string): number =>
  Number(git(repoPath, 'rev-list', '--count', 'HEAD').trim());

describe.skipIf(!gitOk)('L-9 存量浅基线在 sync 时迁移成完整克隆', () => {
  let root: string;
  let originUrl: string;

  beforeAll(() => {
    root = mkdtempSync(resolve(tmpdir(), 'platform-l9-'));
    const work = resolve(root, 'work');
    execFileSync('git', ['init', '-q', '-b', 'main', work], { env: GIT_ENV });
    // 三个提交，这样"浅仓只有 1 个提交"与"完整仓有 3 个"能区分开。
    for (const n of ['c1', 'c2', 'c3']) {
      writeFileSync(resolve(work, 'README.md'), `${n}\n`);
      git(work, 'add', '-A');
      git(work, 'commit', '-q', '-m', n);
    }
    git(work, 'checkout', '-q', '-b', 'feature/x');
    writeFileSync(resolve(work, 'only-on-feature.txt'), 'feature\n');
    git(work, 'add', '-A');
    git(work, 'commit', '-q', '-m', 'feature');
    git(work, 'checkout', '-q', 'main');
    const origin = resolve(root, 'origin.git');
    execFileSync('git', ['clone', '-q', '--bare', work, origin], { env: GIT_ENV });
    originUrl = `file://${origin}`;
  });

  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  /** A baseline built the OLD way — this is what every pre-03 §7.2★ project looks like. */
  function legacyShallowBaseline(name: string): string {
    const dest = resolve(root, name);
    execFileSync('git', ['clone', '-q', '--depth=1', originUrl, dest], { env: GIT_ENV });
    return dest;
  }

  it('迁移前：确实是浅仓，且只有一个分支（这就是用户看到的症状）', () => {
    const baseline = legacyShallowBaseline('before');
    expect(git(baseline, 'rev-parse', '--is-shallow-repository').trim()).toBe('true');
    expect(commitCount(baseline)).toBe(1);
    expect(remoteBranches(baseline)).toEqual(['origin/main']); // feature/x 不在
  });

  it('sync 之后：不再是浅仓，且**所有分支**都回来了', async () => {
    const baseline = legacyShallowBaseline('migrated');
    await new SimpleGitBaseline().fetchAll(fetchRequest(baseline));

    // ① 深度那扇门 —— L-9 原建议只修到这里为止。
    expect(git(baseline, 'rev-parse', '--is-shallow-repository').trim()).toBe('false');
    expect(commitCount(baseline)).toBeGreaterThan(1);
    // ② 分支那扇门 —— 用户真正抱怨的那件事。只修 ① 时这一条仍然红。
    expect(remoteBranches(baseline)).toEqual(['origin/feature/x', 'origin/main']);
  }, 60_000);

  it('迁移后基线可以真的检出那个新分支 —— 这才是「建 Task 选分支」要的东西', async () => {
    const baseline = legacyShallowBaseline('checkoutable');
    await new SimpleGitBaseline().fetchAll(fetchRequest(baseline));

    // preparing-workspace 做的事：复制基线 + 一次本地 checkout（03 §7.6）。
    const copy = resolve(root, 'checkoutable-copy');
    execFileSync('cp', ['-a', baseline, copy]);
    git(copy, 'checkout', 'feature/x', '--');
    expect(git(copy, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('feature/x');
    // 分支独有文件证明工作树真的动了，而不只是一个 ref 名字。
    expect(git(copy, 'ls-files', 'only-on-feature.txt').trim()).toBe('only-on-feature.txt');
  }, 60_000);

  it('已经完整的基线：sync 走 --all，不会碰 --unshallow（那会 fatal）', async () => {
    const dest = resolve(root, 'already-full');
    execFileSync('git', ['clone', '-q', originUrl, dest], { env: GIT_ENV });
    expect(git(dest, 'rev-parse', '--is-shallow-repository').trim()).toBe('false');

    // MUTATION: 把 `if (await isShallow(...))` 去掉、无条件 unshallow ⇒ 这里抛
    // `--unshallow on a complete repository does not make sense`。这正是 L-9 当初被
    // 留作待办的原因 —— 不能无条件加。
    await expect(new SimpleGitBaseline().fetchAll(fetchRequest(dest))).resolves.toBeUndefined();
    expect(remoteBranches(dest)).toEqual(['origin/feature/x', 'origin/main']);
  }, 60_000);

  it('重复 sync 幂等 —— 迁移过的基线再同步一次不会报错', async () => {
    const baseline = legacyShallowBaseline('twice');
    await new SimpleGitBaseline().fetchAll(fetchRequest(baseline));
    await expect(new SimpleGitBaseline().fetchAll(fetchRequest(baseline))).resolves.toBeUndefined();
    expect(remoteBranches(baseline)).toEqual(['origin/feature/x', 'origin/main']);
  }, 60_000);
});
