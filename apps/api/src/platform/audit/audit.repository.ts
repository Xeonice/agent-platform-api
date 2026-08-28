import { Inject, Injectable } from '@nestjs/common';
import { setImmediate } from 'node:timers/promises';
import { and, asc, desc, eq, gt, gte, inArray, lt, lte, sql, type SQL } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { DATABASE } from '@platform/shared-kernel';
import type { AuditCategory, AuditEventDto, AuditSeverity } from '@platform/contracts';
import { auditEvents, type AuditEventInsert, type AuditEventRow } from './audit-events.sqlite';

type Db = BetterSQLite3Database<Record<string, never>>;

/** 一次裁剪批次的条数。⛔ 硬纪律，别改大 —— 见 `pruneBatch` 的注释。 */
export const PRUNE_BATCH_SIZE = 1000;

export interface AuditListCriteria {
  since?: number;
  before?: number;
  from?: Date;
  to?: Date;
  category?: AuditCategory;
  /**
   * **多值**：`IN (...)`，不是等值 —— 「仅告警」= `['warn','error']`（10 §6.6.1）。
   * 见 `AuditSeverityFilterSchema`：客户端裁剪那套会把「第 201 条上的告警」变成
   * 「平台从没告警过」。
   */
  severity?: readonly AuditSeverity[];
  subjectId?: string;
  limit: number;
}

export interface AuditListResult {
  items: AuditEventDto[];
  hasMore: boolean;
}

/**
 * `audit_events` 的读写口。**没有聚合、没有领域对象** —— 这张表是观察设施，行就是行
 * （13 §2.8.2），套一层实体只会多一层要维护的映射。
 */
@Injectable()
export class AuditRepository {
  constructor(@Inject(DATABASE) private readonly db: Db) {}

  /**
   * 单条写入。**同步**（better-sqlite3 本来就是同步驱动），实测 0.05–0.09 ms
   * （13 §2.8.2）—— 一次 provision 的 6 条审计合计约 0.5 ms，对 4 s 的 provision
   * 是 0.01%。
   *
   * ⚠️ **不在任何事务里**，也不需要在。两个写入口天然都在事务外：projector 由
   * `InProcessEventBus` 的 post-commit microtask 驱动，应用层显式记录是普通调用。
   * 单进程 + 同步驱动 ⇒ 所有写天然串行，**不存在 WAL 写锁竞争**（13 §2.8.2 专门
   * 澄清过这一点）。
   */
  insert(row: AuditEventInsert): void {
    this.db.insert(auditEvents).values(row).run();
  }

  /**
   * 双向游标查询（10 §6.6.1）。
   *
   * ⚠️ **响应恒按 `seq` 降序**，与游标方向无关 —— UI 渲染顺序因此统一，`since` 的
   * 结果 prepend、`before` 的结果 append，两边都不需要再排。
   *
   * ⚠️ `since` 方向**不能**直接 `ORDER BY seq DESC LIMIT n` 就完事吗？能，而且必须
   * 这么做：`since` 要的是「比 since 新的那些里，**最新的 n 条**」。取最旧的 n 条会
   * 让增量刷新永远追不上风暴的头部，而且 `hasMore` 的含义（有断层）会失真。
   *
   * `hasMore` 用**多取一条**判定，不用 `COUNT(*)`：20 万条下 count 要全表/全索引扫，
   * 而 limit+1 只多读一行。
   */
  list(criteria: AuditListCriteria): AuditListResult {
    const conditions = buildConditions(criteria);
    const where = conditions.length > 0 ? and(...conditions) : undefined;
    const rows = this.db
      .select()
      .from(auditEvents)
      .where(where)
      .orderBy(desc(auditEvents.seq))
      .limit(criteria.limit + 1)
      .all();
    const hasMore = rows.length > criteria.limit;
    return { items: rows.slice(0, criteria.limit).map(toDto), hasMore };
  }

  /** 导出用：**升序**流式取（`audit.jsonl` 要按时间正序读才像一条流水）。 */
  streamForExport(criteria: { from?: Date; to?: Date }): AuditEventDto[] {
    const conditions = buildConditions({ ...criteria, limit: 0 });
    const where = conditions.length > 0 ? and(...conditions) : undefined;
    return this.db
      .select()
      .from(auditEvents)
      .where(where)
      .orderBy(asc(auditEvents.seq))
      .all()
      .map(toDto);
  }

  count(): number {
    const row = this.db
      .select({ n: sql<number>`count(*)` })
      .from(auditEvents)
      .get();
    return row?.n ?? 0;
  }

