import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, asc, eq, lte, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { DATABASE } from '@platform/shared-kernel';
import type { AutomationId, ProjectId, Tx } from '@platform/shared-kernel';
import { Automation } from '../../../domain/entities/automation.entity';
import type { ConcurrencyMode } from '../../../domain/entities/automation.entity';
import type { AutomationRepository } from '../../../domain/repositories/automation.repository';
import { Schedule } from '../../../domain/value-objects/schedule.vo';
import type { ScheduleConfig, ScheduleKind } from '../../../domain/value-objects/schedule.vo';
import { TimeoutPolicy, assertRetentionDays } from '../../../domain/value-objects/policies.vo';
import { WebhookTarget } from '../../../domain/value-objects/webhook-target.vo';
import type { TriggerOn } from '../../../domain/value-objects/webhook-target.vo';
import { automations, type AutomationRow } from '../schema/automation.sqlite';

type Db = BetterSQLite3Database<Record<string, never>>;

@Injectable()
export class SqliteAutomationRepository implements AutomationRepository {
  private readonly logger = new Logger(SqliteAutomationRepository.name);

  constructor(@Inject(DATABASE) private readonly db: Db) {}

  async findById(id: AutomationId): Promise<Automation | null> {
    const row = this.db.select().from(automations).where(eq(automations.id, id)).get();
    return row ? toDomain(row) : null;
  }

  async listByProject(projectId: ProjectId): Promise<Automation[]> {
    const rows = this.db
      .select()
      .from(automations)
      .where(eq(automations.projectId, projectId))
      .orderBy(asc(automations.createdAt))
      .all();
    return hydrateAll(rows, this.logger, 'listByProject');
  }

  async countByProject(projectId: ProjectId): Promise<number> {
    const row = this.db
      .select({ n: sql<number>`count(*)` })
      .from(automations)
      .where(eq(automations.projectId, projectId))
      .get();
    return row?.n ?? 0;
  }

  /**
   * 调度器每分钟的取数。**`enabled = true` 与 `next_trigger_at <= now` 两个条件缺一
   * 不可**，且顺序与 `(enabled, next_trigger_at)` 复合索引一致（13 §2.7.1）。
   *
   * ⚠️ `next_trigger_at IS NULL` 的行**扫不到**，这是对的：那是被禁用（`disable()`
   * 会置 NULL）或还没算出下一次的规则，两者都不该触发。
   */
  async listDue(now: Date): Promise<Automation[]> {
    const rows = this.db
      .select()
      .from(automations)
      .where(and(eq(automations.enabled, true), lte(automations.nextTriggerAt, now)))
      .orderBy(asc(automations.nextTriggerAt))
      .all();
    return hydrateAll(rows, this.logger, 'listDue');
  }

  async listAllForSweep(): Promise<Automation[]> {
    const rows = this.db.select().from(automations).orderBy(asc(automations.createdAt)).all();
    return hydrateAll(rows, this.logger, 'listAllForSweep');
  }

  saveSync(_tx: Tx, a: Automation): void {
    const values = {
      id: a.id as string,
      projectId: a.projectId as string,
      name: a.name,
      description: a.description,
      runtimeId: a.runtimeId,
      prompt: a.prompt,
      scheduleKind: a.schedule.kind,
      scheduleConfig: a.schedule.config,
      timezone: a.schedule.timezone,
      enabled: a.enabled,
      degraded: a.degraded,
      concurrencyMode: a.concurrency,
      artifactRetentionDays: a.retentionDays,
      timeoutMinutes: a.timeoutMinutes,
      webhookUrl: a.webhook?.url ?? null,
      triggerOn: a.webhook?.triggerOn ?? 'failure',
      consecutiveFailures: a.failureCount,
      lastTriggeredAt: a.lastTriggeredAt,
      nextTriggerAt: a.nextTriggerAt,
      createdAt: a.createdAt,
      updatedAt: a.updatedAt,
    };
    this.db
      .insert(automations)
      .values(values)
      .onConflictDoUpdate({
        target: automations.id,
        // ⚠️ `project_id` / `created_at` 不在 set 里：一条规则改了归属项目就是另一条
        // 规则了，而 `created_at` 是历史事实。
        set: {
          name: values.name,
          description: values.description,
          runtimeId: values.runtimeId,
          prompt: values.prompt,
          scheduleKind: values.scheduleKind,
          scheduleConfig: values.scheduleConfig,
          timezone: values.timezone,
          enabled: values.enabled,
          degraded: values.degraded,
          concurrencyMode: values.concurrencyMode,
          artifactRetentionDays: values.artifactRetentionDays,
          timeoutMinutes: values.timeoutMinutes,
          webhookUrl: values.webhookUrl,
          triggerOn: values.triggerOn,
          consecutiveFailures: values.consecutiveFailures,
          lastTriggeredAt: values.lastTriggeredAt,
          nextTriggerAt: values.nextTriggerAt,
          updatedAt: values.updatedAt,
        },
      })
      .run();
  }

