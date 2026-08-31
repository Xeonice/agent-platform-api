import { sql } from 'drizzle-orm';
import {
  sqliteTable,
  text,
  integer,
  real,
  index,
  check,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import { sandboxes } from './sandbox.sqlite';

/**
 * `resource_allocations`（13 §2.1.3，9 列逐列对齐）—— 配额账本。
 *
 * ⚠️ **`uq_alloc_active` 是本表的重点，不是一个附带的索引。** 13 §2.1.3 原话：
 * 「这是把『至多一条活跃』从应用层不变量下沉到存储层的关键一招——并发创建时它是最后
 * 一道防超分配的闸」。drizzle 的写法是 `uniqueIndex(...).on(...).where(...)`；**`where`
 * 掉了这条索引就退化成「一个 sandbox 一辈子只能有一条登记」**，于是「销毁后重建」直接
 * 写不进去 —— 而那不会在任何只建不销毁的测试里暴露（`test/integration/
 * resource-allocation-repository.spec.ts` 专门有一条盯着它）。
 *
 * ⚠️ **`node_id` 上没有 FK，尽管 13 §2.1.3 画了一条 `FK→nodes.id`。** `nodes` 是多节点
 * 预留表（13 §2.8.3），**至今没有建**（§2.0 的「⏳ 仍未建」名单里有它）。指向一张不存在
 * 的表的外键建不出来，硬写只会让迁移在 `foreign_keys=ON` 时炸。列与索引照建、默认值恒
 * `'local'`，等 `nodes` 落地时再补 FK —— 这与 13 §2.9 对 #7 的记法一致（「目标表根本不
 * 存在」）。
 */
export const resourceAllocations = sqliteTable(
  'resource_allocations',
  {
    id: text('id').primaryKey(),
    sandboxId: text('sandbox_id')
      .notNull()
      .references(() => sandboxes.id, { onDelete: 'cascade' }),
    /** 多节点预留；单机恒 `'local'`。FK 见文件头。 */
    nodeId: text('node_id').notNull().default('local'),
    coresReserved: real('cores_reserved').notNull(),
    ramMbReserved: integer('ram_mb_reserved').notNull(),
    /**
     * 磁盘进调度（审计 P1-9）：互斥区内按 `projects.baseline_size_bytes × 1.2` 登记
     * （空项目取配置下限，默认 512MB）。登记在此而非准备阶段预检，是为了**消除 TOCTOU**。
     */
    diskMbReserved: integer('disk_mb_reserved').notNull(),
    allocatedAt: integer('allocated_at', { mode: 'timestamp' }).notNull(),
    /** **NULL = 当前活跃占用**；置值后不可回退（23 I-RA-1）。 */
    releasedAt: integer('released_at', { mode: 'timestamp' }),
    reconciliationStatus: text('reconciliation_status').notNull().default('pending'),
  },
  (t) => ({
    sandboxIdx: index('idx_alloc_sandbox').on(t.sandboxId),
    // 13 §2.1.3「资源池一次扫描同时算出 cores/ram/disk 三个维度的
    // SUM(...) WHERE released_at IS NULL」
    nodeReleasedIdx: index('idx_alloc_node_released').on(t.nodeId, t.releasedAt),
    // 23 I-RA-2：同一 sandbox 同时至多一条活跃登记。**部分**唯一索引 —— 见文件头。
    activeUq: uniqueIndex('uq_alloc_active')
      .on(t.sandboxId)
      .where(sql`released_at is null`),
    reconciliationCk: check(
      'resource_allocations_reconciliation_ck',
      sql`${t.reconciliationStatus} IN ('confirmed','pending','orphaned')`,
    ),
    positiveCk: check(
      'resource_allocations_positive_ck',
      sql`${t.coresReserved} > 0 AND ${t.ramMbReserved} > 0 AND ${t.diskMbReserved} > 0`,
    ),
  }),
);

export const resourceAllocationSchema = { resourceAllocations };
export type ResourceAllocationRow = typeof resourceAllocations.$inferSelect;
export type ResourceAllocationInsert = typeof resourceAllocations.$inferInsert;
