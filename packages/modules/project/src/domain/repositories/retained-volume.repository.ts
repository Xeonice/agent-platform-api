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
}

export const RETAINED_VOLUME_REPOSITORY = Symbol('RetainedVolumeRepository');
