import { z } from 'zod';
import type { ErrorEnvelope } from '../errors';
import { TRIGGERED_BY } from './enums';
import { VALIDATION_FAILED_CODE } from '../validation-envelope';
import { SandboxProviderCapabilitiesSchema } from './sandbox.schema';

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

// ─────────────────────────────────────────────────────────────────────────────
// 系统状态与初始化（shared/10 §6.6 + §7.3 · P21-5 · P21-8 · 13 §2.8.3）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 出网可达性的一条结论（10 §7.3 `ConnectivityResult`）。
 *
 * ⚠️ **`ok:false` 与「离线」不是一回事**，所以 `hint` 是一等字段：企业内网里最常见的
 * 形态是「网络通、但要走代理」，此时该说的是「配置 HTTP_PROXY 后重试」而不是
 * 「当前为离线环境」（P21-8 §1 三档部署画像里的第二档）。把两者说成一句话，用户会去
 * 做一件与他的环境无关的事。
 */
export const ConnectivityResultSchema = z.object({
  /** 探测目标的 host（`api.anthropic.com` / 镜像仓库 host）。**不含 path、不含凭证**。 */
  target: z.string(),
  ok: z.boolean(),
  latencyMs: z.number().int().nonnegative().optional(),
  hint: z.string().optional(),
  /**
   * 这个目标**是不是模型 API**。离线判定只看这一类 —— 镜像仓库不可达是「拉不到新镜像」，
   * 模型 API 不可达才是 P21-8 §1 那条物理约束「Agent 不可用」。两者混作一谈会让一个
   * 只是内网镜像站没配好的部署被告知「Agent 将不可用」。
   */
  modelApi: z.boolean(),
});
export type ConnectivityResult = z.infer<typeof ConnectivityResultSchema>;

/** 代理配置（13 §2.8.3 `proxy_config`）。三项都是可选的，全空 = 不走代理。 */
export const ProxyConfigSchema = z.object({
  httpProxy: z.string().max(2048).optional(),
  httpsProxy: z.string().max(2048).optional(),
  noProxy: z.string().max(2048).optional(),
});
export type ProxyConfig = z.infer<typeof ProxyConfigSchema>;

/**
 * `GET /api/system/init-status` —— 冷启动首屏据此决定进不进向导（10 §6.6）。
 *
 * ⚠️ **它附带上次的出网检测结果，而不是当场重跑一次。** 向导进去后 Step 1 要立刻有东西
 * 可渲染；当场重跑意味着首屏白等最长 5s，而这一屏恰恰是「平台第一次被打开」的那一屏。
 * 需要新鲜结果时用户点 [重新检测]（走 `/diagnose`），那是他显式要的。
 */
export const InitStatusDtoSchema = z.object({
  initialized: z.boolean(),
  /** 完成初始化的时刻；未初始化时缺席。 */
  initializedAt: z.string().optional(),
  /** 上次出网检测的逐条结果（可能来自 `/init`，也可能来自最近一次 `/diagnose`）。 */
  lastConnectivityCheck: z.array(ConnectivityResultSchema).optional(),
  /** 上次出网检测的时刻 —— 没有它，前端无法判断那份结果是三秒前的还是三周前的。 */
  lastConnectivityCheckAt: z.string().optional(),
});
export type InitStatusDto = z.infer<typeof InitStatusDtoSchema>;

/**
 * `POST /api/system/init` 的 body（10 §6.6 / P21-8 §2）。
 *
 * ⚠️ **这是一次性操作，不是幂等的**：已初始化 → **409**（P2-4）。它与
 * `PUT /api/system/settings` 的分工必须写在明处 —— `/init` 是**放行**（写
 * `initialized=true`，此后不再出现向导），`PUT /settings` 只是**存配置**。把代理存进去
 * 顺手放行，会让「运行期改一次代理」变成「悄悄重放了一次初始化」。
 */
export const InitRequestSchema = z.object({
  proxyConfig: ProxyConfigSchema.optional(),
  /**
   * 模型 API 全部不可达时，用户**显式确认**「我知道这是离线环境，Agent 将不可用」。
   *
   * ⚠️ 没有它就直接放行是错的：P21-8 §1 把「完全离线 ⇒ Agent 不可用」列为**物理约束**
   * （codex/claude code 必须能访问各自的模型 API），而向导是唯一一个能在用户投入任何
   * 工作之前把这句话说清楚的地方。不确认就放行 = 让他建完项目、配完凭证、点下 [发起]
   * 才发现平台从一开始就知道这件事 —— 与第 ⑧ 项要修的是同一种「最晚最挫败的时机」。
   */
  acknowledgeOffline: z.boolean().optional(),
});
export type InitRequest = z.infer<typeof InitRequestSchema>;

/**
 * `GET /api/system/settings` —— 运行期读改代理等 + 版本信息（10 §6.6）。
 *
 * ⛔ **永不回显口令 hash**（10 §6.6 / 13 §2.8.3）。这里只出一个布尔「启没启用」与
 * 「最近一次生成」的时刻 —— 页面要渲染的就是这两样，hash 本身对 UI 没有任何用处，
 * 而它一旦出现在响应里，就同时出现在浏览器缓存、devtools、任何一次前端日志上报里。
 */
