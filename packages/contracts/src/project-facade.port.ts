import type {
  ProjectSourceType,
  RetainedVolumeSource,
  RetentionDays,
} from './schemas/project.schema';

/**
 * Cross-context facade (docs/backend/26 §3 link①, 01 §5): the `sandbox` context
 * needs, at provision time, the project's baseline directory + whether it may
 * accept a task — WITHOUT importing the `project` domain. It depends only on this
 * port; the `project` context provides the implementation (which runs
 * `Project.assertCanAcceptTask` internally). Living in `contracts` keeps both
 * sides boundaries-clean and avoids a package cycle.
 */
export interface ProjectRuntimeContext {
  projectId: string;
  /** host baseline dir to import into the sandbox workspace (empty dir ⇒ empty ws). */
  baselinePath: string;
  sourceType: ProjectSourceType;
  /**
   * The branch the workspace must be switched to after the baseline copy, echoed back
   * ONLY when the caller asked for one and it was found. `undefined` ⇒ keep whatever
   * the baseline has checked out (its default branch).
   */
  branch?: string;
  /**
   * `projects.baseline_size_bytes` —— **配额登记那一维的唯一输入**（03 §1/§3：创建时在
   * 互斥区内按 `baseline_size_bytes × 1.2` 登记 `disk_mb_reserved`）。
   *
   * ⚠️ **`null` 是「还没量过」，不是「0 字节」。** 一个刚建、基线还没 clone 完的项目
   * 与一个真的空项目，在这一列上长得一样，但把 `null` 当 0 只在这里恰好无害（两者都
   * 落到同一个配置下限上）。它仍然分开写，因为下限一旦改成「按体积比例算」，把 `null`
   * 悄悄当 0 就会变成给未知体积的项目登记 0 MB —— 而 `disk_mb_reserved > 0` 的 CHECK
   * 会在半个事务之后才炸。
   */
  baselineSizeBytes: number | null;
}

/**
 * `RegisterRetainedVolumeCommand`（24 §3/§5）—— sandbox 上下文销毁 keepVolume 之后
 * 把「这个宿主目录被留下来了」登记进 project 上下文的账本。
 *
 * ⚠️ **两个聚合两个事务**（24 §5.2）：登记（PRJ 侧）与 sandbox 终态（SBX 侧）不共享
 * 事务。若登记成功而 sandbox 终态失败，重放时 `workspacePath` 的 UNIQUE 约束
 * （I-RV-3）保证不会重复登记 —— 所以实现必须把「已登记」当**成功**，不是冲突。
 */
export interface RegisterRetainedVolumeCommand {
  projectId: string;
  /** 来源 Task。弱引用：sandbox 记录归档后会被置空，卷仍可管理（13 §2.2.2）。 */
  sandboxId?: string;
  /** 保留下来的宿主目录绝对路径 —— 也是 I-RV-3 的唯一键。 */
  workspacePath: string;
  source: RetainedVolumeSource;
  /** 缺省 30 天（P20 §6）；自动化产物传规则的 `artifactRetentionDays`。 */
  retentionDays?: RetentionDays;
}

export interface ProjectFacade {
  /**
   * Resolve the runtime context for a NEW task, asserting the project exists and
   * is ready (I-PRJ). Throws `ProjectAccessError` otherwise — the sandbox
   * interface maps its `code` to HTTP.
   *
   * `branch` (03 §7.2★ 「建 Task 时选分支」) is validated HERE, against the baseline's
   * LOCAL refs — the full clone means that costs no network call and no git
   * credential. A branch the baseline does not have is refused with
   * `BRANCH_NOT_FOUND` so the rejection lands at the create DOOR (零副作用) rather
   * than half-way through preparing a workspace.
   */
  getRuntimeContextForTask(projectId: string, branch?: string): Promise<ProjectRuntimeContext>;

  /**
   * 登记一个被保留下来的工作区卷（03 §7.7 / 24 §5）。
   *
   * ⚠️ **幂等**：同一个 `workspacePath` 登记两次是 no-op，不是错误（见
   * {@link RegisterRetainedVolumeCommand} 的事务注释）。
   *
   * ⚠️ **永不抛给销毁流程**。销毁已经走到「实例没了、目录留下了」这一步，此时因为
   * 账本没记上而把整个 destroy 判失败，换来的是一个停在 `destroying` 的沙箱 + 一个
   * 谁也管不到的目录 —— 比「目录在、账本暂缺」坏。目录是事实、表是索引，两者不一致
   * 时以目录为准（03 §7.7），启动对账会补。
   */
  registerRetainedVolume(command: RegisterRetainedVolumeCommand): Promise<void>;
}

export const PROJECT_FACADE = Symbol('ProjectFacade');

export type ProjectAccessErrorCode = 'PROJECT_NOT_FOUND' | 'PROJECT_NOT_READY' | 'BRANCH_NOT_FOUND';

/** Boundaries-safe error the facade throws and the sandbox interface maps to HTTP. */
export class ProjectAccessError extends Error {
  constructor(
    readonly code: ProjectAccessErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ProjectAccessError';
  }
}
