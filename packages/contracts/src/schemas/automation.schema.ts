import { z } from 'zod';
import { AbsoluteUrlSchema, IsoInstantSchema } from './primitives';
import { TimeoutMinutesSchema } from './enums';
import { RetentionDaysSchema } from './project.schema';

/**
 * automation 的 zod 单一真源（13 §2.7 / 23 §11 / 10 §6.5 与 §7.3 / 27 §8）。
 * 一处产出 REST DTO、OpenAPI 反射；**不产出 MCP inputSchema** —— automation 全部
 * 11 个端点刻意不进 MCP（27 §11.3：管理员配置动作）。
 */

/** 13 §2.7.1 CHECK。cron 表达式是 v1.2 才加的第四个值，今天不接受。 */
export const ScheduleKindSchema = z.enum(['hourly', 'daily', 'weekly']);
export type ScheduleKind = z.infer<typeof ScheduleKindSchema>;

/** 13 §2.7.1 CHECK。`timeout` 归入 `failure` 语义（03 §8.5）。 */
export const TriggerOnSchema = z.enum(['failure', 'success', 'all']);
export type TriggerOn = z.infer<typeof TriggerOnSchema>;

/**
 * 13 §2.7.2 CHECK 的 8 值。
 *
 * ⚠️ **`resource-exhausted` 是过程态不是终态**（审计 P2-2）：它表示「因资源不足正在
 * 排队重试」，配合 `retryCount` / `retryAt` 使用；重试成功转 `running`、5 次仍失败转
 * `failed`（`errorCode='RESOURCE_EXHAUSTED'`）。前端渲染成「⚠️ 资源重试中 n/5」而不是
 * 失败（27 §8 前端第 2 条）。
 */
export const AUTOMATION_RUN_STATUSES = [
  'pending',
  'running',
  'success',
  'failed',
  'timeout',
  'resource-exhausted',
  'skipped',
  'missed',
] as const;
export const AutomationRunStatusSchema = z.enum(AUTOMATION_RUN_STATUSES);
export type AutomationRunStatus = z.infer<typeof AutomationRunStatusSchema>;

/** 13 §2.7.2 CHECK。投递失败**绝不**影响 run 状态（03 §8.5）。 */
export const WebhookStatusSchema = z.enum(['sent', 'failed', 'skipped']);
export type WebhookStatus = z.infer<typeof WebhookStatusSchema>;

/**
 * `automation_runs.error_code` 的闭集。
 *
 * ⚠️ 三个码都在 10 §6.8「★ 错误码全量表」里有行（A5 门禁对账）。它们**不是 HTTP
 * 错误** —— 它们只出现在 `AutomationRunDto.errorCode` 上，与 `TaskErrorCode` 那批走
 * WS 的码同理（10 §6.8「码表按码查、不分传输」）。
 */
export const AutomationRunErrorCodeSchema = z.enum([
  /** 决策表行 1：上次触发的 Task 仍在非终态（03 §8.2）。 */
  'PREVIOUS_RUNNING',
  /** 决策表行 2：该 runtime 无生效凭证 / 已过期 / 已吊销（03 §8.2）。 */
  'AUTH_EXPIRED',
  /** 决策表行 3：资源不足重试 5 次仍失败后的终态原因（03 §8.2）。 */
  'RESOURCE_EXHAUSTED',
]);
export type AutomationRunErrorCode = z.infer<typeof AutomationRunErrorCodeSchema>;

/**
 * `schedule_config` —— **只存「几点几分/周几」，不含时区**（13 §2.7.1）。时区是
 * 独立列（见 `timezone`），因为它是调度器每分钟都要读的核心输入，且生命周期语义
 * 与 config 不同：config 可被用户编辑，timezone 是创建时快照。
 *
 * 按 `scheduleKind` 取用哪些字段（形状校验在 `Schedule` 值对象里，它才是能对
 * 「daily 少了 time」说话的地方）：
 *   · `hourly` → `{ minute }`      每小时的第 minute 分钟
 *   · `daily`  → `{ time }`        `HH:mm`
 *   · `weekly` → `{ days, time }`  `days` 是 0(周日)–6(周六)
 */
