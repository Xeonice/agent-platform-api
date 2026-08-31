import { sql } from 'drizzle-orm';
import { sqliteTable, text, integer, check, index } from 'drizzle-orm/sqlite-core';
import { projects } from '@platform/project';

/**
 * `automations`（13 §2.7.1）与 `automation_runs`（13 §2.7.2），逐列对齐。
 *
 * 跨方言纪律（13 §1 / 28 §3）：枚举 = text + CHECK；不用 `.array()`；时间戳是 JS Date
 * （integer timestamp 模式）。每条 CHECK 带上它的 I-AUT-* / I-AUR-* 编号。
 */
export const automations = sqliteTable(
  'automations',
  {
    id: text('id').primaryKey(),
    /** 13 §2.7.4：**FK RESTRICT**。删项目走应用层级联（先删规则再删项目）。 */
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    description: text('description'),
    /** registry key，**无 FK**（13 §2.3.3：建 FK 等于把插件体系钉进数据库）。 */
    runtimeId: text('runtime_id').notNull(),
    prompt: text('prompt').notNull(),
    scheduleKind: text('schedule_kind').notNull(),
    /** `{minute}` / `{time}` / `{days,time}` —— **不含时区**（时区是下面那一列）。 */
    scheduleConfig: text('schedule_config', { mode: 'json' }).notNull(),
    /**
     * ★ IANA 时区名，**创建时快照、存续期内不变**（I-AUT-9）。
     *
     * 它提为独立列而不是留在 `schedule_config` 里，两个理由（13 §2.7.1）：
     * ① 调度器每分钟都要读它，独立列可直接过滤/排序，而 SQLite 的 json 是 TEXT、
     *    不支持 `->`；② 它的生命周期语义与 config 不同 —— config 可被用户编辑，
     *    timezone 是快照。
     */
    timezone: text('timezone').notNull(),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    /** 降频态：`consecutive_failures ≥ 3` 置 true，调度压为每日一次；**原 schedule 不改写**（I-AUT-3）。 */
    degraded: integer('degraded', { mode: 'boolean' }).notNull().default(false),
    concurrencyMode: text('concurrency_mode').notNull().default('skip'),
    artifactRetentionDays: integer('artifact_retention_days').notNull().default(7),
    timeoutMinutes: integer('timeout_minutes').notNull().default(120),
    webhookUrl: text('webhook_url'),
    triggerOn: text('trigger_on').notNull().default('failure'),
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    lastTriggeredAt: integer('last_triggered_at', { mode: 'timestamp' }),
    nextTriggerAt: integer('next_trigger_at', { mode: 'timestamp' }),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
  },
  (t) => ({
    projectIdx: index('automations_project_idx').on(t.projectId),
    /**
     * ⚠️ **调度器每分钟扫描的唯一依赖，必须是复合索引**（13 §2.7.1）：先按 enabled
     * 过滤、再按时间范围扫。拆成两个单列索引，SQLite 只会挑一个用，另一半退化成
     * 全表过滤 —— 规则数上到几百条时那是每分钟一次的全表扫。
     */
    dueIdx: index('automations_enabled_next_trigger_idx').on(t.enabled, t.nextTriggerAt),
    scheduleKindCk: check(
      'automations_schedule_kind_ck',
      sql`${t.scheduleKind} IN ('hourly','daily','weekly')`,
    ),
    // I-AUT-5
    timeoutCk: check('automations_timeout_ck', sql`${t.timeoutMinutes} IN (30,60,120,240)`),
    retentionCk: check('automations_retention_ck', sql`${t.artifactRetentionDays} IN (3,7,30)`),
    triggerOnCk: check(
      'automations_trigger_on_ck',
      sql`${t.triggerOn} IN ('failure','success','all')`,
    ),
    concurrencyCk: check(
      'automations_concurrency_ck',
      sql`${t.concurrencyMode} IN ('skip','queue','concurrent')`,
    ),
    // I-AUT-5：与 `sandboxes.initial_prompt` 同规格
    promptLenCk: check('automations_prompt_len_ck', sql`length(${t.prompt}) <= 8000`),
    failuresCk: check('automations_failures_ck', sql`${t.consecutiveFailures} >= 0`),
    // I-AUT-9 的 DB 那一半：非空。IANA 合法性 DB 表达不了，在 `Schedule` 值对象里真解一次。
    timezoneCk: check('automations_timezone_ck', sql`length(${t.timezone}) > 0`),
  }),
);

