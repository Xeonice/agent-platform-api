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
