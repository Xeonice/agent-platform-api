import { Injectable } from '@nestjs/common';
import { simpleGit } from 'simple-git';
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
   * `git fetch --all`. Runs under the SAME hermetic env as a clone (`git-env.ts`): a
   * sync that fell back to an ambient credential helper would authenticate with a
   * host-cached token for a repo the platform meant to reach with its own credential
   * (or with none at all).
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
      await git.env(mergeAuthEnv(cleanGitEnv(), req)).fetch(['--all']);
    } catch (e) {
      if (req.signal.aborted) throw e; // cancel / timeout — the caller classifies it
      const raw = e instanceof Error ? e.message : String(e);
      const combined = `${raw} ${stderrTail}`;
      throw new CloneError(classifyCloneError(combined), sanitizeCloneMessage(combined));
    }
  }
}
