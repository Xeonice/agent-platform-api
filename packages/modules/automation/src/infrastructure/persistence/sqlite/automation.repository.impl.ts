import { Inject, Injectable } from '@nestjs/common';
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
  constructor(@Inject(DATABASE) private readonly db: Db) {}

  async findById(id: AutomationId): Promise<Automation | null> {
    const row = this.db.select().from(automations).where(eq(automations.id, id)).get();
    return row ? toDomain(row) : null;
  }

  async listByProject(projectId: ProjectId): Promise<Automation[]> {
    return this.db
      .select()
      .from(automations)
      .where(eq(automations.projectId, projectId))
      .orderBy(asc(automations.createdAt))
      .all()
      .map(toDomain);
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
    return this.db
      .select()
      .from(automations)
      .where(and(eq(automations.enabled, true), lte(automations.nextTriggerAt, now)))
      .orderBy(asc(automations.nextTriggerAt))
      .all()
      .map(toDomain);
  }

  async listAllForSweep(): Promise<Automation[]> {
    return this.db
      .select()
      .from(automations)
      .orderBy(asc(automations.createdAt))
      .all()
      .map(toDomain);
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
