import type { CloneStatus } from '../value-objects/project-status.vo';

/** Illegal clone_status move (I-PRJ) → interface maps to HTTP 409. */
export class InvalidProjectTransitionError extends Error {
  constructor(
    readonly from: CloneStatus,
    readonly to: CloneStatus,
  ) {
    super(`Illegal project transition: ${from} -> ${to}`);
    this.name = 'InvalidProjectTransitionError';
  }
}

/** RepoUrl value-object rejection (I-PRJ) → HTTP 400. */
export class InvalidRepoUrlError extends Error {
  constructor(raw: string) {
    super(`invalid repository URL: ${raw}`);
    this.name = 'InvalidRepoUrlError';
  }
}

/** An operation not allowed in the project's current state (e.g. retry on ready) → 409. */
export class ProjectStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectStateError';
  }
}

/**
 * 项目下还有**没清理的保留成果**，所以删不掉 → 409 `PROJECT_HAS_LIVE_RETAINED_VOLUMES`。
 *
 * ⚠️ **为什么不复用 `ProjectStateError`（它翻译成 `INVALID_STATE`）**：
 * 删项目这条路上 `INVALID_STATE` 原本只有一个成因「还有任务在跑 / 克隆还没停」，
 * 前端据此写死了一句文案。2026-09-13 加了保留成果这道前置检查之后它有了**第二个成因**，
 * 而前端拿到同一个码分不出是哪个 —— 用户带着保留成果去删，会看到「还有任务在跑或克隆
 * 还没停」，**一句假话，还把他指向错误的地方**（去停任务，而实际要去清成果）。
 *
 * ⛔ 也不能让前端改成回落服务端 `message`：那条路这个仓库刻意堵死了
 * （`useProjects.test.tsx` 里那条用例 stub 的是英文技术腔 `'project has running tasks'`，
 * 断言客户端显示中文文案，旁边还写着「⛔ 不回落 message」）。服务端 message 随时可能
 * 是技术腔，不该上屏。
 *
 * ⇒ **一个成因一个码**，前端才给得出准确的下一步。
 */
export class ProjectHasLiveRetainedVolumesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectHasLiveRetainedVolumesError';
  }
}

/**
 * `RetainedVolume` 不变量被违反（I-RV-1 / I-RV-2）→ 409。
 *
 * ⚠️ 与 `ProjectStateError` **分开**：那一个由 `ProjectFacadeAdapter` 翻译成
 * `PROJECT_NOT_READY` 送给 sandbox 上下文；保留卷的违规不是「项目还没准备好」，
 * 混用会让一次「重复登记」在建 Task 的错误面上显示成「项目正在克隆」。
 */
export class RetainedVolumeStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RetainedVolumeStateError';
  }
}
