import { sql } from 'drizzle-orm';
import { sqliteTable, text, integer, real, index, check } from 'drizzle-orm/sqlite-core';

/**
 * Drizzle SQLite schema for the sandbox context (docs/backend/13 §2.1).
 *
 * Writing discipline for PG cross-dialect portability (13 §1 / 28 §3):
 *   - enums = `text` + CHECK, NOT `pgEnum`
 *   - NO `.array()`
 *   - timestamps are JS `Date` (integer timestamp mode)
 * Each CHECK carries its I-* invariant id from doc 13.
 */
export const sandboxes = sqliteTable(
  'sandboxes',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull(),
    // Task display name (13 §2.1.1). Nullable in the doc because a user MAY clear it;
    // the platform always writes a derived default at create time (P21-1 §9).
    name: text('name'),
    runtime: text('runtime').notNull(),
    /**
     * `image_manifests.id` — the manifest this sandbox runs (13 §2.4.5).
     *
     * ⚠️ THE MEANING OF THIS COLUMN CHANGED WITH THE IMAGE SLICE. It used to hold a
     * REPOSITORY COORDINATE (`alpine:3.20`) passed straight through from the request;
     * it now holds a uuid pointing at a frozen manifest row, and the coordinate +
     * digest are read back through the join. Same column name, same field name, two
     * different things — which is why the migration NULLs every pre-slice row rather
     * than leaving strings that would silently read as ids (04 §7 ⚠️, 13 §2.1).
     *
     * ⚠️ THE FK ITSELF IS DECLARED IN THE MIGRATION SQL, NOT HERE. Same reason as
     * `credential_sandbox_bindings.sandbox_id`: a DB-level cross-context constraint is
     * not worth a PACKAGE dependency from `sandbox` onto `image`.
     *
     * ⚠️ AND IT STAYS NULLABLE. 13 §2.1.1 draws it NOT NULL, and every row written
     * from now on has a value — but a NOT NULL migration would have to invent a
     * manifest, and therefore a DIGEST, for each legacy coordinate. A fabricated
     * digest is `'sha256:unresolved'` wearing a different hat, i.e. precisely the lie
     * this slice exists to delete. NULL here means 「pre-slice row; which bits it ran
     * is not recoverable」 — the second of the two options 13 §2.4 offered.
     */
    imageRef: text('image_ref'),
    provider: text('provider').notNull().default('aio'),
    status: text('status').notNull().default('pending'),
    headless: integer('headless', { mode: 'boolean' }).notNull(),
    timeoutMinutes: integer('timeout_minutes'),
    idleTimeoutSec: integer('idle_timeout_sec').notNull().default(1800),
    quotaCores: real('quota_cores'),
    quotaRamMb: integer('quota_ram_mb'),
    providerHandle: text('provider_handle'),
    workspacePath: text('workspace_path'),
    /**
     * Provider 的私有运行期状态（JSON 文本），原样存、原样还——见
     * `SandboxHandle.providerState`。后端重启后 provider 靠它接回自己的实例。
     *
     * ⚠️ **本列的内容由 provider 定义，平台不解释、不校验、不迁移。** 这里曾经是
     * `agent_endpoint_port` + `agent_auth_token` 两列：一种 provider 的一种数据面
     * 实现（AIO 镜像内的 HTTP agent）的词汇，硬写进了 provider 无关的表。
     *
     * ⚠️ **可能含密**（aio 在里面放 agent bearer token，它无法从运行时反推——容器只
     * 持有公钥那一半，丢了就等于跨重启丢掉数据面）。**永不映射到 DTO、永不进日志**。
     */
    providerState: text('provider_state'),
    // TASK-LAUNCH-DECISIONS T-1: the create input `initialPrompt` lands HERE. It MUST
    // be persisted — its consumer (bootstrapAgentSession) runs in the provision
    // workflow after the 202, and that workflow receives only a `sandboxId` (26 §1).
    // It is never echoed on a DTO (10 §7.3).
    initialPrompt: text('initial_prompt'),
    // One-shot marker set by bootstrapAgentSession. `stopped → starting` re-runs
    // provision (I-SBX-9); without this the same instruction would be REPLAYED onto
    // files the previous agent run already changed.
    initialPromptConsumedAt: integer('initial_prompt_consumed_at', { mode: 'timestamp' }),
    // MACHINE-readable failure cause (one of the 04 §4 codes), stored separately from
    // the prose. Async provisioning means a failure has no HTTP response to ride on
    // (04 §4), so this column IS the post-refresh channel: the WS event carrying the
    // same code is live-only, and a user who reloads must still see why it failed.
    failureCode: text('failure_code'),
    /** Free-text detail behind `failure_code`; P22 §1 owns the user-facing sentence. */
    failureReason: text('failure_reason'),
    version: integer('version').notNull().default(0),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
  },
  (t) => ({
    projectStatusIdx: index('idx_sandboxes_project_status').on(t.projectId, t.status),
    statusIdx: index('idx_sandboxes_status').on(t.status),
    providerHandleIdx: index('idx_sandboxes_provider_handle').on(t.providerHandle),
    // 13 §2.1.1: the FK's lookup index —「使用中的镜像不可硬删」 needs the reverse scan.
    imageRefIdx: index('idx_sandboxes_image_ref').on(t.imageRef),
    // 13 §2.1: 12-value status enum (waiting-input intentionally NOT included)
    statusCk: check(
      'sandboxes_status_ck',
      sql`${t.status} IN ('pending','scheduling','preparing-workspace','creating','starting','running','idle','stopping','stopped','failed','destroying','destroyed')`,
    ),
    // 13 §2.1 / I-SBX-5: headless ⇒ timeout ∈ {30,60,120,240}; interactive ⇒ NULL
    timeoutCk: check(
      'sandboxes_timeout_ck',
      sql`(${t.headless} = 1 AND ${t.timeoutMinutes} IN (30,60,120,240)) OR (${t.headless} = 0 AND ${t.timeoutMinutes} IS NULL)`,
    ),
    idleCk: check('sandboxes_idle_ck', sql`${t.idleTimeoutSec} > 0`),
    // 13 §2.1.1 / I-SBX-10: same ceiling as automations.prompt …
    initialPromptLenCk: check(
      'sandboxes_initial_prompt_len_ck',
      sql`${t.initialPrompt} IS NULL OR length(${t.initialPrompt}) <= 8000`,
    ),
    // … and a consumed marker may not exist without an instruction to have consumed.
    initialPromptConsumedCk: check(
      'sandboxes_initial_prompt_consumed_ck',
      sql`${t.initialPromptConsumedAt} IS NULL OR ${t.initialPrompt} IS NOT NULL`,
    ),
  }),
);

