import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, asc, desc, eq, inArray, lte, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import {
  AutomationRunErrorCodeSchema,
  AutomationRunStatusSchema,
  WebhookStatusSchema,
} from '@platform/contracts';
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
      items: hydrateAll(rows.slice(0, cursor.limit), 'listHistory'),
      hasMore,
    };
  }

  async listPendingRetries(now: Date): Promise<AutomationRun[]> {
    const rows = this.db
      .select()
      .from(automationRuns)
      .where(and(eq(automationRuns.status, 'resource-exhausted'), lte(automationRuns.retryAt, now)))
      .orderBy(asc(automationRuns.retryAt))
      .all();
    return hydrateAll(rows, 'listPendingRetries');
  }

  async listActive(): Promise<AutomationRun[]> {
    const rows = this.db
      .select()
      .from(automationRuns)
      .where(inArray(automationRuns.status, ['pending', 'running']))
      .orderBy(asc(automationRuns.triggeredAt))
      .all();
    return hydrateAll(rows, 'listActive');
  }

  /**
   * outcome-pending 孤儿补扫的取数（03 §8.1）。
   *
   * ⚠️ `skipped` / `missed` **不在这个集合里**：它们的 `outcome_applied` 在构造时就是
   * `true`（I-AUT-1 说它们不改 `failureCount`，补扫它们注定是 no-op）。
   */
  async listOutcomePending(limit: number): Promise<AutomationRun[]> {
    const rows = this.db
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
      .all();
    return hydrateAll(rows, 'listOutcomePending');
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

/**
 * 逐行水化，**一行坏数据不许拖垮整批** —— 与 `automation.repository.impl.ts::hydrateAll`
 * 同一条（2026-09-05 补齐）。
 *
 * ⚠️ **这里的危险与姊妹文件不是同一个，别照抄结论。** 那边 `Automation.rehydrate` 会跑
 * 一串值对象校验（`Schedule.create` 真解 IANA 等），所以裸 `.map` 的症状是**抛出来、
 * 整批全没**。而 `AutomationRun.rehydrate` 只是纯赋值 —— 它**根本不会抛**。
 *
 * ⛔ **它原本的毛病是反过来的：坏数据静默流进领域层。** 三个 `as` 断言零校验，
 * 而 DB 侧只有两条 CHECK 兜着：
 *
 * | 列 | DB CHECK | 断言有没有依据 |
 * |---|---|---|
 * | `status` | ✅ `automation_runs_status_ck` | 有 |
 * | `webhook_status` | ✅ `automation_runs_webhook_status_ck` | 有 |
 * | **`error_code`** | ❌ **没有** | **没有** —— 任何绕过聚合的写入（迁移、手工改数据）都能塞进去 |
 *
 * ⇒ 先让 `toDomain` **真的校验**（用契约里那三个 zod 闭集），它才会抛；
 * 然后 per-row 隔离才不是仪式 —— 它现在真的挡着一件会发生的事。
 *
 * ⛔ 坏行**不静默吞掉**：每行单独 log 一次带上 id，否则「这条 run 怎么不见了」
 * 又变成一个查不出来的问题。
 */
function hydrateAll(rows: readonly AutomationRunRow[], where: string): AutomationRun[] {
  const out: AutomationRun[] = [];
  for (const row of rows) {
    try {
      out.push(toDomain(row));
    } catch (e) {
      HYDRATE_LOGGER.error(
        `automation run ${row.id} 的行数据无法水化（${where}），本轮跳过它、其余照常：` +
          `${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  return out;
}

const HYDRATE_LOGGER = new Logger('AutomationRunRepository');

/** 闭集列的解码。⛔ **解不出就抛**——让 `hydrateAll` 跳过这一行，而不是放一个非法值进领域。 */
function decodeEnum<T>(
  schema: { safeParse: (v: unknown) => { success: boolean; data?: T } },
  raw: unknown,
  column: string,
): T {
  const r = schema.safeParse(raw);
  if (!r.success || r.data === undefined) {
    throw new Error(`${column} 的值 ${JSON.stringify(raw)} 不在闭集里`);
  }
  return r.data;
}

function toDomain(row: AutomationRunRow): AutomationRun {
  return AutomationRun.rehydrate({
    id: row.id,
    automationId: row.automationId as AutomationId,
    sandboxId: row.sandboxId,
    triggeredAt: row.triggeredAt,
    status: decodeEnum<AutomationRunStatus>(AutomationRunStatusSchema, row.status, 'status'),
    errorCode:
      row.errorCode === null
        ? null
        : decodeEnum<AutomationRunErrorCode>(
            AutomationRunErrorCodeSchema,
            row.errorCode,
            'error_code',
          ),
    errorMessage: row.errorMessage,
    retryCount: row.retryCount,
    retryAt: row.retryAt,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    durationSec: row.durationSec,
    outputSummary: row.outputSummary,
    logPath: row.logPath,
    logBytes: row.logBytes,
    webhookStatus:
      row.webhookStatus === null
        ? null
        : decodeEnum<WebhookStatus>(WebhookStatusSchema, row.webhookStatus, 'webhook_status'),
    outcomeApplied: row.outcomeApplied,
  });
}
