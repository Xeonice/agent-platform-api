import { z } from 'zod';
import type { ErrorEnvelope } from '../errors';
import { TRIGGERED_BY } from './enums';
import { VALIDATION_FAILED_CODE } from '../validation-envelope';

/** GET /api/health — passcode-exempt liveness probe (shared/11 §3.1). */
export const HealthDtoSchema = z.object({
  status: z.literal('ok'),
  uptimeSec: z.number().nonnegative(),
});
export type HealthDto = z.infer<typeof HealthDtoSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// 平台级审计流（13 §2.8.2 / shared/10 §6.6.1 + §7.3 / P21-5 §10）
//
// ⚠️ **观察设施，不是账本。** 它回答「发生了什么 / 为什么失败」，不得用作计费、
// 合规凭证或任何需要强一致的用途 —— 写入永不阻断业务，`InProcessEventBus` 又是
// 内存 outbox（提交后、microtask 前崩溃 ⇒ 那批丢失）。所以产品文案不得声称
// 「完整无遗漏」（P21-5 §10.5）。
// ─────────────────────────────────────────────────────────────────────────────

/** 13 §2.8.2 `category` 的闭集；前端按它筛（P21-5 §10.2 的五个类别）。 */
export const AUDIT_CATEGORIES = ['sandbox', 'project', 'credential', 'image', 'system'] as const;
export const AuditCategorySchema = z.enum(AUDIT_CATEGORIES);
export type AuditCategory = z.infer<typeof AuditCategorySchema>;

/** 13 §2.8.2 `severity` CHECK 的三值；前端按它筛与着色。 */
export const AUDIT_SEVERITIES = ['info', 'warn', 'error'] as const;
export const AuditSeveritySchema = z.enum(AUDIT_SEVERITIES);
export type AuditSeverity = z.infer<typeof AuditSeveritySchema>;

/** 13 §2.8.2 `outcome` CHECK 的三值；只有「阶段类」事件才有。 */
export const AUDIT_OUTCOMES = ['ok', 'failed', 'skipped'] as const;
export const AuditOutcomeSchema = z.enum(AUDIT_OUTCOMES);
export type AuditOutcome = z.infer<typeof AuditOutcomeSchema>;

/**
 * `actor` —— **谁触发的**，13 §2.8.2 说它是「排障第一个要问的」。
 *
 * ⚠️ 故意**不是 zod enum**：`audit_events.actor` 列上没有 CHECK，schema 里就不该有 ——
 * 否则 DTO 会对一个数据库允许的值报错，而报错的是**读**那一侧（面板），业务照跑，
 * 没人会发现。取值见 `AUDIT_ACTORS`（那是**已知会被写出来的全集**，不是闭集）。
 */
export const AuditActorSchema = z.string().min(1);

/**
 * **后端真实写得出来的 actor 全集**（前端 `ACTOR_LABELS` 按它翻中文）。
 *
 * ⚠️ **它是从 `TRIGGERED_BY` 派生的，不是手抄的一串字面量。** 审计的 actor 有两个来源：
 *   ① `AuditProjector` 把 `SandboxStateChanged.triggeredBy` **原样透传**（audit.projector.ts），
 *      所以 `TRIGGERED_BY` 的每一个值都会成为 actor —— `scheduler` / `health-check` /
 *      `provider-event` 都是这么来的；
 *   ② 应用层显式记录时自己写死的 `'user'`（已含在 `TRIGGERED_BY` 里）与 `'system'`。
 * 手抄过一次的后果已经发生：本常量曾写成 `user/system/scheduler/reaper/mcp/automation`
 * ——**后端主力值 `health-check` / `provider-event` 一个都不在**，而 `mcp` / `automation`
 * 后端一处都不写（automation 上下文是 v1.1，13 §2.7 尚未落地；MCP caller 建沙箱走的是
 * 同一条 `SandboxCreated`，actor 就是 `user`）。派生掉这份手抄，漂移就没有落脚点。
 *
 * ⚠️ 新增 `TriggeredBy` 值时不需要改这里，但**必须**给前端补一条 label —— 那条钉子是
 * `audit.projector.ts` 底部的编译期断言。
 */
