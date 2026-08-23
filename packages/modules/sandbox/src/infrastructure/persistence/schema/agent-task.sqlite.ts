import { sql } from 'drizzle-orm';
import { sqliteTable, text, integer, index, check } from 'drizzle-orm/sqlite-core';
import { sandboxes } from './sandbox.sqlite';

/**
 * `agent_tasks` — one headless agent run inside a sandbox (docs/backend/13 §2.1.4).
 *
 * Same cross-dialect writing discipline as the rest of the sandbox context (13 §1 /
 * 28 §3): enums are `text` + CHECK rather than `pgEnum`, no `.array()`, timestamps are
 * JS `Date` in integer mode.
 *
 * ── What this table is FOR ───────────────────────────────────────────────────────
 * Three columns carry platform promises that nothing else can:
 *
 *   `job_handle` + `cursor` — "a platform restart does not lose a running Task".
 *     After a crash these two are the ONLY things left: the websocket, the half-line
 *     buffer and every parsed event are reconstructible from them, and from nothing
 *     else. This is why they are persisted on every step rather than at the end.
 *   `session_ref` — multi-turn continuation. It is the CLI's own conversation id,
 *     read out of its first output event; the next turn hands it back as `resumeFrom`.
 *
 * ── What this table is deliberately NOT ──────────────────────────────────────────
 * It stores a POINTER and a SUMMARY, never the output. The raw JSONL lives on disk at
 * `log_path`; writing it here as well (and then again into an event log) would be
 * three copies of the same megabytes with three chances to disagree. `artifacts` is a
 * JSON summary of what the agent produced, not the artifacts themselves.
 */
export const agentTasks = sqliteTable(
  'agent_tasks',
  {
    id: text('id').primaryKey(),
    // CASCADE: a Task cannot outlive the sandbox it ran in — its job, its logs and its
    // artifacts all lived inside that instance.
    sandboxId: text('sandbox_id')
      .notNull()
      .references(() => sandboxes.id, { onDelete: 'cascade' }),
    runtime: text('runtime').notNull(),
    /**
     * The provider's opaque `JobHandle`, stored VERBATIM as JSON. The platform never
     * parses it (04 §2.6 裁决 1) — the owning provider is the only reader.
     */
    jobHandle: text('job_handle').notNull(),
    /**
     * The provider's opaque read cursor. NULL until the first read completes. Also
     * never parsed here: a byte offset is one provider's encoding of "where I left
     * off" and exposing it as a number invites arithmetic that breaks on the next one.
     */
    cursor: text('cursor'),
    status: text('status').notNull().default('running'),
    /** Only meaningful in a terminal state, and MAY still be NULL — a signal-killed process has none. */
    exitCode: integer('exit_code'),
    /** The CLI's own conversation id (04 §3 ★4); NULL until its first event arrives. */
    sessionRef: text('session_ref'),
    /**
     * Upper bound of the platform's OWN dense event numbering. ⚠️ NOT a resume point:
     * `TaskClientFrame.subscribe.fromSeq` is EXCLUSIVE, so a subscriber that handed
     * this value back would be told there is nothing new. It is what a subscriber
     * compares its own high-water mark against.
     */
    lastSeq: integer('last_seq').notNull().default(0),
    /**
     * Bytes of `stdout.jsonl` that were DURABLE when `cursor` was recorded.
     *
     * ⚠️ IT IS WHAT MAKES THE LOG AND THE CURSOR ONE ATOMIC UNIT. The pump appends the
     * raw bytes first and persists the cursor second (the reverse would lose bytes on a
     * crash), so a crash between the two leaves a log LONGER than the cursor admits —
     * and the resume, re-reading from the old cursor, would append the same bytes
     * twice. `replay` would then produce more events than were ever pushed live and
     * every later `seq` would be permanently shifted. Recording the length in the SAME
     * row write as the cursor lets the resume truncate the log back to that boundary.
     */
    stdoutBytes: integer('stdout_bytes').notNull().default(0),
    /** Directory holding `stdout.jsonl` / `stderr.jsonl` (03 §8.6 raised to Task scope). */
    logPath: text('log_path').notNull(),
    /** JSON array of `{name,size,modifiedAt}` — a listing, never the bytes. */
    artifacts: text('artifacts').notNull().default('[]'),
    /** ALWAYS a code, never a sentence — the frontend renders the 人话 (P22 §1). */
    errorCode: text('error_code'),
    /** The hard-timeout budget this run was started with (03 §8.3 first line + backstop). */
    timeoutMs: integer('timeout_ms').notNull(),
    startedAt: integer('started_at', { mode: 'timestamp' }).notNull(),
    finishedAt: integer('finished_at', { mode: 'timestamp' }),
    /**
     * When a human asked to stop this run. PERSISTED so a cancel that races a platform
     * restart still lands as `killed`: the process is gone either way, and "someone
     * stopped it" vs "it broke" is the only thing distinguishing the two states.
     */
    cancelRequestedAt: integer('cancel_requested_at', { mode: 'timestamp' }),
  },
  (t) => ({
    sandboxIdx: index('idx_agent_tasks_sandbox').on(t.sandboxId),
    // restart recovery reads exactly this predicate on boot.
    statusIdx: index('idx_agent_tasks_status').on(t.status),
    statusCk: check(
      'agent_tasks_status_ck',
      sql`${t.status} IN ('running','succeeded','failed','killed','timed_out')`,
    ),
    // a finish timestamp may not exist without a terminal status, and vice versa —
    // the pair IS the "has this run landed?" answer, so they must not disagree.
    finishedCk: check(
      'agent_tasks_finished_ck',
      sql`(${t.status} = 'running' AND ${t.finishedAt} IS NULL) OR (${t.status} <> 'running' AND ${t.finishedAt} IS NOT NULL)`,
    ),
    seqCk: check('agent_tasks_seq_ck', sql`${t.lastSeq} >= 0`),
    stdoutBytesCk: check('agent_tasks_stdout_bytes_ck', sql`${t.stdoutBytes} >= 0`),
    timeoutCk: check('agent_tasks_timeout_ck', sql`${t.timeoutMs} > 0`),
  }),
);

export const agentTaskSchema = { agentTasks };
export type AgentTaskRow = typeof agentTasks.$inferSelect;
export type AgentTaskInsert = typeof agentTasks.$inferInsert;