export const SystemSettingsDtoSchema = z.object({
  initialized: z.boolean(),
  proxyConfig: ProxyConfigSchema.optional(),
  /** 拼 webhook 载荷里的 Task 深链（03 §8.5）；未配置时省略。 */
  publicBaseUrl: z.string().optional(),
  /** 口令**是否启用**（= hash 非空）。⛔ hash 本身永不出现在响应里。 */
  accessPasscodeEnabled: z.boolean(),
  accessPasscodeUpdatedAt: z.string().optional(),
  /** 版本信息（P21-8 §4 的 [检查更新] 区块要显示「当前版本」）。 */
  version: z.object({
    platform: z.string(),
    node: z.string(),
  }),
});
export type SystemSettingsDto = z.infer<typeof SystemSettingsDtoSchema>;

/**
 * `PUT /api/system/settings` 的 body。
 *
 * ⚠️ **只收运行期配置，收不到 `initialized`。** 放行是 `/init` 的事，而且是一次性的；
 * 这里没有那个字段不是遗漏，是这条边界的落点（见 {@link InitRequestSchema}）。
 * 口令同理走 `PUT /api/system/access-passcode`。
 *
 * ⚠️ 字段缺席 = **不改**，显式 `null` = **清空**。少了后者，用户就没有办法把一个配错的
 * 代理删掉 —— 「传空字符串」会变成「代理地址是空串」，那是另一件事。
 */
export const UpdateSystemSettingsRequestSchema = z.object({
  proxyConfig: ProxyConfigSchema.nullable().optional(),
  publicBaseUrl: z.string().max(2048).nullable().optional(),
});
export type UpdateSystemSettingsRequest = z.infer<typeof UpdateSystemSettingsRequestSchema>;

/**
 * 一条水位的三态判定（P21-5 §5 状态矩阵）。CPU/RAM 与磁盘的阈值不同，故各自算好再下发
 * —— 让前端按数字重算一遍阈值，就是把产品规则抄到第二个地方。
 */
export const RESOURCE_LEVELS = ['ok', 'warn', 'critical'] as const;
export const ResourceLevelSchema = z.enum(RESOURCE_LEVELS);
export type ResourceLevel = z.infer<typeof ResourceLevelSchema>;

/**
 * `GET /api/system/resources` —— 系统状态页的资源池看板（P21-5 §3）。
 *
 * ⚠️ **磁盘是本平台真实的瓶颈（P1-9），不是三条水位里凑数的第三条。** 实测量级：
 * 预制镜像约 13GB、boxlite 的 rootfs 缓存 31GB、每个 Task 还有一份工作区副本
 * （P21-8 §2 Step 4）。CPU/RAM 到顶的表现是「新 Task 排队」，磁盘到顶的表现是
 * **clone 写到最后 ENOSPC**、镜像拉一半失败 —— 后者既更常见也更难自我解释。
 */
export const SystemResourcesDtoSchema = z.object({
  cpu: z.object({
    cores: z.number().positive(),
    /** 1 分钟平均负载。Linux/macOS 有，某些容器里恒 0 —— 恒 0 时 `level` 只能是 `ok`。 */
    loadAvg1m: z.number().nonnegative(),
    /** `loadAvg1m / cores`，>1 表示排队。 */
    usedPercent: z.number().nonnegative(),
    level: ResourceLevelSchema,
  }),
  ram: z.object({
    totalBytes: z.number().nonnegative(),
    usedBytes: z.number().nonnegative(),
    usedPercent: z.number().nonnegative(),
    level: ResourceLevelSchema,
  }),
  disk: z.object({
    /** 量的是 `DATA_ROOT` 所在的文件系统 —— 平台真正会写满的那一个。 */
    path: z.string(),
    totalBytes: z.number().nonnegative(),
    /**
     * `total - available`。⚠️ 用 `bavail`（非特权可用）而不是 `bfree` 算 available，
     * 差值是文件系统给 root 留的保留块（ext4 默认 5%）—— 200GiB 的盘上是 10GiB 的虚账
     * （`shared-kernel/fs/free-space.ts`）。
     */
    usedBytes: z.number().nonnegative(),
    availableBytes: z.number().nonnegative(),
    usedPercent: z.number().nonnegative(),
    /** P21-5 §5：<75% ✅ / 75–90% ⚠️ / ≥90% 🔴。 */
    level: ResourceLevelSchema,
    /** 平台调度时扣掉的系统保留比例（P21-8 §7：总容量 × 15%）。 */
    reservedPercent: z.number().nonnegative(),
  }),
  /** 🎁 保留卷占用（P21-5 §3）——「30 天内 Task 成果」。 */
  retainedVolumes: z.object({
    count: z.number().int().nonnegative(),
    totalBytes: z.number().nonnegative(),
    /** 占 `DATA_ROOT` 总容量的比例；≥80% 触发治理横幅（P21-5 §5）。 */
    percentOfDisk: z.number().nonnegative(),
    level: ResourceLevelSchema,
    /** 最早的那一份成果卷的清理时刻（保留时刻 + 30 天）；一份都没有时缺席。 */
    oldestExpiresAt: z.string().optional(),
    /**
     * 统计是否**被截断**（目录过多时停止遍历）。
     * ⚠️ 少报是降级、多报是撒谎：截断了却说 45GB，会让人以为清完就够了。
     */
    truncated: z.boolean(),
  }),
  /** 当前活跃 Task 数（P21-5 §3「✅ 系统就绪 · 当前活跃 Task: 5」）。 */
  activeTasks: z.number().int().nonnegative(),
});
export type SystemResourcesDto = z.infer<typeof SystemResourcesDtoSchema>;