export const AutomationScheduleConfigSchema = z.object({
  minute: z.number().int().min(0).max(59).optional(),
  time: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'time must be HH:mm (24h)')
    .optional(),
  days: z.array(z.number().int().min(0).max(6)).min(1).max(7).optional(),
});
export type AutomationScheduleConfig = z.infer<typeof AutomationScheduleConfigSchema>;

/**
 * `POST /api/projects/:id/automations`（10 §7.3 `CreateAutomationRequest`）。
 *
 * ⚠️ **`timezone` 必填且是快照**（I-AUT-9）：前端传当时的浏览器时区，之后规则存续期内
 * 不变。它不是 `.refine` 出来的 IANA 校验 —— zod 的 `refine` 会产出 `ZodEffects`，
 * `createZodDto`/Swagger 无法反射其属性（与 `CreateProjectSchema` 同款取舍）；IANA 合法性
 * 由 `Schedule` 值对象用 `Intl.DateTimeFormat` 真解一次（T-AUT-8）。
 */
export const CreateAutomationSchema = z.object({
  name: z.string().min(1).max(60),
  description: z.string().max(500).optional(),
  /** registry key（开放 id，不是封闭联合 —— 10 §7.2 可扩展类型原则）。 */
  runtime: z.string().min(1),
  /** I-AUT-5：与 `sandboxes.initial_prompt` / `RunAgentTaskSchema.prompt` 同一上限。 */
  prompt: z.string().min(1).max(8000),
  scheduleKind: ScheduleKindSchema,
  scheduleConfig: AutomationScheduleConfigSchema,
  /** IANA 名（`Asia/Shanghai`）。⛔ 编辑时不隐式重传（27 §8 前端第 0 条）。 */
  timezone: z.string().min(1).max(64),
  timeoutMinutes: TimeoutMinutesSchema,
  artifactRetentionDays: RetentionDaysSchema,
  webhookUrl: z.string().min(1).max(2048).optional(),
  triggerOn: TriggerOnSchema.optional(),
});
export type CreateAutomationInput = z.infer<typeof CreateAutomationSchema>;

/**
 * `PUT /api/automations/:id`（27 §8 `updateAutomation`）。
 *
 * ⚠️ **全字段 optional，`timezone` 也是** —— 这不是偷懒，是 I-AUT-9 的线上那一半：
 * 缺席 = 原样保留。若 `timezone` 是必填，前端每次改 prompt 都得把「当前浏览器时区」
 * 再传一遍，用户换台机器就会把凌晨三点的任务挪走（03 §8.1 的原话）。
 */
export const UpdateAutomationSchema = CreateAutomationSchema.partial();
export type UpdateAutomationInput = z.infer<typeof UpdateAutomationSchema>;

/** `AutomationDto`（10 §7.3）= 状态字段 + Create 字段回显。 */
export const AutomationDtoSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  name: z.string(),
  description: z.string().optional(),
  runtime: z.string(),
  prompt: z.string(),
  scheduleKind: ScheduleKindSchema,
  scheduleConfig: AutomationScheduleConfigSchema,
  timezone: z.string(),
  timeoutMinutes: TimeoutMinutesSchema,
  artifactRetentionDays: RetentionDaysSchema,
  /** ⚠️ 出站保证是绝对 http/https URL —— `WebhookTarget.create` 在域里把关（I-AUT-6）。 */
  webhookUrl: AbsoluteUrlSchema.optional(),
  triggerOn: TriggerOnSchema,
  enabled: z.boolean(),
  /** 降频态（I-AUT-2/3）。**与 `enabled=false` 是两回事**，列表上要能区分 🟡 vs 🔴。 */
  degraded: z.boolean(),
  consecutiveFailures: z.number().int().nonnegative(),
  lastTriggeredAt: IsoInstantSchema.optional(),
  nextTriggerAt: IsoInstantSchema.optional(),
  createdAt: IsoInstantSchema,
  updatedAt: IsoInstantSchema,
});
export type AutomationDto = z.infer<typeof AutomationDtoSchema>;

/**
 * `AutomationRunDto`（10 §7.3）。
 *
 * ⚠️ **`startedAt` 在这里是 optional，而 10 §7.3 上一版把它写成必填** —— 那一版对不上
 * 13 §2.7.2：`started_at` 可空、`triggered_at` 非空。`skipped` / `missed` 的 run 是
 * **触发时刻直接落定**的（I-AUR-1），它们根本没有「开始执行」这个时刻。必填的
 * `startedAt` 只能靠拿 `triggeredAt` 顶上，而那会让「排队等了多久」这个差值永远是 0。
 * 故本 DTO 两个时刻都给，10 §7.3 已同步改正。
 */
