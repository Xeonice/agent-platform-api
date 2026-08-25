/**
 * WorkspacePreparer port (docs/backend/03 §7.6). Prepares the host bind-mount
 * directory that becomes the container's /workspace (audit P0-1). Lives in
 * `contracts` (like the SandboxProvider SPI) so the infrastructure adapter can
 * implement it and the application can depend on it without crossing the
 * application↔infrastructure boundary. S1 makes an empty marked dir (no clone).
 */
export interface PreparedWorkspace {
  /** host absolute path; becomes VolumeMount.source (kind='host-path'). */
  hostPath: string;
}

/**
 * Where the workspace is filled from (03 §7.1): the project's baseline dir is
 * copied (`cp -a --reflink=auto`) into a fresh per-sandbox workspace. An empty
 * project's baseline is an empty dir, so the copy yields an empty workspace.
 */
export interface WorkspaceSource {
  /** host baseline dir to import; must exist (platform guarantees it, 03 §4). */
  baselinePath: string;
  /**
   * Branch to check out in the FRESH COPY once the import is done (03 §7.2★). After a
   * full baseline clone this is a purely LOCAL `git checkout` — no network, no git
   * credential — which is exactly why the baseline is cloned in full. The value was
   * already validated against the baseline's refs at the create door, so a failure
   * here is a real fault, not a bad request. `undefined` ⇒ keep the baseline's own
   * checked-out branch.
   */
  branch?: string;
}

export interface WorkspacePreparer {
  prepare(sandboxId: string, source: WorkspaceSource): Promise<PreparedWorkspace>;
  cleanup(sandboxId: string, opts: { keep: boolean }): Promise<void>;
}

export const WORKSPACE_PREPARER = Symbol('WorkspacePreparer');

/**
 * ★ 03 §7.6 / 23 §5.6 的两个码，2026-08 补上产出方。
 *
 * ⚠️ **这两个码此前被五处文档承诺，代码里一个产出方都没有**（02 §6.1 的错误码表、
 * 23 §5.6 的 `SandboxWorkspacePrepareFailed` 领域事件、25 的 E2E-1-wsFail、27 §2 的
 * `createSandbox` 错误列、03 §7.6）——`provision-sandbox.workflow.ts` 里甚至有一行注释
 * 写着「a failure here … lands as WORKSPACE_PREPARE_FAILED」，而它并不会。
 *
 * 真实发生的是：`prepare()` 直接抛 Node 的 fs 错误，`failureOf` 读 `error.code` 拿到
 * **`ENOSPC` / `ENOENT` / `EACCES`**，把 errno 当平台错误码存进 `failureCode` 并广播。
 * 前端按码查文案，查不到 `ENOSPC`，落到通用兜底——正是 02 §6.2「失败必须带码，否则
 * 前端没有可挂 P22 §1 那句话的钩子」要防的那件事，只是它防的是"没有码"，没防住
 * "有一个不属于这套词汇表的码"。
 */
export const WORKSPACE_PREPARE_FAILED = 'WORKSPACE_PREPARE_FAILED';
export const DISK_INSUFFICIENT = 'DISK_INSUFFICIENT';

export type WorkspacePrepareErrorCode =
  | typeof WORKSPACE_PREPARE_FAILED
  | typeof DISK_INSUFFICIENT;

/**
 * 工作区准备失败。**由 adapter 抛**，不由 workflow 归类——只有实现知道自己刚才在做
 * 什么 IO，workflow 拿到的只是一个 errno，事后猜是猜不准的。
 */
export class WorkspacePrepareError extends Error {
  constructor(
    readonly code: WorkspacePrepareErrorCode,
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'WorkspacePrepareError';
  }
}

/**
 * errno → 闭集码。**只有 `ENOSPC` / `EDQUOT` 单独成码**，因为只有"磁盘满/超配额"这一类
 * 对用户意味着一件**具体的、他做得到的事**（去清空间），其余一律 `WORKSPACE_PREPARE_FAILED`。
 *
 * ⚠️ 不要按 errno 继续细分。`EACCES` / `ENOENT` / `EMFILE` 在产品语义上是同一件事
 * ——「平台自己没准备好工作区」——用户对它们的处置完全一致（重试 / 报障）。多分一个码
 * 就要多写一句文案、多一行对账表、多一处会漂移的地方，而用户看到的字不会有任何不同。
 * 原始 errno 不丢：它进 `cause` 与 `message`，供日志和 traceId 排查。
 */
export function classifyWorkspacePrepareError(e: unknown): WorkspacePrepareError {
  if (e instanceof WorkspacePrepareError) return e;
  const errno = typeof e === 'object' && e !== null && 'code' in e ? String(e.code) : '';
  const message = e instanceof Error ? e.message : String(e);
  const code = errno === 'ENOSPC' || errno === 'EDQUOT' ? DISK_INSUFFICIENT : WORKSPACE_PREPARE_FAILED;
  return new WorkspacePrepareError(code, message, e);
}
