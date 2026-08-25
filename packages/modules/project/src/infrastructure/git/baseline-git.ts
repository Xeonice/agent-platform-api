import { Injectable } from '@nestjs/common';
import { simpleGit } from 'simple-git';
import type { SimpleGit } from 'simple-git';
import type { BaselineGit, FetchRequest } from '../../domain/ports/baseline-git.port';
import { CloneError } from '../../domain/ports/git-cloner.port';
import { classifyCloneError, sanitizeCloneMessage } from './error.classifier';
import { authUnsafe, cleanGitEnv, mergeAuthEnv } from './git-env';

/** How many remote-tracking refs one response may carry — a guard, not a page size. */
const MAX_BRANCHES = 5000;

/**
 * simple-git `BaselineGit` (docs/backend/03 §7.2★): the two git operations that run
 * against an existing baseline.
 */
@Injectable()
export class SimpleGitBaseline implements BaselineGit {
  /**
   * `git branch -r`, LOCAL. Two details are load-bearing:
   *
   *   ① simple-git's `branch(['-r'])` parser already drops the symbolic
   *      `origin/HEAD -> origin/main` line, which a hand-rolled split on `\n` would
   *      hand back as a bogus branch name.
   *   ② the `origin/` prefix is stripped, because the value's ONLY consumer is
   *      `CreateSandbox.branch` → `git checkout <name>` in the fresh workspace.
   *      `git checkout origin/x` lands in DETACHED HEAD; `git checkout x` DWIMs into a
   *      local branch tracking `origin/x`, which is what a user picking "x" means.
   */
  async listBranches(repoPath: string): Promise<string[]> {
    const git = simpleGit({ baseDir: repoPath, unsafe: authUnsafe() }).env(cleanGitEnv());
    const remotes = await git.getRemotes(false);
    const prefixes = remotes.map((r) => `${r.name}/`);
    const summary = await git.branch(['-r']);
    const names = new Set<string>();
    for (const ref of summary.all) {
      const prefix = prefixes.find((p) => ref.startsWith(p));
      const name = prefix === undefined ? ref : ref.slice(prefix.length);
      if (name !== '' && name !== 'HEAD') names.add(name);
    }
    return [...names].sort().slice(0, MAX_BRANCHES);
  }

  /**
   * `git fetch --all`, or — on a baseline left over from the shallow-clone era — the
   * migration to a complete one (L-9).
   *
   * Runs under the SAME hermetic env as a clone (`git-env.ts`): a sync that fell back
   * to an ambient credential helper would authenticate with a host-cached token for a
   * repo the platform meant to reach with its own credential (or with none at all).
   *
   * `--prune` is deliberately NOT passed: this round only has to make new branches
   * appear. Deleting local refs for branches the remote dropped would silently
   * invalidate a `branch` value a user is looking at in another tab, and 03 §7.2★
   * scopes this endpoint to 「最小的一档」.
   */
  async fetchAll(req: FetchRequest): Promise<void> {
    const git = simpleGit({
      baseDir: req.repoPath,
      abort: req.signal,
      timeout: { block: req.timeoutMs, stdErr: false, stdOut: false },
      unsafe: authUnsafe(),
    });
    let stderrTail = '';
    git.outputHandler((_command, _stdout, stderr) => {
      stderr.on('data', (chunk: Buffer) => {
        stderrTail = (stderrTail + chunk.toString('utf8')).slice(-20_000);
      });
    });
    try {
      const authed = git.env(mergeAuthEnv(cleanGitEnv(), req));
      if (await isShallow(authed)) await unshallow(authed);
      else await authed.fetch(['--all']);
    } catch (e) {
      if (req.signal.aborted) throw e; // cancel / timeout — the caller classifies it
      const raw = e instanceof Error ? e.message : String(e);
      const combined = `${raw} ${stderrTail}`;
      throw new CloneError(classifyCloneError(combined), sanitizeCloneMessage(combined));
    }
  }
}

/**
 * ★ L-9 存量浅克隆基线的迁移 —— 2026-08 解决。
 *
 * 03 §7.2★ 把 clone 从 `--depth=1` 改成完整克隆之后，**改造前建的项目仍然是浅仓**，
 * 点 [重新同步] 也不会变完整：`git fetch --all` 在浅仓上只刷新引用，不加深历史。
 * 用户看到的症状是「建 Task 选分支时永远只有一个分支」，界面上没有任何东西解释。
 *
 * ⚠️ **LIVE-RUN-FINDINGS 里 L-9 给的「建议做法」不够，而且它配的那条用例会在错的修法上
 * 变绿。** 原建议是「探测 `.git/shallow`，存在则 `git fetch --unshallow`」，配的验收是
 * 「sync 后 `git rev-list --count HEAD` 应大于 1」。实测（本地双分支仓）：
 *
 * ```
 *   git clone --depth=1 …          → 提交 1，分支 [origin/main]
 *   git fetch --unshallow          → 提交 3，分支 [origin/main]   ← 分支数没变！
 * ```
 *
 * 提交数确实从 1 变成 3，那条用例会绿 —— **而用户抱怨的那件事一点没修**。原因是
 * `--depth` 会**隐含 `--single-branch`**，于是 remote 的 refspec 被钉成
 * `+refs/heads/main:refs/remotes/origin/main`；`--unshallow` 只按这条 refspec 加深，
 * 别的分支它根本不会去看。深度和分支是**两个**被 `--depth=1` 同时关上的门，
 * 只开一个，症状原样还在。
 *
 * 完整修法是先复原 refspec 再加深（实测：提交 3，分支 [origin/main, origin/feature/x]）：
 *
 * ```
 *   git remote set-branches origin '*'   # refspec → +refs/heads/*:refs/remotes/origin/*
 *   git fetch --unshallow                # 此时才会把所有分支都取回来
 * ```
 */
async function isShallow(git: SimpleGit): Promise<boolean> {
  // `git rev-parse --is-shallow-repository` 而不是 `existsSync('.git/shallow')`：
  // 后者假设 `.git` 是目录（worktree / submodule 里它是个文件），而这个探测是 git 自己
  // 回答的，对任何仓库布局都成立。实测返回字面量 `true` / `false`。
  const out = await git.raw(['rev-parse', '--is-shallow-repository']);
  return out.trim() === 'true';
}

async function unshallow(git: SimpleGit): Promise<void> {
  // ⚠️ 顺序不能反：refspec 必须在 fetch 之前放开，否则 `--unshallow` 只加深那一个分支。
  //
  // `remote set-branches origin '*'` 是 git 为这件事准备的命令（比手写
  // `config remote.origin.fetch` 少一次拼写机会），在**已经是通配**的仓上重复执行无害
  // （实测幂等）。远端名硬编码 `origin`：平台自己 clone 出来的基线只有这一个远端。
  await git.raw(['remote', 'set-branches', 'origin', '*']);
  // 裸 `--unshallow`，不加 `--all`：refspec 放开之后它已经覆盖全部分支，而
  // `--unshallow` 在**非浅仓上会 fatal**（`--unshallow on a complete repository does not
  // make sense`），所以它只能走在 `isShallow` 为真的这条分支里 —— 这正是 L-9 当初被留下
  // 的原因，不能无条件加。
  await git.fetch(['--unshallow']);
}
