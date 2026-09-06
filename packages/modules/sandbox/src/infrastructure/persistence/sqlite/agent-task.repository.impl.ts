import { Inject, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { DATABASE } from '@platform/shared-kernel';
import type { AgentTaskId, SandboxId, Tx } from '@platform/shared-kernel';
import { AgentTask } from '../../../domain/entities/agent-task.entity';
import type { PersistedJobHandle, TaskArtifact } from '../../../domain/entities/agent-task.entity';
import type { AgentTaskStatus } from '../../../domain/value-objects/agent-task-status.vo';
import type { AgentTaskRepository } from '../../../domain/repositories/agent-task.repository';
import { agentTasks, type AgentTaskRow } from '../schema/agent-task.sqlite';

type Db = BetterSQLite3Database<Record<string, never>>;

/**
 * SQLite (better-sqlite3 + Drizzle) implementation of `AgentTaskRepository`.
 * `saveSync` is synchronous (P0-2) so the whole write lands inside the UnitOfWork's
 * synchronous transaction; snake_case ↔ camelCase and Date mapping happen here
 * (28 §4 boundary rule).
 *
 * The two JSON-encoded columns (`job_handle`, `artifacts`) are decoded DEFENSIVELY:
 * a row whose JSON has been corrupted must not take the whole listing down with it,
 * because the caller most likely to hit it is restart recovery — the exact moment the
 * platform needs to make progress on every OTHER task.
 */
@Injectable()
export class SqliteAgentTaskRepository implements AgentTaskRepository {
  constructor(@Inject(DATABASE) private readonly db: Db) {}

  async findById(id: AgentTaskId): Promise<AgentTask | null> {
    const row = this.db.select().from(agentTasks).where(eq(agentTasks.id, id)).get();
    return row ? this.toDomain(row) : null;
  }

  async findBySandbox(sandboxId: SandboxId): Promise<AgentTask[]> {
    const rows = this.db.select().from(agentTasks).where(eq(agentTasks.sandboxId, sandboxId)).all();
    return rows.map((row) => this.toDomain(row));
  }

  async findRunning(): Promise<AgentTask[]> {
    const rows = this.db.select().from(agentTasks).where(eq(agentTasks.status, 'running')).all();
    return rows.map((row) => this.toDomain(row));
  }

  saveSync(_tx: Tx, task: AgentTask): void {
    // The injected connection is already inside the active UnitOfWork transaction
    // (better-sqlite3 is single-connection + synchronous), so we write on it directly;
    // `_tx` is only the marker gating this call (28 §7.3).
    const db = this.db;
    const mutable = {
      cursor: task.cursor,
      status: task.status,
      exitCode: task.exitCode,
      sessionRef: task.sessionRef,
      lastSeq: task.lastSeq,
      stdoutBytes: task.stdoutBytes,
      artifacts: JSON.stringify(task.artifacts),
      errorCode: task.errorCode,
      finishedAt: task.finishedAt,
    };
    db.insert(agentTasks)
      .values({
        id: task.id as string,
        sandboxId: task.sandboxId as string,
        runtime: task.runtime,
        jobHandle: JSON.stringify(task.jobHandle),
        logPath: task.logPath,
        timeoutMs: task.timeoutMs,
        startedAt: task.startedAt,
        cancelRequestedAt: task.cancelRequestedAt,
        ...mutable,
      })
      // `job_handle`, `log_path`, `timeout_ms` and `started_at` are IMMUTABLE after
      // the start, so they are absent from the update set: a job cannot be re-pointed
      // at a different handle, and a re-point is what "lost the running task" looks
      // like from the inside.
      .onConflictDoUpdate({
        target: agentTasks.id,
        set: {
          ...mutable,
          // ⚠️ WRITE-ONCE-FORWARD, and this is not decoration. TWO writers touch a task:
          // the cancel REQUEST (holding the aggregate it loaded) and the pump (holding
          // its own, older copy, which it saves on every chunk). A plain assignment lets
          // the pump's stale `null` erase a cancel that was recorded microseconds ago,
          // and the run then lands as a generic `failed` instead of `killed`. COALESCE
          // makes the column monotonic in the storage engine, which is also exactly what
          // the domain rule says ("a second cancel keeps the first timestamp").
          // raw SQL binds raw values, so the `timestamp` mode conversion drizzle would
          // normally apply has to be done by hand: this column stores epoch SECONDS.
          cancelRequestedAt: sql`COALESCE(${agentTasks.cancelRequestedAt}, ${epochSeconds(task.cancelRequestedAt)})`,
        },
      })
      .run();
  }

  /**
   * The cancel intent, written as ONE COLUMN under a `status = 'running'` guard.
   *
   * ⚠️ THIS IS WHY `cancel` DOES NOT GO THROUGH `saveSync`. `saveSync` is a full-row
   * upsert, and the aggregate an HTTP request loaded is by definition older than the
   * pump's — persisting it would write `cursor`, `last_seq`, `stdout_bytes`, `status`
   * and `finished_at` BACKWARDS. Measured: a pump at `lastSeq=42 / {"o":900}` cancelled
   * from a copy loaded at `lastSeq=5` reads back as `lastSeq=5 / {"o":100}` (⇒ the next
   * restart re-reads from byte 100 and re-emits every event in between), and a task the
   * pump had already finalised as `succeeded` reverts to `running` with a NULL
   * `finished_at` — a row that claims to be running forever. The CHECK constraint
   * cannot catch either, because both writes are internally consistent.
   *
   * One column carries nothing to write backwards, and the WHERE clause makes reviving
   * a terminal row unrepresentable rather than merely unlikely.
   */
  requestCancelSync(_tx: Tx, taskId: AgentTaskId, at: Date): void {
    this.db
      .update(agentTasks)
      .set({
        // COALESCE keeps the FIRST request's timestamp — the domain rule, enforced in
        // the storage engine so a race between two clicks cannot rewrite it either.
        cancelRequestedAt: sql`COALESCE(${agentTasks.cancelRequestedAt}, ${epochSeconds(at)})`,
      })
      .where(and(eq(agentTasks.id, taskId as string), eq(agentTasks.status, 'running')))
      .run();
  }

  private toDomain(row: AgentTaskRow): AgentTask {
    return AgentTask.rehydrate({
      id: row.id as AgentTaskId,
      sandboxId: row.sandboxId as SandboxId,
      runtime: row.runtime,
      jobHandle: decodeJobHandle(row.jobHandle),
      cursor: row.cursor,
      status: row.status as AgentTaskStatus,
      exitCode: row.exitCode,
      sessionRef: row.sessionRef,
      lastSeq: row.lastSeq,
      stdoutBytes: row.stdoutBytes,
      logPath: row.logPath,
      artifacts: decodeArtifacts(row.artifacts),
      errorCode: row.errorCode,
      timeoutMs: row.timeoutMs,
      startedAt: row.startedAt,
      finishedAt: row.finishedAt,
      cancelRequestedAt: row.cancelRequestedAt,
    });
  }
}

/** `integer(..., { mode: 'timestamp' })` stores epoch SECONDS — see the COALESCE above. */
function epochSeconds(at: Date | null): number | null {
  return at === null ? null : Math.floor(at.getTime() / 1000);
}

function decodeJobHandle(raw: string): PersistedJobHandle {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null) {
      const o = parsed as Record<string, unknown>;
      return {
        provider: typeof o.provider === 'string' ? o.provider : '',
        jobId: typeof o.jobId === 'string' ? o.jobId : '',
      };
    }
  } catch {
    /* fall through */
  }
  // An empty handle is HONEST: the task is unreachable, and the workflow reports that
  // rather than silently pretending it can still be read or killed.
  return { provider: '', jobId: '' };
}

function decodeArtifacts(raw: string): TaskArtifact[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry): TaskArtifact[] => {
      if (typeof entry !== 'object' || entry === null) return [];
      const o = entry as Record<string, unknown>;
      if (typeof o.name !== 'string') return [];
      return [
        {
          name: o.name,
          size: typeof o.size === 'number' ? o.size : 0,
          // ⛔ 回读也照缺席（2026-09-05）：老行里存着 `''` 的，读出来同样是**缺席**
          //    —— 一条历史遗留的空串不该在今天被当成「时间是空字符串」渲染出去。
          ...(typeof o.modifiedAt === 'string' && o.modifiedAt !== ''
            ? { modifiedAt: o.modifiedAt }
            : {}),
        },
      ];
    });
  } catch {
    return [];
  }
}