/**
 * `automation_runs`（13 §2.7.2）—— **append-only 历史**，独立聚合（23 D-9）。
 *
 * ⚠️ **13 §2.7.1 写着「项目归档 ⇒ `enabled=false`」，本轮无从落地**：归档功能不存在
 * （F21-6 §10 裁决 D 明确不做），没有归档入口就没有那条联动的触发点。这里只留这条
 * 注释，**不为它造一个假的归档入口** —— 造一个只有自动化在用的「归档」按钮，会让
 * 下一个人以为项目归档已经是平台能力。
 */
export const automationRuns = sqliteTable(
  'automation_runs',
  {
    id: text('id').primaryKey(),
    automationId: text('automation_id')
      .notNull()
      .references(() => automations.id, { onDelete: 'cascade' }),
    /**
     * ⚠️ **弱引用，刻意无 FK**（13 §2.7.4）：① `skipped`/`missed` 的 run 根本没有
     * sandbox，FK 会逼出一堆 NULL 语义之外的判断；② run 历史保留 ≥30 天而 sandbox
     * 终态 90 天归档，两条独立的清理节奏不该互相拖住。
     */
    sandboxId: text('sandbox_id'),
    triggeredAt: integer('triggered_at', { mode: 'timestamp' }).notNull(),
    status: text('status').notNull().default('pending'),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    retryCount: integer('retry_count').notNull().default(0),
    retryAt: integer('retry_at', { mode: 'timestamp' }),
    startedAt: integer('started_at', { mode: 'timestamp' }),
    completedAt: integer('completed_at', { mode: 'timestamp' }),
    durationSec: integer('duration_sec'),
    /** stdout 末尾 1KB，列表快速预览。正文在 `log_path` 指的文件里，只存一份（03 §8.6）。 */
    outputSummary: text('output_summary'),
    logPath: text('log_path'),
    logBytes: integer('log_bytes'),
    /** **唯一允许后置补写的字段**（I-AUR-3）；投递失败绝不影响 run 状态。 */
    webhookStatus: text('webhook_status'),
    /**
     * ★ **13 §2.7.2 的列表里没有这一列，03 §8.1 却明确要求它**（「13 automation_runs
     * 加 `outcome_applied` 列」）。两处文档不一致，本轮按 03 落地并回填 13。
     *
     * 它挡的是：run 已 `finalize`（终态写入）但 `Automation.recordOutcome()` 尚未生效
     * 时进程崩溃 —— 仅按 `next_trigger_at` 扫规则**发现不了**它，会漏记一次失败计数
     * （交叉评审 P2-7）。调度器每轮据此补扫。
     */
    outcomeApplied: integer('outcome_applied', { mode: 'boolean' }).notNull().default(false),
  },
  (t) => ({
    /** 历史分页（13 §2.7.2）。 */
    historyIdx: index('automation_runs_automation_triggered_idx').on(t.automationId, t.triggeredAt),
    /** 调度器捞待重试项（13 §2.7.2）。 */
    retryIdx: index('automation_runs_status_retry_idx').on(t.status, t.retryAt),
    /** outcome-pending 补扫（03 §8.1）。 */
    outcomeIdx: index('automation_runs_outcome_idx').on(t.outcomeApplied, t.status),
    statusCk: check(
      'automation_runs_status_ck',
      sql`${t.status} IN ('pending','running','success','failed','timeout','resource-exhausted','skipped','missed')`,
    ),
    // I-AUR-2
    retryCountCk: check('automation_runs_retry_count_ck', sql`${t.retryCount} BETWEEN 0 AND 5`),
    // I-AUR-4：10MB × 3 分片
    logBytesCk: check(
      'automation_runs_log_bytes_ck',
      sql`${t.logBytes} IS NULL OR ${t.logBytes} <= 31457280`,
    ),
    webhookStatusCk: check(
      'automation_runs_webhook_status_ck',
      sql`${t.webhookStatus} IS NULL OR ${t.webhookStatus} IN ('sent','failed','skipped')`,
    ),
  }),
);

export const automationSchema = { automations, automationRuns };
export type AutomationRow = typeof automations.$inferSelect;
export type AutomationInsert = typeof automations.$inferInsert;
export type AutomationRunRow = typeof automationRuns.$inferSelect;
export type AutomationRunInsert = typeof automationRuns.$inferInsert;
