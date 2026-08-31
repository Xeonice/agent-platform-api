import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, lte, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { DATABASE } from '@platform/shared-kernel';
import type { AutomationId, Tx } from '@platform/shared-kernel';
import { AutomationRun } from '../../../domain/entities/automation-run.entity';
import type {
  AutomationRunErrorCode,
  AutomationRunStatus,
  WebhookStatus,
} from '../../../domain/entities/automation-run.entity';
import type {
  AutomationRunRepository,
  RunCursor,
  RunSlice,
} from '../../../domain/repositories/automation-run.repository';
import { automationRuns, type AutomationRunRow } from '../schema/automation.sqlite';

type Db = BetterSQLite3Database<Record<string, never>>;

@Injectable()
export class SqliteAutomationRunRepository implements AutomationRunRepository {
  constructor(@Inject(DATABASE) private readonly db: Db) {}

  async findById(id: string): Promise<AutomationRun | null> {
    const row = this.db.select().from(automationRuns).where(eq(automationRuns.id, id)).get();
    return row ? toDomain(row) : null;
  }

  async findLatest(automationId: AutomationId): Promise<AutomationRun | null> {
    const row = this.db
      .select()
      .from(automationRuns)
      .where(eq(automationRuns.automationId, automationId))
      .orderBy(desc(automationRuns.triggeredAt), desc(automationRuns.id))
      .limit(1)
      .get();
    return row ? toDomain(row) : null;
  }

  async listByAutomation(automationId: AutomationId, cursor: RunCursor): Promise<RunSlice> {
    // ⚠️ 游标而非 offset：排序键是 `(triggered_at DESC, id DESC)`，游标要用**同一个键**
    //    做「严格早于」比较，否则同一毫秒内的多条会漏或重。id 是 uuid v7、本身时间有序，
    //    所以 `(triggeredAt, id) < (anchor.triggeredAt, anchor.id)` 就是全序上的"更老"。
    const anchor =
      cursor.before === undefined
        ? undefined
        : this.db
            .select({ triggeredAt: automationRuns.triggeredAt, id: automationRuns.id })
            .from(automationRuns)
            .where(eq(automationRuns.id, cursor.before))
            .get();
    const olderThanAnchor =
      anchor === undefined
        ? undefined
        : // ⚠️ `mode: 'timestamp'` 在库里存的是**秒**，而 drizzle 读出来是 Date 对象。
          //    直接把 Date 绑进 raw SQL 会炸（better-sqlite3 只认 number/string/bigint/
          //    buffer/null）—— 必须转回列的存储表示，否则比较的也不是同一个东西。
          sql`(${automationRuns.triggeredAt}, ${automationRuns.id}) < (${Math.floor(anchor.triggeredAt.getTime() / 1000)}, ${anchor.id})`;
    // ⭐ 多取一条**只为判断还有没有下一页** —— 不回 total（append-only 流的总数每刻都在变，
    //    回它等于让 UI 显示一个过期的数）。
    const rows = this.db
      .select()
      .from(automationRuns)
      .where(
        olderThanAnchor === undefined
          ? eq(automationRuns.automationId, automationId)
          : and(eq(automationRuns.automationId, automationId), olderThanAnchor),
      )
      .orderBy(desc(automationRuns.triggeredAt), desc(automationRuns.id))
      .limit(cursor.limit + 1)
      .all();
    const hasMore = rows.length > cursor.limit;
    return {
      items: rows.slice(0, cursor.limit).map(toDomain),
      hasMore,
    };
  }

  async listPendingRetries(now: Date): Promise<AutomationRun[]> {
    return this.db
      .select()
      .from(automationRuns)
      .where(and(eq(automationRuns.status, 'resource-exhausted'), lte(automationRuns.retryAt, now)))
      .orderBy(asc(automationRuns.retryAt))
      .all()
      .map(toDomain);
  }

  async listActive(): Promise<AutomationRun[]> {
    return this.db
      .select()
      .from(automationRuns)
      .where(inArray(automationRuns.status, ['pending', 'running']))
      .orderBy(asc(automationRuns.triggeredAt))
      .all()
      .map(toDomain);
  }

  /**
   * outcome-pending 孤儿补扫的取数（03 §8.1）。
   *
   * ⚠️ `skipped` / `missed` **不在这个集合里**：它们的 `outcome_applied` 在构造时就是
   * `true`（I-AUT-1 说它们不改 `failureCount`，补扫它们注定是 no-op）。
   */
  async listOutcomePending(limit: number): Promise<AutomationRun[]> {
    return this.db
      .select()
      .from(automationRuns)
      .where(
        and(
          eq(automationRuns.outcomeApplied, false),
          inArray(automationRuns.status, ['success', 'failed', 'timeout']),
        ),
      )
      .orderBy(asc(automationRuns.triggeredAt))
      .limit(limit)
      .all()
      .map(toDomain);
  }

  saveSync(_tx: Tx, run: AutomationRun): void {
    const values = {
      id: run.id,
      automationId: run.automationId as string,
      sandboxId: run.sandboxId,
      triggeredAt: run.triggeredAt,
      status: run.status,
      errorCode: run.errorCode,
      errorMessage: run.errorMessage,
      retryCount: run.retryCount,
      retryAt: run.retryAt,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      durationSec: run.durationSec,
      outputSummary: run.outputSummary,
      logPath: run.logPath,
      logBytes: run.logBytes,
      webhookStatus: run.webhookStatus,
      outcomeApplied: run.outcomeApplied,
    };
    this.db
      .insert(automationRuns)
      .values(values)
      .onConflictDoUpdate({
        target: automationRuns.id,
        // ⚠️ `automation_id` / `triggered_at` 不在 set 里 —— 一条 run 属于哪条规则、
        // 在哪一刻被触发，是这条记录的身份，改了就是另一条 run。
        set: {
          sandboxId: values.sandboxId,
          status: values.status,
          errorCode: values.errorCode,
          errorMessage: values.errorMessage,
          retryCount: values.retryCount,
          retryAt: values.retryAt,
          startedAt: values.startedAt,
          completedAt: values.completedAt,
          durationSec: values.durationSec,
          outputSummary: values.outputSummary,
          logPath: values.logPath,
          logBytes: values.logBytes,
          webhookStatus: values.webhookStatus,
          outcomeApplied: values.outcomeApplied,
        },
      })
      .run();
  }
}

function toDomain(row: AutomationRunRow): AutomationRun {
  return AutomationRun.rehydrate({
    id: row.id,
    automationId: row.automationId as AutomationId,
    sandboxId: row.sandboxId,
    triggeredAt: row.triggeredAt,
    status: row.status as AutomationRunStatus,
    errorCode: row.errorCode as AutomationRunErrorCode | null,
    errorMessage: row.errorMessage,
    retryCount: row.retryCount,
    retryAt: row.retryAt,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    durationSec: row.durationSec,
    outputSummary: row.outputSummary,
    logPath: row.logPath,
    logBytes: row.logBytes,
    webhookStatus: row.webhookStatus as WebhookStatus | null,
    outcomeApplied: row.outcomeApplied,
  });
}
