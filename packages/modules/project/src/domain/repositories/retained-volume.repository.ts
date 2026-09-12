import type { ProjectId, RetainedVolumeId, Tx } from '@platform/shared-kernel';
import type { RetainedVolume } from '../entities/retained-volume.entity';

/**
 * `RetainedVolumeRepository`（23 §6.5 逐条对齐）。
 *
 * `findByWorkspacePath` 是 23 那张表之外多出来的一条，它对应 I-RV-3 的应用层那一半：
 * 重放一次销毁时必须能问「这个目录登记过没有」，否则唯一约束只会在 INSERT 上炸成一个
 * 异常，而 24 §5.2 要的是一次 no-op。
 */
export interface RetainedVolumeRepository {
  findById(id: RetainedVolumeId): Promise<RetainedVolume | null>;
  findByWorkspacePath(workspacePath: string): Promise<RetainedVolume | null>;
  listByProject(projectId: ProjectId, includeDeleted?: boolean): Promise<RetainedVolume[]>;
  /** 全部项目；「已保留卷」不带 projectId 过滤时用。 */
  listAll(includeDeleted?: boolean): Promise<RetainedVolume[]>;
  /** `VolumeReaper` 的取数：到期且**尚未**清理的。 */
  listExpired(now: Date): Promise<RetainedVolume[]>;
  saveSync(tx: Tx, volume: RetainedVolume): void;
  /**
   * 删项目时**连带清掉**这个项目名下的登记行（硬删，与 `remove()` 的软删是两回事）。
   *
   * ⚠️ 为什么必须有这一条：`project_id` 上是 `onDelete: 'restrict'`，而 `remove()` 只把
   * `deleted_at` 打上标、行永远留着 ⇒ 一个项目只要曾经有过一份保留成果，
   * `DELETE FROM projects` 就会被 FK 顶回来，**用户把成果清干净也没用，永远删不掉**。
   * 2026-09-11 在真库上实证过：`deleted_at` 已置位的行照样报 `FOREIGN KEY constraint failed`。
   *
   * ⛔ 这**不是**在丢审计：卷的两次生命周期动作（`VolumeRetained` / `project.volume_deleted`）
   * 都已经进了 `audit_events`，而那张表按 13 §2.8.2 本来就**不设 FK**、活过主体。
   * 这里删掉的只是操作表里的墓碑行。
   *
   * ⚠️ 调用前必须已经确认**没有还在占盘的卷**（`deletedAt === null`）——
   * 那种情况要拒绝整个删除，而不是把用户明确留下的成果一起清掉。
   */
  deleteByProjectSync(tx: Tx, projectId: ProjectId): void;
}

export const RETAINED_VOLUME_REPOSITORY = Symbol('RetainedVolumeRepository');