export const AUDIT_ACTORS = [...TRIGGERED_BY, 'system'] as const;
export type AuditActor = (typeof AUDIT_ACTORS)[number];

export const AuditEventDtoSchema = z.object({
  /**
   * 单调游标。**公开列，不是 opaque token**（10 §6.6.1）：前端要按它排序、比较、
   * 判断断层，所以直接用数字。这与 `JobCursor` 的「stored, never parsed」是**刻意的
   * 不一致** —— 那边是 stdout/stderr 双偏移的内部结构，这边就是一列主键。
   */
  seq: z.number().int().positive(),
  at: z.string(),
  category: AuditCategorySchema,
  /** `sandbox.provision.stage` 等；**开放集合**，前端不得穷举 switch（10 §7.3）。 */
  type: z.string(),
  severity: AuditSeveritySchema,
  subjectType: z.string().optional(),
  subjectId: z.string().optional(),
  actor: AuditActorSchema,
  summary: z.string(),
  /** 已在**写入口**脱敏（13 §2.8.2 / P21-5 §10.5），不是读出口。 */
  detail: z.record(z.string(), z.unknown()).optional(),
  durationMs: z.number().int().nonnegative().optional(),
  outcome: AuditOutcomeSchema.optional(),
  /** 与 §6.8 同一闭集（04 §4 的码）。 */
  errorCode: z.string().optional(),
});
export type AuditEventDto = z.infer<typeof AuditEventDtoSchema>;

export const AuditListDtoSchema = z.object({
  /** **恒按 seq 降序**（最新在前），与游标方向无关（10 §6.6.1）。 */
  items: z.array(AuditEventDtoSchema),
  /**
   * ⚠️ 两个方向共用一个字段，含义不同（10 §6.6.1）：
   *   · `since` 方向 = 「还有更新的没拉完」= **有断层**，前端不得假装连续；
   *   · `before` 方向 = 「还有更老的」= 可继续滚。
   */
  hasMore: z.boolean(),
});
export type AuditListDto = z.infer<typeof AuditListDtoSchema>;

/** 10 §6.6.1：`limit` 默认 200（= P21-5 §10.2 的「最近 200 条」），上限 500。 */
export const AUDIT_LIMIT_DEFAULT = 200;
export const AUDIT_LIMIT_MAX = 500;

/**
 * `?severity=` —— **逗号分隔的多值**，服务端 `WHERE severity IN (...)` 过滤（10 §6.6.1）。
 *
 * ⚠️ **它必须是多值，等值过滤表达不了产品要的「仅告警」。** 「仅告警」= `warn ∪ error`，
 * 而 `severity` 是三选一的枚举 —— 前端只能不带过滤拉回一页（最多 500 条）再在客户端裁。
 * 那套的失败方式很具体：平台平稳跑了一周、最近 200 条全是 info，昨天那次 provision 失败
 * 落在更老的位置，用户勾「仅告警」看到的是「当前筛选无匹配记录」，得出的结论是
 * **「平台从没告警过」** —— 而告警就在第 201 条。服务端 `IN (...)` 之后
 * `ORDER BY seq DESC LIMIT 201` 扫的是**匹配行**的最新 201 条，于是「空结果 +
 * `hasMore:false`」才真的等于「全表没有告警」。
 *
 * · `severity=error` 单值照旧工作（向后兼容，此前的调用方不用改）；
 * · `severity=warn,error` 即「仅告警」；
 * · **去重**（`warn,warn,error` ⇒ `IN ('warn','error')`）；
 * · 含非法值 ⇒ 400 `VALIDATION_FAILED`（全局 pipe 的信封，带 `sideEffectFree: true`，
 *   与 `since`/`before` 互斥那条同一套）。
 *
 * ⚠️ 因此它在 openapi 里**不再是 enum**（是一个带说明的 string）—— 生成类型随之从
 * `'info'|'warn'|'error'` 变成 `string`。这是刻意的：openapi 的 query enum 描述不了
 * 「逗号分隔子集」，声明成 enum 会让 codegen 出的签名拒绝掉唯一能表达「仅告警」的取值。
 */
