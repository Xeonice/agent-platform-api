import { AggregateRoot } from '@platform/shared-kernel';
import type { ProjectId } from '@platform/shared-kernel';
import { CloneStatusVO } from '../value-objects/project-status.vo';
import type { CloneStatus } from '../value-objects/project-status.vo';
import { RepoUrl } from '../value-objects/repo-url.vo';
import { InvalidProjectTransitionError, ProjectStateError } from '../errors/project-errors';
import {
  ProjectBaselineSynced,
  ProjectCloneCancelled,
  ProjectCloneRetried,
  ProjectConvertedToEmpty,
  ProjectCreated,
  ProjectDeleted,
} from '../events/project-events';

export type ProjectSourceType = 'git' | 'empty';
export type CloneErrorCode =
  | 'CLONE_FAILED_PERMISSION'
  | 'CLONE_FAILED_NETWORK'
  | 'TIMEOUT'
  | 'INTERRUPTED'
  | 'DISK_INSUFFICIENT';
export type WorkspaceMode = 'copy';

export interface ProjectProps {
  id: ProjectId;
  name: string;
  sourceType: ProjectSourceType;
  repoUrl: string | null;
  repoBranch: string | null;
  cloneStatus: CloneStatus;
  cloneErrorCode: CloneErrorCode | null;
  baselinePath: string;
  baselineSizeBytes: number | null;
  workspaceMode: WorkspaceMode;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Project aggregate root (docs/backend/23 §6, I-PRJ-1..7). Owns the clone_status
 * state machine and the source invariants:
 *   - git   ⇒ repoUrl present;  empty ⇒ repoUrl null
 *   - failed ⇒ cloneErrorCode present; otherwise null
 *   - a task may only start on a `ready` project (assertCanAcceptTask)
 */
export class Project extends AggregateRoot<ProjectId> {
  readonly name: string;
  private _sourceType: ProjectSourceType;
  private _repoUrl: string | null;
  private _repoBranch: string | null;
  private _cloneStatus: CloneStatus;
  private _cloneErrorCode: CloneErrorCode | null;
  readonly baselinePath: string;
  private _baselineSizeBytes: number | null;
  private _workspaceMode: WorkspaceMode;
  private _version: number;
  readonly createdAt: Date;
  private _updatedAt: Date;

  private constructor(props: ProjectProps) {
    super(props.id);
    this.name = props.name;
    this._sourceType = props.sourceType;
    this._repoUrl = props.repoUrl;
    this._repoBranch = props.repoBranch;
    this._cloneStatus = props.cloneStatus;
    this._cloneErrorCode = props.cloneErrorCode;
    this.baselinePath = props.baselinePath;
    this._baselineSizeBytes = props.baselineSizeBytes;
    this._workspaceMode = props.workspaceMode;
    this._version = props.version;
    this.createdAt = props.createdAt;
    this._updatedAt = props.updatedAt;
  }

  static rehydrate(props: ProjectProps): Project {
    return new Project(props);
  }

  /** Create a project. git ⇒ starts `cloning`; empty ⇒ `ready` immediately. */
  static create(input: {
    id: ProjectId;
    name: string;
    sourceType: ProjectSourceType;
    repoUrl?: string;
    repoBranch?: string;
    baselinePath: string;
    now: Date;
  }): Project {
    const isGit = input.sourceType === 'git';
    if (isGit && !input.repoUrl) {
      throw new ProjectStateError('git project requires repoUrl (I-PRJ)');
    }
    if (!isGit && input.repoUrl) {
      throw new ProjectStateError('empty project must not carry repoUrl (I-PRJ)');
    }
    // validate the URL shape up front (throws InvalidRepoUrlError → 400)
    const repoUrl = isGit ? RepoUrl.create(input.repoUrl as string).value : null;
    const project = new Project({
      id: input.id,
      name: input.name,
      sourceType: input.sourceType,
      repoUrl,
      repoBranch: isGit ? (input.repoBranch ?? null) : null,
      cloneStatus: isGit ? 'cloning' : 'ready',
      cloneErrorCode: null,
      baselinePath: input.baselinePath,
      baselineSizeBytes: isGit ? null : 0,
      workspaceMode: 'copy',
      version: 0,
      createdAt: input.now,
      updatedAt: input.now,
    });
    project.raise(new ProjectCreated(input.id, input.name, input.now));
    return project;
  }

  get sourceType(): ProjectSourceType {
    return this._sourceType;
  }
  get repoUrl(): string | null {
    return this._repoUrl;
  }
  get repoBranch(): string | null {
    return this._repoBranch;
  }
  get cloneStatus(): CloneStatus {
    return this._cloneStatus;
  }
  get cloneErrorCode(): CloneErrorCode | null {
    return this._cloneErrorCode;
  }
  get baselineSizeBytes(): number | null {
    return this._baselineSizeBytes;
  }
  get workspaceMode(): WorkspaceMode {
    return this._workspaceMode;
  }
  get version(): number {
    return this._version;
  }
  get updatedAt(): Date {
    return this._updatedAt;
  }

  private transition(to: CloneStatus, now: Date): void {
    if (!CloneStatusVO.canTransitionTo(this._cloneStatus, to)) {
      throw new InvalidProjectTransitionError(this._cloneStatus, to);
    }
    this._cloneStatus = to;
    this._updatedAt = now;
  }

  /** clone finished OK: cloning → ready, record baseline size. */
  markCloneReady(baselineSizeBytes: number, now: Date): void {
    this.transition('ready', now);
    this._cloneErrorCode = null;
    this._baselineSizeBytes = baselineSizeBytes;
  }