export const sandboxStateTransitions = sqliteTable(
  'sandbox_state_transitions',
  {
    id: text('id').primaryKey(),
    sandboxId: text('sandbox_id').notNull(),
    fromStatus: text('from_status'),
    toStatus: text('to_status').notNull(),
    at: integer('at', { mode: 'timestamp' }).notNull(),
    triggeredBy: text('triggered_by').notNull(),
  },
  (t) => ({
    sandboxIdx: index('idx_transitions_sandbox').on(t.sandboxId),
    toStatusCk: check(
      'transitions_to_status_ck',
      sql`${t.toStatus} IN ('pending','scheduling','preparing-workspace','creating','starting','running','idle','stopping','stopped','failed','destroying','destroyed')`,
    ),
    // 13 §2.1.2: triggered_by 5 values
    triggeredByCk: check(
      'transitions_triggered_by_ck',
      sql`${t.triggeredBy} IN ('scheduler','reaper','user','health-check','provider-event')`,
    ),
  }),
);

export const sandboxSchema = { sandboxes, sandboxStateTransitions };
export type SandboxRow = typeof sandboxes.$inferSelect;
export type SandboxInsert = typeof sandboxes.$inferInsert;
export type SandboxTransitionRow = typeof sandboxStateTransitions.$inferSelect;
