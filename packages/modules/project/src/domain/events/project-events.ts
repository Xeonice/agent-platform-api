import type { DomainEvent, ProjectId } from '@platform/shared-kernel';

/**
 * Project domain events (23 §12 / §6.4). Clone PROGRESS is a transient projection
 * pushed straight to the /events gateway (§7.4 §78, not via the outbox), so it is NOT
 * a domain event.
 *
 * ── 每一条都带 `name`，这不是冗余 ────────────────────────────────────────────
 * 理由一（当下）：审计流的 `summary` 要求是「一行人话，直接上 UI」（13 §2.8.2），
 * 而 13 §2.8.2 把它写成了可验收的一条：**这一列不许出现 UUID**。没有这个字段，
 * projector 只能写出 `删除项目 621510e4-d357-…` —— 那一行实际只说了「有个项目被删了」。
 *
 * 理由二（更要紧）：审计是**历史快照**，记的必须是**当时**的名字。项目后来改名、
 * 甚至被删（`project.deleted` 尤其如此：主体已经不在了，回查必然扑空），那条审计行
 * 都该保持原样。回查当前库会让历史随现状漂移，而那正是审计要防的事
 * （13 §2.8.2「为什么 `subject_id` 不设 FK」）。
 */
export class ProjectCreated implements DomainEvent {
  readonly type = 'ProjectCreated';
  constructor(
    readonly projectId: ProjectId,
    /** 见文件顶部「每一条都带 `name`」。 */
    readonly name: string,
    readonly occurredAt: Date,
  ) {}
}

/**
 * `POST /api/projects/:id/retry-clone` —— `failed → cloning` 又跑了一遍。
 *
 * ⚠️ 它与 `ProjectCreated` 分得开才有意义：同一个项目的基线可能被重试拉过五次，
 * 而「第几次拉成功的 / 中间隔了多久」正是排查间歇性网络与凭证问题要看的东西。
 */
export class ProjectCloneRetried implements DomainEvent {
  readonly type = 'ProjectCloneRetried';
  constructor(
    readonly projectId: ProjectId,
    readonly name: string,
    readonly occurredAt: Date,
  ) {}
}

/**
 * `POST /api/projects/:id/convert-to-empty` —— 放弃远端，就地转成空项目
 * （23 §6.4 / 24 §302；文档一直写着它，实现里此前没有）。
 *
 * ⚠️ **这是不可逆的**：`repoUrl` / `repoBranch` 被归零，半份克隆被 `rm -rf`。所以
 * 23 §6.4 对它的备注就是「审计（记录曾经的 repoUrl 已丢弃）」—— 转完之后，平台里
 * 再没有任何一处记得它原本指向哪儿。
 */
export class ProjectConvertedToEmpty implements DomainEvent {
  readonly type = 'ProjectConvertedToEmpty';
  constructor(
    readonly projectId: ProjectId,
    readonly name: string,
    /**
     * 被丢弃的远端**主机**（`github.com` / `git.corp:8443`），不是整条 URL。
     *
     * ⛔ **整条 URL 不进事件，这是源头纪律而不是保守。** `RepoUrl` 刻意保留原始串
     * （「the raw string is preserved」），于是 `https://user:token@host/repo.git`
     * 这种形式会把 token 一起带进来；而 `log-redactor.ts` 的规则认的是**密钥的形状**
     * （`sk-ant-…` / `ghp_…` / `Authorization:` …），URL userinfo 里那一段它一条都不遮。
     * 05 §4「脱敏在写入口」是兜底，不是许可 —— 压根不带进来才叫在源头成立。
     * host 已经足够回答「原来连的是哪个远端」，而它按定义不含 userinfo。
     */
    readonly discardedRepoHost: string | null,
    readonly occurredAt: Date,
  ) {}
}

/**
 * `POST /api/projects/:id/cancel-clone` —— 用户在克隆进行中按了取消。
 *
 * ⚠️ **它不改聚合状态**：真正的落定由 `CloneProjectWorkflow` 的失败路径写成
 * `failed` + `INTERRUPTED`。所以这条事件是「有人按了停止」的**唯一**记录 ——
 * 没有它，`INTERRUPTED` 与「网线被拔了」在事后完全分不开（同 03 §8.3 对 `killed`
 * 与 `failed` 必须分开的论证）。
 */
export class ProjectCloneCancelled implements DomainEvent {
  readonly type = 'ProjectCloneCancelled';
  constructor(
    readonly projectId: ProjectId,
    readonly name: string,
    readonly occurredAt: Date,
  ) {}
}

/**
 * `POST /api/projects/:id/sync` —— 基线被从远端刷新了一次（03 §7.2★）。
 *
 * ⚠️ **它改的是往后每个新 Task 看到的代码**，而已在跑的 Task 的工作区是创建时的
 * copy-on-write 快照、**不受影响**（`Project.syncBaseline` 的注释）。于是「同一个项目
 * 的两个 Task 坐在不同 commit 上」是个刻意不上 UI 的语义 —— 没有这条审计行，
 * 「什么时候同步过」在事后一处都查不到，那个已知语义就变成了一个查不清的怪事。
 */
export class ProjectBaselineSynced implements DomainEvent {
  readonly type = 'ProjectBaselineSynced';
  constructor(
    readonly projectId: ProjectId,
    readonly name: string,
    readonly baselineSizeBytes: number,
    readonly occurredAt: Date,
  ) {}
}

/**
 * `DELETE /api/projects/:id` —— 项目被删除（23 §6.4）。
 *
 * ⚠️ **审计里最不能缺的恰好是它。** 13 §2.8.2 用整整一节论证 `subject_id` 不设 FK 的
 * 理由就是「审计必须在**主体被删除之后**继续存在」—— 而实测下来，删掉项目后 `seq`
 * 一点没动：连那条记录本身都不存在，弱引用留给谁用都无所谓了。
 *
 * ⚠️ `name` 在这一条上尤其承重：项目行已经没了，**没有任何库可以回查**。
 */
export class ProjectDeleted implements DomainEvent {
  readonly type = 'ProjectDeleted';
  constructor(
    readonly projectId: ProjectId,
    readonly name: string,
    /** 删除时是否保留了基线目录（`DeleteProjectInput.keepBaseline`）。 */
    readonly keptBaseline: boolean,
    readonly occurredAt: Date,
  ) {}
}

/**
 * `DELETE /api/sandboxes/:id { keepVolume: true }` 之后，工作区卷被登记进账本
 * （23 §6.4 `VolumeRetained`，由 `SandboxDestroyed(keepVolume=true)` 触发后产生）。
 *
 * ⚠️ **不带 `workspacePath`。** 宿主绝对路径是部署布局，而事件会一路进审计流、进
 * 面板、进用户截图（同 `RetainedVolumeDto` 刻意不含它的理由，10 §7.3）。要定位一条
 * 记录，`volumeId` 就够。
 *
 * ⚠️ `retainUntil` 随事件走：保留期是这条审计行**唯一**能回答「什么时候会被自动清掉」
 * 的地方，而记录本身到期后会被置 `deletedAt`，事后回查只能看到「已清理」。
 */
export class VolumeRetained implements DomainEvent {
  readonly type = 'VolumeRetained';
  constructor(
    readonly volumeId: string,
    readonly projectId: ProjectId,
    readonly sandboxId: string | null,
    readonly retainUntil: Date,
    readonly diskBytes: number,
    readonly downloadBytes: number,
    readonly occurredAt: Date,
  ) {}
}