  /** clone failed: cloning → failed with a taxonomy code (03 §7.5). */
  markCloneFailed(code: CloneErrorCode, now: Date): void {
    this.transition('failed', now);
    this._cloneErrorCode = code;
  }

  /**
   * Baseline synced from the remote (`POST /api/projects/:id/sync`, 03 §7.2★): refresh
   * the recorded size and the timestamp. `ready → ready` is NOT a state-machine move,
   * so it deliberately does not go through `transition` — nothing about the clone
   * lifecycle changed, only how fresh the bytes on disk are.
   *
   * ⚠️ IT SAYS NOTHING ABOUT EXISTING TASKS, BECAUSE IT MUST NOT. A Task's workspace is
   * a copy-on-write snapshot taken when that Task was created; rewriting it would
   * change the code out from under a run in progress. The consequence — two Tasks on
   * one project can sit on different commits — is a KNOWN, deliberately un-surfaced
   * semantic this round (03 §7.2★).
   */
  syncBaseline(baselineSizeBytes: number, now: Date): void {
    this.assertCanSync();
    this._baselineSizeBytes = baselineSizeBytes;
    this._updatedAt = now;
    this.raise(new ProjectBaselineSynced(this.id, this.name, baselineSizeBytes, now));
  }

  /**
   * The sync precondition, callable BEFORE the fetch (I-PRJ / 27 §3 `INVALID_STATE`).
   *
   * ⚠️ IT IS SEPARATE FROM `syncBaseline` BECAUSE IT HAS TO RUN AT BOTH ENDS. Checked
   * only at the end, an empty project's sync would first run `git fetch` inside a
   * directory that is not a repository and answer with the GIT failure — a 502
   * 「网络错误」 about a project that simply has no remote. Checked only at the start, a
   * project that changed underneath a slow fetch could still be written. So: refuse
   * early here, and re-assert inside `syncBaseline` for the race.
   */
  assertCanSync(): void {
    if (this._cloneStatus !== 'ready') {
      throw new ProjectStateError('sync is only allowed on a ready project');
    }
    if (this._sourceType !== 'git') {
      throw new ProjectStateError('sync is only allowed on a git project (no remote to fetch)');
    }
  }

  /** retry a failed clone: failed → cloning. */
  retryClone(now: Date): void {
    if (this._cloneStatus !== 'failed') {
      throw new ProjectStateError('retry-clone is only allowed on a failed project');
    }
    if (this._sourceType !== 'git') {
      throw new ProjectStateError('retry-clone is only allowed on a git project');
    }
    this.transition('cloning', now);
    this._cloneErrorCode = null;
    this.raise(new ProjectCloneRetried(this.id, this.name, now));
  }

  /** convert a failed git project into an empty one: failed → ready, drop source. */
  convertToEmpty(now: Date): void {
    if (this._cloneStatus !== 'failed') {
      throw new ProjectStateError('convert-to-empty is only allowed on a failed project');
    }
    // ⚠️ host 必须在归零**之前**取：下面四行一过，平台里再没有任何一处记得它原本
    // 指向哪儿（23 §6.4「记录曾经的 repoUrl 已丢弃」）。
    const discardedRepoHost = this.repoHost();
    this.transition('ready', now);
    this._sourceType = 'empty';
    this._repoUrl = null;
    this._repoBranch = null;
    this._cloneErrorCode = null;
    this._baselineSizeBytes = 0;
    this.raise(new ProjectConvertedToEmpty(this.id, this.name, discardedRepoHost, now));
  }

  /**
   * 用户在克隆进行中按了取消（`POST /api/projects/:id/cancel-clone`）。
   *
   * ⚠️ **不改状态、也不抛**：真正的落定由 `CloneProjectWorkflow` 的失败路径写成
   * `failed` + `INTERRUPTED`；而对一个已经拉完的项目按取消，产品语义是「无事发生」
   * 而不是 409（端点此前就是这么答的，本次不改）。返回值区分的正是「真取消了」与
   * 「按晚了」—— 只有前者该在审计里留下一行。
   */
  cancelClone(now: Date): boolean {
    if (this._cloneStatus !== 'cloning') return false;
    this.raise(new ProjectCloneCancelled(this.id, this.name, now));
    return true;
  }

  /**
   * 项目被删除（`DELETE /api/projects/:id`）。**行即将消失，事件是唯一的去处。**
   *
   * ⚠️ 它必须在 `deleteSync` 之前调用、并在**同一个事务**里 publish —— 事件在
   * `AggregateRoot` 的内存缓冲里，不依赖那一行还在不在库中（13 §2.8.2：审计必须在
   * 主体被删除之后继续存在）。
   */
  markDeleted(keptBaseline: boolean, now: Date): void {
    this.raise(new ProjectDeleted(this.id, this.name, keptBaseline, now));
  }

  /**
   * 远端**主机**（`github.com` / `git.corp:8443`），空项目为 `null`。
   *
   * 走 `RepoUrl` 而不是自己切串：解析规则（含端口是否保留）只该有一处，
   * 而那一处已经是 `RepoUrl.host()`。
   */
  private repoHost(): string | null {
    return this._repoUrl === null ? null : RepoUrl.create(this._repoUrl).host();
  }

  /** I-PRJ: a task may only start on a ready project. */
  assertCanAcceptTask(): void {
    if (this._cloneStatus !== 'ready') {
      throw new ProjectStateError(
        `project ${this.id} is not ready for a task (clone_status=${this._cloneStatus})`,
      );
    }
  }

  markPersisted(newVersion: number): void {
    this._version = newVersion;
  }
}
