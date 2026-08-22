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
    // The image this sandbox actually runs. NOT an FK: the image context (and its
    // `image_manifests` table) is a later slice (04 §8 IMAGE_SPEC_REGISTRY ⏳), so
    // pointing at a table that does not exist yet would be a fiction.
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
    // provider-specific runtime binding persisted so a backend restart can still
    // reach the instance (13 §2.1). boxlite stores its forwarded agent host port
    // here; aio leaves it NULL (it re-derives from docker inspect).
    agentEndpointPort: integer('agent_endpoint_port'),
    // per-sandbox bearer token for the in-sandbox agent's auth gateway. It CANNOT
    // be re-derived from the runtime (the container only holds the public half), so
    // losing it would mean losing the data plane across a restart. SECRET: never
    // mapped onto a DTO, never logged.
    agentAuthToken: text('agent_auth_token'),
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
