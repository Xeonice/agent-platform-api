import { sql } from 'drizzle-orm';
import { sqliteTable, text, integer, check, index } from 'drizzle-orm/sqlite-core';
import { projects } from './project.sqlite';

/**
 * `retained_volumes`（13 §2.2.2，9 列逐列对齐）。
 *
 * ⚠️ **`sandbox_id` 刻意不建 FK**（13 §2.2.2）：保留卷是用户显式要留下的成果，其生命
 * 周期**长于** sandbox 记录（sandbox 终态 90 天后归档删除，卷可能还在保留期内）。建 FK
 * 会让归档作业删不动 sandbox 行，或被迫 `SET NULL` 触发额外写 —— 弱引用 + 应用层置
 * NULL 更直白。
 *
 * ⚠️ **`disk_bytes` 与 `download_bytes` 必须分开存。** 实测本仓 web 工作区磁盘占
 * 1.0 GB、打包 14 MB，**差 70 倍**；只存一个必然误导 —— 显示 14 MB 会让人以为清理只能
 * 拿回 14 MB，显示 1.0 GB 又与下载量对不上（10 §6 打包口径）。
 */
export const retainedVolumes = sqliteTable(
  'retained_volumes',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'restrict' }),
    /** 弱引用，无 FK —— 见文件头。 */
    sandboxId: text('sandbox_id'),
    workspacePath: text('workspace_path').notNull().unique(), // I-RV-3
    source: text('source').notNull(),
    diskBytes: integer('disk_bytes'),
    downloadBytes: integer('download_bytes'),
    retainUntil: integer('retain_until', { mode: 'timestamp' }).notNull(),
    retainedAt: integer('retained_at', { mode: 'timestamp' }).notNull(),
    deletedAt: integer('deleted_at', { mode: 'timestamp' }),
  },
  (t) => ({
    // 13 §2.2.2: 「已保留卷」列表按项目 + 未清理查
    projectDeletedIdx: index('retained_volumes_project_deleted_idx').on(t.projectId, t.deletedAt),
    // 13 §2.2.2: VolumeReaper 扫到期
    retainUntilIdx: index('retained_volumes_retain_until_idx').on(t.retainUntil),
    sourceCk: check(
      'retained_volumes_source_ck',
      sql`${t.source} IN ('manual-destroy','automation-artifact')`,
    ),
    // I-RV-1 的 DB 那一半（双保险，23 §4.6 第三类）
    retainUntilCk: check(
      'retained_volumes_retain_until_ck',
      sql`${t.retainUntil} > ${t.retainedAt}`,
    ),
  }),
);

export const retainedVolumeSchema = { retainedVolumes };
export type RetainedVolumeRow = typeof retainedVolumes.$inferSelect;
export type RetainedVolumeInsert = typeof retainedVolumes.$inferInsert;