/**
 * `GET /api/system/providers` 里的一行 provider（10 §7.3 `ProviderHealthDto`）。
 *
 * ⚠️ **与 `GET /api/providers` 是两个端点**（10 §6.1 的告示）：那条是 **sandbox 上下文**
 * 的能力发现，只服务「建 Task 选 provider」，字段就三个；这条是**平台运维看板**，范围更宽
 * （provider + runtime + imageSpec + 健康/失败率），读者是在排障的人。
 *
 * ⚠️ **`healthy` 说的是「最近一小时没有失败到告警线」，不是「刚探测过它活着」。**
 * `SandboxProvider` 契约里**没有**健康探测方法（04 §2.2 的六必需 + 两可选里没有它），
 * 凭空调一次 `create/destroy` 去「探活」既有副作用又慢。所以这里用平台**已经拥有**的
 * 事实：`sandboxes` 表里这个 provider 最近一小时的成败。`sampleSize: 0` 是
 * 「**这一小时没人用过它**」，前端应当照实说「无样本」而不是「正常」——
 * 「不知道」不是 `false`，也不是 `true`。
 */
export const ProviderHealthDtoSchema = z.object({
  id: z.string(),
  capabilities: SandboxProviderCapabilitiesSchema,
  isDefault: z.boolean(),
  /** 最近一小时失败率 ≤ 10%（P21-5 §3 的 ❌ 线）。`sampleSize: 0` 时恒 `true`。 */
  healthy: z.boolean(),
  /** 0–1。`sampleSize: 0` 时缺席 —— 0/0 不是 0%。 */
  recentFailureRate: z.number().min(0).max(1).optional(),
  /** 最近一小时该 provider 建过的 sandbox 条数（失败率的分母）。 */
  sampleSize: z.number().int().nonnegative(),
  failureCount: z.number().int().nonnegative(),
});
export type ProviderHealthDto = z.infer<typeof ProviderHealthDtoSchema>;

/** 运维看板视角的一行 runtime（`RuntimeAdapterRegistry` 驱动）。 */
export const RuntimeHealthDtoSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  vendor: z.string(),
  authMethods: z.array(z.string()),
  /** 是否已配置可用凭证 —— 「未启用」三态里的那一态（P21-5 §9）。 */
  credentialConfigured: z.boolean(),
});
export type RuntimeHealthDto = z.infer<typeof RuntimeHealthDtoSchema>;

/** 运维看板视角的一行 imageSpec provider（`ImageSpecRegistry` 驱动，04 §8 第三个扩展点）。 */
export const ImageSpecHealthDtoSchema = z.object({
  id: z.string(),
  isDefault: z.boolean(),
});
export type ImageSpecHealthDto = z.infer<typeof ImageSpecHealthDtoSchema>;

/**
 * `GET /api/system/providers` 的响应（10 §6.6）。
 *
 * ⚠️ **是信封不是扁平数组**，与 `GET /api/providers` 的 `ProviderDto[]` 刻意不同：
 * 那条只回答一个问题（有哪些 provider 可选），这条同时回答三个扩展点各注册了什么。
 * 硬拉成一个数组要么造一个 `kind` 判别键把三种不同的东西挤在一起，要么让调用方去猜
 * 哪几行是 runtime。
 *
 * ⏳ **「最近 testkit 结果」（10 §6.6 提到的第四样）本轮没有产出方**：contract-testkit
 * 跑在 CI 里，运行期平台手上一份结果都没有 —— 编一个字段回 `null` 只会让看板上多一格
 * 永远空着的卡。落地要先有「把 testkit 结论写进库」的那一步（04 §10.1）。
 */
export const SystemProvidersDtoSchema = z.object({
  providers: z.array(ProviderHealthDtoSchema),
  runtimes: z.array(RuntimeHealthDtoSchema),
  imageSpecs: z.array(ImageSpecHealthDtoSchema),
  /** 失败率的统计窗口（ms），让前端能照实说「最近 1h」而不是硬编码一个数字。 */
  healthWindowMs: z.number().int().positive(),
});
export type SystemProvidersDto = z.infer<typeof SystemProvidersDtoSchema>;
