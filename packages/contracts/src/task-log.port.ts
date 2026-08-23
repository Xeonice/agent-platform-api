/**
 * Where a headless Task's RAW output lands (03 §8.6, raised from the automation-only
 * `automation_runs.log_path` to Task scope).
 *
 * It is a PORT rather than a class the application imports for the usual layering
 * reason (01 §3), but also for a practical one: "raw output goes to a file tree under
 * DATA_ROOT" is a deployment decision, not a domain one, and the day it becomes an
 * object store the application must not notice.
 *
 * ⚠️ THE CONTENT IS WRITTEN ONCE, HERE — NOT THREE TIMES. The database keeps a
 * pointer (`agent_tasks.log_path`) and a summary; this store keeps the bytes; nothing
 * keeps a third copy of the parsed events. That works because `parseOutput` is pure
 * and line-independent, so replaying `streamStdoutLines` through the same adapter
 * reproduces the identical event sequence — which is what makes `fromSeq` replay
 * dense and repeatable without a second log.
 */
export interface TaskLogStore {
  /** Create the task's log directory and return it — the value persisted as `log_path`. */
  prepare(taskId: string): Promise<string>;
  /** Append the CLI's stdout VERBATIM (the job plane hands over whole lines). */
  appendStdout(taskId: string, chunk: string): Promise<void>;
  /** Append a stderr chunk, wrapped so the file stays valid JSONL. */
  appendStderr(taskId: string, chunk: string): Promise<void>;
  /**
   * Roll the stdout log back to `bytes` — the length that was DURABLE when the
   * matching cursor was persisted.
   *
   * ⚠️ IT IS THE OTHER HALF OF `agent_tasks.stdout_bytes`, AND IT IS NOT A CLEANUP.
   * Appending the raw bytes and persisting the cursor are two steps; a crash between
   * them leaves a log longer than the cursor admits, and the resume — reading again
   * from that same cursor — would append the identical bytes a SECOND time. Replay
   * would then produce more events than were ever pushed live and every later `seq`
   * would be permanently shifted. Truncating first makes the append idempotent.
   *
   * A log SHORTER than `bytes` is left alone: this only ever removes a tail that the
   * platform is about to re-read, never invents one.
   */
  truncateStdout(taskId: string, bytes: number): Promise<void>;
  /**
   * Every stdout line recorded so far, in order, as an async stream.
   *
   * ⚠️ A MISSING LOG IS EMPTY; ANY OTHER FAILURE THROWS. Subscribing before the first
   * byte lands is normal. A read that FAILED is not: swallowing it turns a truncated
   * replay into an EMPTY one, and an empty replay is reported to the subscriber as
   * `caught_up{firstSeq: fromSeq + 1}` — i.e. "you are up to date". `firstSeq` exists
   * precisely so a truncated replay is detectable, so letting the error path route
   * around it defeats the one field that was added to catch it.
   *
   * It is a STREAM rather than a `string[]` because the caller may be replaying to one
   * subscriber out of a 54 MB log: materialising every line (measured: +77 MB heap,
   * 28 ms) to deliver one event is a cost paid on every reconnect.
   */
  streamStdoutLines(taskId: string): AsyncIterable<string>;
  /** Wait for queued appends to hit disk. */
  flush(taskId: string): Promise<void>;
  /**
   * Forget whatever per-task bookkeeping the store holds, once the run has landed.
   *
   * Optional because it is a resource-hygiene hook, not part of the durability
   * contract: an implementation that keeps nothing in memory has nothing to release.
   * The filesystem store keeps one append-ordering promise chain PER TASK, which
   * without this grows for the lifetime of the process — one entry per task ever run,
   * keyed by an id that will never be written to again.
   */
  release?(taskId: string): Promise<void>;
}

export const TASK_LOG_STORE = Symbol('TaskLogStore');
