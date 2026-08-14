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
    runtime: text('runtime').notNull(),
    provider: text('provider').notNull().default('aio'),
    status: text('status').notNull().default('pending'),
    headless: integer('headless', { mode: 'boolean' }).notNull(),
    timeoutMinutes: integer('timeout_minutes'),
    idleTimeoutSec: integer('idle_timeout_sec').notNull().default(1800),
    quotaCores: real('quota_cores'),
    quotaRamMb: integer('quota_ram_mb'),
    providerHandle: text('provider_handle'),
    workspacePath: text('workspace_path'),
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
