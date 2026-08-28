import { sql } from 'drizzle-orm';
import { sqliteTable, text, integer, index, check } from 'drizzle-orm/sqlite-core';

/**
 * `audit_events` —— 平台级审计流（docs/backend/13 §2.8.2）。**append-only，永不 UPDATE。**
 *
 * ── 为什么这张表落在 `apps/api/src/platform/` 而不是某个 `packages/modules/*` ──────
 * 它不属于任何限界上下文：`category` 横跨 sandbox / project / credential / image /
 * system 五档，`subject_id` 是**跨多种主体的弱引用**。塞进其中任何一个 module 都要么
 * 让那个模块的 schema 声明别人的事，要么逼其余四个模块反向依赖它 —— 而
 * `eslint-plugin-boundaries` 的 `boundaries/elements` 只把
 * `packages/modules/<ctx>/src/…` 与 `packages/{shared-kernel,contracts}/…` 登记为元素，
 * **`apps/api/src/**` 根本不是元素**，因此那里是平台级横切设施的既定落点（`platform/
 * persistence` 的 DB 连接、`platform/events` 的 EventBus、`platform/logging` 的运行
 * 日志都在那儿）。13 §2.8 把 `audit_events` / `system_settings` / `nodes` 并列为
 * 「平台表」，本仓这是第一张，所以这条落点结论在这里写清楚一次。
 *
 * 契约（`AuditRecorder` port + `AuditEventDto`）仍在 `packages/contracts`，各上下文的
 * application 层只依赖那一侧 —— 分层没有被这张表的落点破坏。
 *
 * ── 跨方言书写纪律（13 §1 / 28 §3），与其余 schema 一致 ──────────────────────────
 *   - 枚举 = `text` + CHECK，不用 `pgEnum`
 *   - 不用 `.array()`
 *   - 时间戳是 JS `Date`（integer 模式）
 */
export const auditEvents = sqliteTable(
  'audit_events',
  {
    /**
     * **单调游标**，前端按它翻页（10 §6.6.1 的双向游标）。
     *
     * ⚠️ 不用时间戳翻页 —— 同毫秒多条会漏（13 §2.8.2）。它也是**公开列**而非
     * opaque token：前端要按它比较、判断断层。
     *
     * `{ autoIncrement: true }` ⇒ SQLite 的 `INTEGER PRIMARY KEY AUTOINCREMENT`，
     * 即 `sqlite_sequence` 兜底的**严格单调**语义。⚠️ 这一点是必需的：不加
     * AUTOINCREMENT 时 rowid 会**复用已删除行的号**，而本表有保留裁剪从旧到新删 ——
     * 裁完之后新写入的 seq 可能落回一个前端已经翻过去的位置，`since=<seq>` 会
     * 从此永远看不见它们。
     */
    seq: integer('seq').primaryKey({ autoIncrement: true }),
    /**
     * 发生时刻；保留策略按它算，`from`/`to` 也按它过滤（走 `idx(at)`）。
     *
     * ⚠️ **毫秒精度（`timestamp_ms`），本仓其余表都是秒（`timestamp`）—— 这是刻意的
     * 偏离。** 一次 provision 的六个阶段全部落在同一秒内，秒精度会让面板把它们渲染成
     * 同一个时刻，而这张表存在的理由正是「哪一步慢了」。13 §2.8.2 自己的措辞
     * （「同毫秒多条会翻页错乱」）也是按毫秒说的。
     */
    at: integer('at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(CAST(unixepoch('subsec') * 1000 AS INTEGER))`),
    category: text('category').notNull(),
    /**
     * `sandbox.provision.stage` / `sandbox.probe` / …
     * **独立列**，理由同 `domain_events.event_type`（13 §5：SQLite 的 json 是 TEXT，
     * 不能 `->` 过滤）。
     */
    type: text('type').notNull(),
    severity: text('severity').notNull().default('info'),
    subjectType: text('subject_type'),
    /**
     * **弱引用，不设 FK**（13 §2.8.2）。与 `domain_events.aggregate_id` 同理（宽表跨
     * 多种主体，建不了 FK），但多一条更强的理由：审计必须在**主体被删除之后继续
     * 存在** —— 沙箱销毁、项目删除之后的那段时间正是排障最需要它的时候。设 FK 意味着
     * CASCADE 删掉记录或 RESTRICT 挡住删除，两者都不对。
     */
    subjectId: text('subject_id'),
    /** 谁触发的 —— 排障第一个要问的。**表上无 CHECK**（13 §2.8.2 没画闭集）。 */
    actor: text('actor').notNull(),
    summary: text('summary').notNull(),
    /** 结构化细节，**落库前已脱敏**（13 §2.8.2 / 05 §4）。 */
    detail: text('detail', { mode: 'json' }),
    /** 阶段类事件才有；没有它就无法回答「哪一步慢了」。 */
    durationMs: integer('duration_ms'),
    outcome: text('outcome'),
    /** 失败时挂 04 §4 的码，与 `sandboxes.failure_code` 同一闭集。 */
    errorCode: text('error_code'),
  },
  (t) => ({
    // 13 §2.8.2 的三个索引，一个不多一个不少。
    // ① 沙箱详情时间线 / 任意主体的历史（实测 20 万条下 0.20 ms）
    subjectIdx: index('idx_audit_events_subject').on(t.subjectType, t.subjectId, t.seq),
    // ② 按类别筛的游标翻页（0.44 ms）
    categorySeqIdx: index('idx_audit_events_category_seq').on(t.category, t.seq),
    // ③ 保留裁剪与 from/to 时间过滤
    atIdx: index('idx_audit_events_at').on(t.at),
    // ⚠️ 刻意**不给 `severity` 建索引**：13 §2.8.2 实测无索引筛选 0.45 ms，
    // 一条只为省 0.05 ms 的索引不值得它在每次写入时的维护成本。
    categoryCk: check(
      'audit_events_category_ck',
      sql`${t.category} IN ('sandbox','project','credential','image','system')`,
    ),
    severityCk: check('audit_events_severity_ck', sql`${t.severity} IN ('info','warn','error')`),
    outcomeCk: check(
      'audit_events_outcome_ck',
      sql`${t.outcome} IS NULL OR ${t.outcome} IN ('ok','failed','skipped')`,
    ),
  }),
);

export const auditSchema = { auditEvents };
export type AuditEventRow = typeof auditEvents.$inferSelect;
export type AuditEventInsert = typeof auditEvents.$inferInsert;