export const AutomationRunDtoSchema = z.object({
  id: z.string(),
  automationId: z.string(),
  /** 触发产生的 Task。⚠️ 弱引用（13 §2.7.2）：跳过/missed 时缺席。 */
  sandboxId: z.string().optional(),
  status: AutomationRunStatusSchema,
  errorCode: AutomationRunErrorCodeSchema.optional(),
  errorMessage: z.string().optional(),
  retryCount: z.number().int().min(0).max(5),
  retryAt: IsoInstantSchema.optional(),
  /** 调度器决定触发的那一刻 —— **每条 run 都有**。 */
  triggeredAt: IsoInstantSchema,
  startedAt: IsoInstantSchema.optional(),
  completedAt: IsoInstantSchema.optional(),
  durationMs: z.number().int().nonnegative().optional(),
  /** stdout 末尾 1KB，列表快速预览（13 §2.7.2）。 */
  outputSummary: z.string().optional(),
  webhookStatus: WebhookStatusSchema.optional(),
});
export type AutomationRunDto = z.infer<typeof AutomationRunDtoSchema>;

/** `GET /api/automations/:id/runs` 的分页信封（10 §7.2：**只有 runs 用它**）。 */
/**
 * ⚠️ **游标信封，与 `AuditListResponseDto` 同形**（`{ items, hasMore }`）。
 *
 * 上一版是 `{ items, total, page, pageSize }` 的 offset 分页 —— 在**头部追加**的运行
 * 历史上那是错的：翻页期间新落 run 会让下一页重复上一页的尾部，**而且看起来完全正常**。
 * `useAuditStream` 文件头纪律 ① 点名的就是这里。
 *
 * ⛔ 不回 `total`：append-only 流的总数每刻都在变，回它等于让 UI 显示一个过期的数。
 * 前端翻下一页时把**当前最老那条的 id** 作为 `before` 传回来。
 */
export const PaginatedAutomationRunsSchema = z.object({
  items: z.array(AutomationRunDtoSchema),
  hasMore: z.boolean(),
});
export type PaginatedAutomationRuns = z.infer<typeof PaginatedAutomationRunsSchema>;

/** `POST /api/automations/webhook-test`（03 §8.5 表格最后一行）。 */
export const WebhookTestSchema = z.object({ url: z.string().min(1).max(2048) });
export type WebhookTestInput = z.infer<typeof WebhookTestSchema>;

/**
 * `{ ok, errorCode?, message }`（27 §8）。
 *
 * ⚠️ **`errorCode` 复用既有的四个码，不新造一批**：`VALIDATION_FAILED`（不是
 * http/https、URL 解析不了）、`HOST_NOT_ALLOWED`（SSRF 谓词拒绝）、`TIMEOUT`（10s）、
 * `UPSTREAM_UNAVAILABLE`（连不上或非 2xx）。四个都已在 10 §6.8 表里，测试连接不是
 * 一种新的失败，它只是把既有的失败提前给用户看一次。
 */
export const WebhookTestErrorCodeSchema = z.enum([
  'VALIDATION_FAILED',
  'HOST_NOT_ALLOWED',
  'TIMEOUT',
  'UPSTREAM_UNAVAILABLE',
]);
export type WebhookTestErrorCode = z.infer<typeof WebhookTestErrorCodeSchema>;

export const WebhookTestResultSchema = z.object({
  ok: z.boolean(),
  errorCode: WebhookTestErrorCodeSchema.optional(),
  message: z.string(),
});
export type WebhookTestResult = z.infer<typeof WebhookTestResultSchema>;

/**
 * 每项目规则数上限（I-AUT-7）。**application + DB 双保险的 application 那一半**
 * —— DB 表达不了「按 project_id 计数 ≤ 20」（13 §2.7.1「应用层校验」）。
 */
export const AUTOMATION_PER_PROJECT_LIMIT = 20;

/** 超上限时的错误码（10 §6.8）。409，零副作用。 */
export const AUTOMATION_LIMIT_REACHED = 'AUTOMATION_LIMIT_REACHED';