  /**
   * 删掉**最旧的**至多 `PRUNE_BATCH_SIZE` 条满足 `where` 的行，返回实删条数。
   *
   * ⛔ **批次大小是硬纪律，不要"顺手"改大。** better-sqlite3 是**同步**驱动，删除期间
   * 整个事件循环被占住，所有 HTTP 请求排队。13 §2.8.2 的实测：
   *   50 000 条 → **244 ms** ⛔ ／ 5 000 条 → 52 ms ⚠️ ／ 1 000 条 → **7 ms** ✅
   * 所以每批 1000 条，批间由调用方 `await setImmediate()` 让出事件循环。
   *
   * `DELETE … WHERE seq IN (SELECT seq … ORDER BY seq LIMIT n)` 而不是
   * `DELETE … LIMIT n`：后者要 SQLite 编译时开 `SQLITE_ENABLE_UPDATE_DELETE_LIMIT`，
   * better-sqlite3 的内置构建**没有开**，写了会在运行时报语法错。
   */
  private pruneBatch(where: SQL | undefined, limit: number): number {
    const capped = Math.min(limit, PRUNE_BATCH_SIZE);
    if (capped <= 0) return 0;
    const victims = this.db
      .select({ seq: auditEvents.seq })
      .from(auditEvents)
      .where(where)
      .orderBy(asc(auditEvents.seq))
      .limit(capped)
      .all()
      .map((r) => r.seq);
    if (victims.length === 0) return 0;
    this.db.delete(auditEvents).where(inArray(auditEvents.seq, victims)).run();
    return victims.length;
  }

  /**
   * 按时间闸裁剪：删掉 `at < cutoff` 的全部行，分片进行。
   * 返回删除总数。`onBatch` 只给测试观察分片边界用。
   */
  async pruneOlderThan(cutoff: Date, onBatch?: (deleted: number) => void): Promise<number> {
    let total = 0;
    for (;;) {
      const deleted = this.pruneBatch(lt(auditEvents.at, cutoff), PRUNE_BATCH_SIZE);
      if (deleted === 0) break;
      total += deleted;
      onBatch?.(deleted);
      // ⛔ 让出事件循环。删掉这一行 = 把 N 批的阻塞连成一条，实测风险见 pruneBatch。
      await setImmediate();
    }
    return total;
  }

  /**
   * 按条数闸裁剪：总量超过 `maxRows` 时，按 `seq` 从旧到新裁到达标为止，分片进行。
   * 返回删除总数。
   */
  async pruneToMaxRows(maxRows: number, onBatch?: (deleted: number) => void): Promise<number> {
    let total = 0;
    for (;;) {
      const excess = this.count() - maxRows;
      if (excess <= 0) break;
      // 本批删 min(excess, BATCH) 条。⚠️ **上界必须是 excess 而不是恒 BATCH**：
      // 剩余超额 300 条时删满 1000，会把 700 条**没有超额**的历史一起裁掉 —— 条数闸
      // 的语义是「裁到达标为止」，不是「裁到爽为止」。
      const deleted = this.pruneBatch(undefined, excess);
      if (deleted === 0) break;
      total += deleted;
      onBatch?.(deleted);
      await setImmediate();
    }
    return total;
  }
}

function buildConditions(criteria: AuditListCriteria): SQL[] {
  const conditions: SQL[] = [];
  // 游标：向新 / 向老。互斥性由 controller 在更早一层挡下（10 §6.6.1）。
  if (criteria.since !== undefined) conditions.push(gt(auditEvents.seq, criteria.since));
  if (criteria.before !== undefined) conditions.push(lt(auditEvents.seq, criteria.before));
  // 时间范围与游标**正交**：前者是过滤条件，后者是翻页位置（10 §6.6.1）。
  if (criteria.from !== undefined) conditions.push(gte(auditEvents.at, criteria.from));
  if (criteria.to !== undefined) conditions.push(lte(auditEvents.at, criteria.to));
  if (criteria.category !== undefined) conditions.push(eq(auditEvents.category, criteria.category));
  // ⚠️ `inArray` 而不是 `eq`：过滤必须在**服务端**收窄，否则 `LIMIT 201` 取的是全类别的
  // 最近 201 条，「告警在更老的位置」时前端裁完为空，而 `hasMore:false` 会让人以为
  // 「全表没有告警」（10 §6.6.1）。单值 ⇒ `IN ('error')`，与旧行为等价。
  if (criteria.severity !== undefined)
    conditions.push(inArray(auditEvents.severity, [...criteria.severity]));
  if (criteria.subjectId !== undefined)
    conditions.push(eq(auditEvents.subjectId, criteria.subjectId));
  return conditions;
}

/**
 * 行 → DTO。**可空列缺席时不写键**（不是写 `undefined`）：`{"subjectId":null}` 与
 * 「没有这个键」读回来同义，但前者看起来像"有这么个东西、值是空"，排查时多一次误导
 * （与 0013 migration 里 `provider_state` 的同一条纪律）。
 */
function toDto(row: AuditEventRow): AuditEventDto {
  return {
    seq: row.seq,
    at: row.at.toISOString(),
    // 列上有 CHECK 兜着，这里的断言不会说谎；写成 as 是因为 drizzle 把 text 列反射成
    // 宽 string（枚举活在 CHECK 里，13 §1 的跨方言纪律不允许 pgEnum）。
    category: row.category as AuditCategory,
    type: row.type,
    severity: row.severity as AuditSeverity,
    ...(row.subjectType === null ? {} : { subjectType: row.subjectType }),
    ...(row.subjectId === null ? {} : { subjectId: row.subjectId }),
    actor: row.actor,
    summary: row.summary,
    ...(row.detail === null || row.detail === undefined
      ? {}
      : { detail: row.detail as Record<string, unknown> }),
    ...(row.durationMs === null ? {} : { durationMs: row.durationMs }),
    ...(row.outcome === null ? {} : { outcome: row.outcome as 'ok' | 'failed' | 'skipped' }),
    ...(row.errorCode === null ? {} : { errorCode: row.errorCode }),
  };
}