  deleteSync(_tx: Tx, id: AutomationId): void {
    // `automation_runs` 随 FK ON DELETE CASCADE 一起走（13 §2.7.2）。
    this.db.delete(automations).where(eq(automations.id, id)).run();
  }
}

function toDomain(row: AutomationRow): Automation {
  return Automation.rehydrate({
    id: row.id as AutomationId,
    projectId: row.projectId as ProjectId,
    name: row.name,
    description: row.description,
    runtimeId: row.runtimeId,
    prompt: row.prompt,
    schedule: Schedule.create(
      row.scheduleKind as ScheduleKind,
      row.scheduleConfig as ScheduleConfig,
      row.timezone,
    ),
    enabled: row.enabled,
    degraded: row.degraded,
    concurrency: row.concurrencyMode as ConcurrencyMode,
    timeout: TimeoutPolicy.of(row.timeoutMinutes),
    retentionDays: assertRetentionDays(row.artifactRetentionDays),
    webhook:
      row.webhookUrl === null
        ? null
        : WebhookTarget.create(row.webhookUrl, row.triggerOn as TriggerOn),
    failureCount: row.consecutiveFailures,
    lastTriggeredAt: row.lastTriggeredAt,
    nextTriggerAt: row.nextTriggerAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}
/**
 * 逐行水化，**一行坏数据不许拖垮整批**。
 *
 * ⚠️ `toDomain` 每行都跑完整值对象校验（`Schedule.create` 真解 IANA + `normalizeConfig`、
 * `TimeoutPolicy.of`、`assertRetentionDays`、`WebhookTarget.create`）。上一版是裸
 * `.map(toDomain)`：**任何一行抛，整个 `listDue` 的结果全没**，而 `fireDue` 的
 * per-rule try/catch 在它**下游**，救不了；调度器的 `runStage`（H2 之后）也只保证**别的
 * 阶段**照跑 —— 这一轮仍然是一条规则都不触发，日志上只有一行
 * `automation sweep failed at stage 'fire-due'`。**这一层的隔离必须在这里做。**
 *
 * ⇒ 症状是「**全部规则再也不触发**，每分钟一行日志」。可触发的输入不止一种：
 *  · tzdata/ICU 变更 —— Node 升级后某个曾经合法的 IANA 名解不出来（DB 侧 CHECK 只有
 *    `length(timezone) > 0`，拦不住）；
 *  · `schedule_config` 是 **JSON TEXT、零 CHECK** —— 任何绕过聚合的写入（迁移、手工
 *    改数据）写进 `weekly + days:[]`，`normalizeConfig` 就抛。
 *
 * ⛔ 坏行**不静默吞掉**：每行单独 log 一次，带上 id —— 否则「这条规则怎么不跑了」
 * 又变成一个查不出来的问题。
 */
function hydrateAll(rows: readonly AutomationRow[], logger: Logger, where: string): Automation[] {
  const out: Automation[] = [];
  for (const row of rows) {
    try {
      out.push(toDomain(row));
    } catch (e) {
      logger.error(
        `automation ${row.id} 的行数据无法水化（${where}），本轮跳过它、其余规则照常跑：` +
          `${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  return out;
}
