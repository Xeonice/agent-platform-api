import type { CloneErrorCode } from '../entities/project.entity';

/**
 * GitCloner port (docs/backend/03 §7.2). Module-internal port — lives in `domain`
 * so BOTH the application (which drives the clone workflow) and the infrastructure
 * (simple-git adapter) can depend on it without crossing the application↔infra
 * boundary. The adapter clones `repoUrl` (shallow, `--depth=1`) into `destPath`,
 * streams `--progress` into `onProgress`, aborts on `signal`, and enforces a hard
 * timeout; on failure it throws a `CloneError` carrying the taxonomy code.
 */
export interface CloneProgress {
  percent?: number;
  receivedBytes?: number;
  totalBytes?: number;
}

export interface CloneRequest {
  repoUrl: string;
  repoBranch: string | null;
  destPath: string;
  timeoutMs: number;
  signal: AbortSignal;
  onProgress: (p: CloneProgress) => void;
  /**
   * Materialized git-auth env from `GitAuthContext.env` (03 §7.3): the HTTPS token
   * `$GIT_TOKEN` + the env-scoped credential.helper config. Merged AFTER the env
   * guard so it survives; absent ⇒ public-repo clone. The adapter NEVER receives a
   * credentialId or a SecretMaterial — only this already-assembled env.
   */
  env?: Record<string, string>;
  /** SSH `GIT_SSH_COMMAND` from `GitAuthContext.gitSshCommand` (SSH only). */
  gitSshCommand?: string;
}

/** Sanitized clone failure (03 §7.5): URL userinfo/password already stripped. */
export class CloneError extends Error {
  constructor(
    readonly code: CloneErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CloneError';
  }
}

export interface GitCloner {
  /** Shallow-clone into `destPath`; throws `CloneError` on a git failure, or the
   *  raw abort error when `signal` fired (the workflow classifies timeout/cancel). */
  clone(req: CloneRequest): Promise<void>;
}

export const GIT_CLONER = Symbol('GitCloner');