export const AuditSeverityFilterSchema = z
  .string()
  .transform((raw) => [...new Set(raw.split(','))])
  .pipe(z.array(AuditSeveritySchema));

/**
 * `GET /api/system/audit` 的 query（10 §6.6.1）。
 *
 * ⚠️ **游标与时间范围正交**：`since`/`before` 管**翻页位置**，`from`/`to` 管**过滤
 * 条件**，可同时传。别用 `to` 代替 `before` 翻页（同毫秒多条会漏），也别把时间范围
 * 折算成 seq（`at` 与 `seq` 只是近似同序，折算会在边界上悄悄吞记录）。
 *
 * ⚠️ `since` / `before` **互斥不写成 `.refine()`**，而是在 controller 里显式判、抛
 * 同一个 `VALIDATION_FAILED` 信封（`auditCursorConflictEnvelope`）。
 * 理由是「一条规则只该有一个出处」：本 schema 的 query 声明**并不是** openapi.json
 * 里那份（实测 `@Query() dto` 在 @nestjs/swagger 下反射出的是 `"parameters": []`，
 * 所以 controller 上另有一组 `@ApiQuery` —— 见那里的注释）。把互斥藏进 `ZodEffects`
 * 只会让它在契约里彻底看不见；写在 controller 里，至少与 `@ApiQuery` 的 description
 * 挨在一起。
 */
export const AuditQuerySchema = z.object({
  /** 向新：返回 `seq > since`（增量刷新）。 */
  since: z.coerce.number().int().nonnegative().optional(),
  /** 向老：返回 `seq < before`（历史滚动）。 */
  before: z.coerce.number().int().positive().optional(),
  /** ISO 时间下界（含）。 */
  from: z.string().datetime({ offset: true }).optional(),
  /** ISO 时间上界（含）。 */
  to: z.string().datetime({ offset: true }).optional(),
  category: AuditCategorySchema.optional(),
  /** 逗号分隔多值 ⇒ `IN (...)`；见 `AuditSeverityFilterSchema`。 */
  severity: AuditSeverityFilterSchema.optional(),
  /** 沙箱详情时间线按它筛（P21-5 §10.2）。 */
  subjectId: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(AUDIT_LIMIT_MAX).default(AUDIT_LIMIT_DEFAULT),
});
export type AuditQuery = z.infer<typeof AuditQuerySchema>;

/**
 * `since` 与 `before` 同传时的 400 信封（10 §6.6.1「互斥：同时传两个 → 400
 * `VALIDATION_FAILED`」）。
 *
 * 放在 `contracts` 而不是 controller 里，理由与 `validationFailureEnvelope` 同：这是
 * **框架无关**的那一半（04 §1），而且前端要按同一个 `code` 分支处理。NestJS 侧的绑定
 * 只有一行。
 *
 * ⚠️ `sideEffectFree` 在这里就能**由构造断言**：这是一次纯读请求的参数冲突，连库都
 * 没碰。与 `validation.pipe.ts` 用「位置」换取这个标记是同一套道理。
 */
export function auditCursorConflictEnvelope(): ErrorEnvelope {
  return {
    code: VALIDATION_FAILED_CODE,
    message:
      '请求参数 since 与 before 互斥：since 向新翻页（增量刷新）、before 向老翻页（历史滚动），一次只能给一个方向',
    retryable: false,
    sideEffectFree: true,
    details: [
      { path: 'since', code: 'custom', message: '与 before 互斥，不能同时传' },
      { path: 'before', code: 'custom', message: '与 since 互斥，不能同时传' },
    ],
  };
}
