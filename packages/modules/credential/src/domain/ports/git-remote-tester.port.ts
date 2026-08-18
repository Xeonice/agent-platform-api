/**
 * GitRemoteTester PORT (docs/backend/03 §7.4). Runs `git ls-remote --exit-code`
 * against a URL with a 15s timeout, using the assembled (or absent) auth env.
 * Returns ONLY `{ ok, errorCode?, message? }` — NEVER a ref list (that would leak
 * private branch names). `GitLsRemoteErrorCode` mirrors contracts' GitTestErrorCode
 * (domain must not import contracts) — identical string literals, so assignable.
 */
export type GitLsRemoteErrorCode = 'CLONE_FAILED_PERMISSION' | 'CLONE_FAILED_NETWORK' | 'TIMEOUT';

export interface GitLsRemoteResult {
  ok: boolean;
  errorCode?: GitLsRemoteErrorCode;
  message?: string;
}

export interface GitLsRemoteInput {
  url: string;
  /** Assembled auth env + optional GIT_SSH_COMMAND (omit for a public probe). */
  env?: Record<string, string>;
  gitSshCommand?: string;
}

export interface GitRemoteTester {
  lsRemote(input: GitLsRemoteInput): Promise<GitLsRemoteResult>;
}

export const GIT_REMOTE_TESTER = Symbol('GitRemoteTester');
