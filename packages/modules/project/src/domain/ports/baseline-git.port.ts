/**
 * BaselineGit port (docs/backend/03 §7.2★). Git operations performed against an
 * ALREADY-CLONED baseline, as opposed to `GitCloner`, which creates one. Module-
 * internal port in `domain` so the application and the simple-git adapter can share it
 * without crossing the application↔infrastructure boundary.
 *
 * The split matters because the two operations here sit on opposite sides of the
 * network line, and that asymmetry is the whole payoff of cloning in full:
 *   - `listBranches` is PURELY LOCAL — it reads the baseline's remote-tracking refs
 *     (`git branch -r`). NOT `git ls-remote`: after a full clone every branch is
 *     already here, so this path has no network failure mode and needs no git
 *     credential at all (03 §7.2★ 「建 Task 时选分支」).
 *   - `fetchAll` is the ONE place the sync path touches the remote, so it takes the
 *     same materialized auth products as a clone.
 */
export interface FetchRequest {
  /** the baseline working copy to fetch into. */
  repoPath: string;
  timeoutMs: number;
  signal: AbortSignal;
  /** materialized git-auth env from `GitAuthContext.env` (03 §7.3); absent ⇒ public. */
  env?: Record<string, string>;
  /** SSH `GIT_SSH_COMMAND` from `GitAuthContext.gitSshCommand` (SSH only). */
  gitSshCommand?: string;
}

export interface BaselineGit {
  /**
   * Short branch names held by the baseline's LOCAL remote-tracking refs — `main`,
   * `feature/x` — i.e. the values `CreateSandbox.branch` may take. Never a network
   * call. Throws when `repoPath` is not a git repository; callers that can legally be
   * pointed at a non-repo (empty projects) must not call it.
   */
  listBranches(repoPath: string): Promise<string[]>;

  /**
   * `git fetch --all` into an existing baseline (03 §7.2★ 基线同步). Refreshes the
   * remote-tracking refs ONLY — it must never touch a Task's workspace, which is a
   * copy-on-write snapshot taken at ITS creation time. Throws `CloneError` carrying a
   * taxonomy `CloneErrorCode` on a git failure, or the raw abort error when `signal`
   * fired.
   */
  fetchAll(req: FetchRequest): Promise<void>;
}

export const BASELINE_GIT = Symbol('BaselineGit');
