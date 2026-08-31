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
