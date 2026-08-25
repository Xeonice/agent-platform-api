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
  /** `(527/26348)` —— **本阶段的** done/total，跨阶段量纲会变，见下方长注释。 */
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
 * ⚠️ **`objectsTotal` 是「本阶段的分母」，不是「整个 clone 的分母」——
 * 上一版注释在这里写错了，并且错得会让人写出 bug。**
 *
 * 原话是「`Enumerating objects: 26348` 在开头就报出来了，是 git 唯一在事前就知道的
 * 总量」。前半句对，后半句不对：`Enumerating` 那一次确实报了远端对象总数，但**后面每个
 * 阶段都会用同一个字段报出自己的分母，而那些分母是不同的量**——
 *
 *   · `Compressing objects: N% (done/total)` —— total 只算**需要压缩**的对象；
 *   · `Resolving deltas:    N% (done/total)` —— total 是 **delta 数**，通常远小于对象数；
 *   · `Updating files:      N% (done/total)` —— total 是**文件数**，连量纲都不一样。
 *
 * 也就是说，把 `objectsTotal` 当成一个跨阶段稳定的分母去用，数字会在阶段切换时跳变
 * （26348 → 12000 → 3000）。`parseCloneProgress` 的 `STAGE_PATTERNS` 本身就是这句话的
 * 反证：六个模式各自捕获自己的 `total`。
 *
 * 现在的消费方是对的，但**是碰巧对的**：`cloneProgressPercent` 优先用 git 给的 per-stage
 * `percent`，只有 `enumerating` 没有 percent 才会退到对象数——而那一帧只有 total 没有
 * done，于是返回 null 走脉冲态。`buildDetailLabel` 把 `objectsDone/objectsTotal` 与
 * **阶段名**并排渲染（`接收对象 · 11,000/26,348`），阶段名正好限定了这对数的含义。
 * 下一个照着旧注释去做「跨阶段总进度」的人不会这么幸运。
 *
 * ⚠️ **随之而来的真实观感（已知，未修）**：进度条走的是**每个阶段自己的**百分比，所以
 * 一次 clone 里它会 0→100 好几遍。实测阶段占比（flask，26348 对象）是
 * enumerate/count/compress 0.1%、receiving 93.7%、resolving 0.3%，所以绝大多数时间里
 * 用户看到的是 receiving 那一遍，其余几遍一闪而过。**没有按这组占比加权**，因为它们来自
 * 一个仓库的一次实测——把它们写成常量，就是拿一次采样冒充普遍规律（大仓的
 * `Resolving deltas` 可以跑几十秒）。要修得先有多个仓库的数据，或者干脆按阶段分段显示。
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
