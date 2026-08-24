import type { CloneErrorCode } from '../entities/project.entity';

/**
 * GitCloner port (docs/backend/03 §7.2). Module-internal port — lives in `domain`
 * so BOTH the application (which drives the clone workflow) and the infrastructure
 * (simple-git adapter) can depend on it without crossing the application↔infra
 * boundary. The adapter clones `repoUrl` IN FULL (03 §7.2★ — no `--depth`, no
 * `--single-branch`, because 「建 Task 选分支」 needs every ref) into `destPath`, streams
 * `--progress` into `onProgress`, aborts on `signal`, and enforces a hard timeout; on
 * failure it throws a `CloneError` carrying the taxonomy code.
 */
/** git 自己announce的阶段名（`--progress` stderr）。 */
export type CloneStage =
  'enumerating' | 'counting' | 'compressing' | 'receiving' | 'resolving' | 'checkout';

export interface CloneProgress {
  stage: CloneStage;
  /** 该阶段自身的百分比（`enumerating` 没有，它只报总数）。 */
  percent?: number;
  /** `(527/26348)` —— git 给的唯一诚实分母，见下方对 `totalBytes` 的注释。 */
  objectsDone?: number;
  objectsTotal?: number;
  /** 已接收字节（仅 `receiving` 阶段有）。 */
  receivedBytes?: number;
  /** 接收速率（仅 `receiving`）。卡住时它先归零，比百分比停住更早暴露。 */
  bytesPerSecond?: number;
}

/**
 * ⚠️ **这里曾经有一个 `totalBytes?`，2026-08 删除——它是个幽灵字段。**
 *
 * `git clone` **不报总字节数**（它自己也不知道：包在传输中边算边发），所以全后端
 * 从来没有一处给它赋过值。而前端 `buildDetailLabel` 的第一条分支是
 * `if (receivedBytes && totalBytes) return "x / y"` —— 一条**生产永远走不到**的
 * 格式化路径，配着一条手工构造 state 才能变绿的测试。
 *
 * 需要分母就用 `objectsTotal`：`Enumerating objects: 26348` 在**开头**就报出来了，
 * 是 git 唯一在事前就知道的总量。
 */

export interface CloneRequest {
  repoUrl: string;
  /**
   * Branch to have checked out when the clone finishes (`--branch`). It does NOT
   * narrow what is fetched — the clone still brings every ref, which is what keeps
   * 「建 Task 选分支」 possible on a project created with a pinned branch (03 §7.2★).
   */
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
  /** Full-clone into `destPath`; throws `CloneError` on a git failure, or the
   *  raw abort error when `signal` fired (the workflow classifies timeout/cancel). */
  clone(req: CloneRequest): Promise<void>;
}

export const GIT_CLONER = Symbol('GitCloner');
