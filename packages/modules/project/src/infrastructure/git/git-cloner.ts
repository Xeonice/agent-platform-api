import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Injectable } from '@nestjs/common';
import { simpleGit } from 'simple-git';
import type { GitCloner, CloneRequest } from '../../domain/ports/git-cloner.port';
import { CloneError } from '../../domain/ports/git-cloner.port';
import { parseCloneProgress } from './progress.parser';
import { classifyCloneError, sanitizeCloneMessage } from './error.classifier';
import { authUnsafe, cleanGitEnv, mergeAuthEnv } from './git-env';

/**
 * simple-git FULL cloner (docs/backend/03 §7.2). The `--progress` stderr is parsed for
 * the progress bar; the child is killed on the caller's AbortSignal (cancel) and by a
 * hard inactivity-immune timeout (`timeout.block` with stdErr/stdOut resets disabled =
 * a true wall-clock cap). git's interactive credential prompts are disabled so
 * private/bad URLs fail fast instead of hanging.
 *
 * ── WHY THE CLONE IS NO LONGER SHALLOW (03 §7.2★) ────────────────────────────────
 * This used to pass `--depth=1` and, when a branch was pinned, `--single-branch`. The
 * premise written next to it was 「后续 Task 只需工作副本，不需要历史」 — and that premise
 * is gone: the product requires choosing a BRANCH when a Task is created (P20 §3.2 /
 * P21-2). A shallow/single-branch baseline holds exactly ONE branch ref, so
 * `git checkout <any other branch>` dies with `pathspec … did not match` (measured).
 *
 * The alternatives were weighed in 03 §7.2★ and both cost a NETWORK step per Task
 * (re-clone the chosen branch, or `fetch --depth=1` into the workspace). A full
 * baseline instead pays ONCE, in disk, and buys a workspace path with **no network
 * failure mode and no git credential at all**: listing branches reads local refs and
 * switching them is a local checkout.
 *
 * ⚠️ THERE IS DELIBERATELY NO "shallow" ESCAPE HATCH. Two modes would make "can I pick
 * a branch?" depend on how the project happened to be created — a question the user
 * cannot answer at creation time. The disk cost is paid for with VISIBILITY instead:
 * `baselineSizeBytes` is on `ProjectDto` (10 §7.3) and a pre-clone free-space check
 * refuses up front (03 §7.2★ 磁盘预检).
 *
 * `--branch` STAYS. It only decides which branch ends up checked out; on its own it
 * does not narrow what is fetched.
 */
@Injectable()
export class SimpleGitCloner implements GitCloner {
  async clone(req: CloneRequest): Promise<void> {
    await mkdir(dirname(req.destPath), { recursive: true });
    const git = simpleGit({
      baseDir: dirname(req.destPath),
      abort: req.signal,
      timeout: { block: req.timeoutMs, stdErr: false, stdOut: false },
      unsafe: authUnsafe(),
    });
    let stderrTail = '';
    git.outputHandler((_command, _stdout, stderr) => {
      stderr.on('data', (chunk: Buffer) => {
        const fragment = chunk.toString('utf8');
        stderrTail = (stderrTail + fragment).slice(-20_000);
        const progress = parseCloneProgress(fragment);
        if (progress) req.onProgress(progress);
      });
    });

    const args = ['--progress'];
    if (req.repoBranch) args.push('--branch', req.repoBranch);

    try {
      // GIT_TERMINAL_PROMPT=0 ⇒ never block on a credential prompt. We must NOT pass
      // through GIT_CONFIG_COUNT / GIT_CONFIG_{KEY,VALUE}_n (ambient config-in-env,
      // e.g. injected by CI/harness): simple-git rejects them as unsafe, and we do
      // not want ambient git config leaking into project clones anyway.
      await git.env(mergeAuthEnv(cleanGitEnv(), req)).clone(req.repoUrl, req.destPath, args);
    } catch (e) {
      if (req.signal.aborted) throw e; // cancel / timeout — the workflow classifies it
      const raw = e instanceof Error ? e.message : String(e);
      const combined = `${raw} ${stderrTail}`;
      throw new CloneError(classifyCloneError(combined), sanitizeCloneMessage(combined));
    }
  }
}
