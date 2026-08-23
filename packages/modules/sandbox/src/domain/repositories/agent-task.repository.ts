import type { AgentTaskId, SandboxId, Tx } from '@platform/shared-kernel';
import type { AgentTask } from '../entities/agent-task.entity';

/**
 * AgentTaskRepository PORT (interface only — implemented in infrastructure, 01 §3).
 * Same shape discipline as `SandboxRepository`: reads are async, the transactional
 * write is SYNCHRONOUS `saveSync(tx, agg): void` so the `void` return forbids an
 * `await` inside the write path at the type level (P0-2 / 28 §7.3).
 */
export interface AgentTaskRepository {
  findById(id: AgentTaskId): Promise<AgentTask | null>;
  findBySandbox(sandboxId: SandboxId): Promise<AgentTask[]>;
  /**
   * Every task still marked running, ACROSS ALL SANDBOXES — the input to restart
   * recovery. It is a repository query rather than a scan in the workflow because
   * "which jobs did this process lose?" is a storage question: after a crash the DB
   * is the only witness that they existed.
   */
  findRunning(): Promise<AgentTask[]>;
  saveSync(tx: Tx, task: AgentTask): void;
  /**
   * Record a cancel INTENT as a one-column, conditional write.
   *
   * ⚠️ IT IS NOT `saveSync` WITH A CANCEL FLAG SET, AND THE DIFFERENCE IS THE WHOLE
   * POINT. Two writers touch a running task: the pump, which advances `cursor` /
   * `last_seq` / `stdout_bytes` many times a second, and the HTTP request, which holds
   * an aggregate it loaded seconds or minutes ago. `saveSync` is a FULL-ROW upsert, so
   * a cancel persisted through it writes that stale copy over the pump's progress —
   * measured: the cursor jumps back from `{"o":900}` to `{"o":100}` (⇒ duplicate events
   * and duplicate `seq` after the next restart), and a task the pump had already
   * finalised as `succeeded` comes back to life as `running` with `finished_at` NULL
   * (⇒ a row stuck running forever, which the gateway's late-subscriber exit branch
   * then never fires for, because `isRunning` is true).
   *
   * Writing ONE column, guarded by `status = 'running'`, cannot do either: it carries
   * no other value to write, and it refuses to touch a row that has already landed.
   * The COALESCE keeps it monotonic, which is also the domain rule ("a second cancel
   * keeps the first timestamp").
   */
  requestCancelSync(tx: Tx, taskId: AgentTaskId, at: Date): void;
}

export const AGENT_TASK_REPOSITORY = Symbol('AgentTaskRepository');
