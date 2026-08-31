import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, isNull, lte } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { DATABASE } from '@platform/shared-kernel';
import type { ProjectId, RetainedVolumeId, Tx } from '@platform/shared-kernel';
import type { RetainedVolumeSource } from '@platform/contracts';
import { RetainedVolume } from '../../../domain/entities/retained-volume.entity';
import type { RetainedVolumeRepository } from '../../../domain/repositories/retained-volume.repository';
import { retainedVolumes, type RetainedVolumeRow } from '../schema/retained-volume.sqlite';

type Db = BetterSQLite3Database<Record<string, never>>;

/** SQLite (better-sqlite3 + Drizzle) implementation of `RetainedVolumeRepository`. */
@Injectable()
export class SqliteRetainedVolumeRepository implements RetainedVolumeRepository {
  constructor(@Inject(DATABASE) private readonly db: Db) {}

  async findById(id: RetainedVolumeId): Promise<RetainedVolume | null> {
    const row = this.db.select().from(retainedVolumes).where(eq(retainedVolumes.id, id)).get();
    return row ? toDomain(row) : null;
  }

  async findByWorkspacePath(workspacePath: string): Promise<RetainedVolume | null> {
    const row = this.db
      .select()
      .from(retainedVolumes)
      .where(eq(retainedVolumes.workspacePath, workspacePath))
      .get();
    return row ? toDomain(row) : null;
  }

  async listByProject(projectId: ProjectId, includeDeleted = false): Promise<RetainedVolume[]> {
    const live = isNull(retainedVolumes.deletedAt);
    const where = includeDeleted
      ? eq(retainedVolumes.projectId, projectId)
      : and(eq(retainedVolumes.projectId, projectId), live);
    return this.db
      .select()
      .from(retainedVolumes)
      .where(where)
      .orderBy(asc(retainedVolumes.retainedAt))
      .all()
      .map(toDomain);
  }

  async listAll(includeDeleted = false): Promise<RetainedVolume[]> {
    const q = this.db.select().from(retainedVolumes);
    const rows = includeDeleted
      ? q.orderBy(asc(retainedVolumes.retainedAt)).all()
      : q.where(isNull(retainedVolumes.deletedAt)).orderBy(asc(retainedVolumes.retainedAt)).all();
    return rows.map(toDomain);
  }

  /**
   * ⚠️ **`deleted_at IS NULL` 不是可省的条件。** 少了它，reaper 每一轮都会把全部历史
   * 记录重新捞出来，然后对着早已不存在的目录 `rm -rf`、再对一条只读记录调
   * `markDeleted()` —— I-RV-2 会把那一轮整个打断。
   */
  async listExpired(now: Date): Promise<RetainedVolume[]> {
    return this.db
      .select()
      .from(retainedVolumes)
      .where(and(lte(retainedVolumes.retainUntil, now), isNull(retainedVolumes.deletedAt)))
      .orderBy(asc(retainedVolumes.retainUntil))
      .all()
      .map(toDomain);
  }

  saveSync(_tx: Tx, volume: RetainedVolume): void {
    const values = {
      id: volume.id as string,
      projectId: volume.projectId as string,
      sandboxId: volume.sandboxId,
      workspacePath: volume.workspacePath,
      source: volume.source,
      diskBytes: volume.diskBytes,
      downloadBytes: volume.downloadBytes,
      retainUntil: volume.retainUntil,
      retainedAt: volume.retainedAt,
      deletedAt: volume.deletedAt,
    };
    this.db
      .insert(retainedVolumes)
      .values(values)
      .onConflictDoUpdate({
        target: retainedVolumes.id,
        // ⚠️ `workspace_path` / `retained_at` / `source` 不在 set 里：它们是这条记录的
        // 身份与历史事实，一条已登记的记录改了目录路径就等于换了一个卷。
        set: {
          sandboxId: values.sandboxId,
          diskBytes: values.diskBytes,
          downloadBytes: values.downloadBytes,
          deletedAt: values.deletedAt,
        },
      })
      .run();
  }
}

function toDomain(row: RetainedVolumeRow): RetainedVolume {
  return RetainedVolume.rehydrate({
    id: row.id as RetainedVolumeId,
    projectId: row.projectId as ProjectId,
    sandboxId: row.sandboxId,
    workspacePath: row.workspacePath,
    source: row.source as RetainedVolumeSource,
    diskBytes: row.diskBytes,
    downloadBytes: row.downloadBytes,
    retainedAt: row.retainedAt,
    retainUntil: row.retainUntil,
    deletedAt: row.deletedAt,
  });
}
