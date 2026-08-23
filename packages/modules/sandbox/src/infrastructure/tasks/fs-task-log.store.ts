import { createReadStream } from 'node:fs';
import { appendFile, mkdir, stat, truncate } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { Injectable } from '@nestjs/common';
import type { TaskLogStore } from '@platform/contracts';

/**
 * Raw output of a headless Task on disk (03 §8.6, raised from the automation-only
 * `automation_runs.log_path` to Task scope).
 *
 *   data/logs/agent-tasks/<taskId>/stdout.jsonl   the CLI's OWN JSONL, byte for byte
 *   data/logs/agent-tasks/<taskId>/stderr.jsonl   the tracing noise, wrapped per chunk
 *
 * ── Why the raw stdout is stored VERBATIM and the parsed events are not stored at all
 * The DB keeps a pointer and a summary; this file keeps the bytes. A third copy —
 * an `events.jsonl` next to it — would be the same megabytes written a third time,
 * with a third chance to disagree with the other two.
 *
 * It costs nothing, because `parseOutput` is PURE and line-independent: replaying
 * these lines through the same adapter yields the identical event sequence, so `seq`
 * numbers derived at replay match the ones assigned live. That equivalence is what
 * makes `fromSeq` resume dense and repeatable, and it is asserted in the tests rather
 * than assumed.
 *
 * ── Why stderr is a DIFFERENT file, not interleaved ──────────────────────────────
 * Merging them is exactly what turns a measured 14/14 clean-JSONL run into "14
 * parseable + 8 garbage lines" (04 §2.6 裁决 3). The separation the job plane
 * maintains all the way from the sandbox would be thrown away at the last step.
 *
 * ── Ordering ────────────────────────────────────────────────────────────────────
 * Appends are serialised per task through a promise chain. `appendFile` on its own
 * gives no ordering guarantee between concurrent calls, and out-of-order stdout lines
 * would renumber the replayed events — i.e. break the one property this file exists
 * to provide.
 */
@Injectable()
export class FsTaskLogStore implements TaskLogStore {
  private readonly chains = new Map<string, Promise<void>>();

  private root(): string {
    return resolve(process.env.DATA_ROOT ?? resolve(process.cwd(), 'data'), 'logs', 'agent-tasks');
  }

  /** The directory persisted as `agent_tasks.log_path` — a pointer, not the content. */
  dirFor(taskId: string): string {
    return resolve(this.root(), taskId);
  }

  stdoutPath(taskId: string): string {
    return resolve(this.dirFor(taskId), 'stdout.jsonl');
  }

  stderrPath(taskId: string): string {
    return resolve(this.dirFor(taskId), 'stderr.jsonl');
  }

  async prepare(taskId: string): Promise<string> {
    const dir = this.dirFor(taskId);
    // 0700 on the whole tree: a Task's output can contain anything the agent read,
    // and the platform user is the only one who has any business reading it back
    // (same reasoning as the workspaces root, 03 §7.6).
    await mkdir(this.root(), { recursive: true, mode: 0o700 });
    await mkdir(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  /** Append the CLI's stdout EXACTLY as it arrived (already newline-terminated). */
  appendStdout(taskId: string, chunk: string): Promise<void> {
    if (chunk === '') return Promise.resolve();
    return this.enqueue(taskId, () => appendFile(this.stdoutPath(taskId), chunk, 'utf8'));
  }

  /**
   * Append a stderr chunk, WRAPPED so the file stays valid JSONL. stderr is arbitrary
   * text (tracing lines, a python traceback, a partial line); wrapping keeps one
   * reader able to consume both files rather than special-casing this one.
   */
  appendStderr(taskId: string, chunk: string): Promise<void> {
    if (chunk === '') return Promise.resolve();
    const line = `${JSON.stringify({ chunk })}\n`;
    return this.enqueue(taskId, () => appendFile(this.stderrPath(taskId), line, 'utf8'));
  }

  /**
   * Roll the stdout log back to its last DURABLE length (`agent_tasks.stdout_bytes`).
   *
   * Called once at the top of every pump, including the very first: on the happy path
   * the file is already exactly this long and `truncate` is a no-op. It matters after
   * a crash between the append and the cursor write, where the file is LONGER than the
   * cursor admits and the bytes are about to be re-read.
   *
   * A shorter file is left alone — this rolls a tail back, it never invents one.
   */
  async truncateStdout(taskId: string, bytes: number): Promise<void> {
    const path = this.stdoutPath(taskId);
    await this.enqueue(taskId, async () => {
      const size = await stat(path)
        .then((st) => st.size)
        .catch(() => -1);
      // -1 ⇒ no log yet (a task that crashed before its first chunk). Nothing to roll
      // back, and creating an empty file here would only hide that fact.
      if (size <= bytes) return;
      await truncate(path, bytes);
    });
  }

  /**
   * Every stdout line recorded so far, in order — the replay source for a `subscribe`
   * carrying `fromSeq`.
   *
   * ⚠️ ONLY "THE LOG DOES NOT EXIST YET" IS SWALLOWED. Subscribing before the first
   * byte arrives is normal; an EIO / EACCES / EISDIR is not, and reporting it as an
   * empty replay would make the gateway answer `caught_up{firstSeq: fromSeq + 1}` —
   * "you are already up to date" — which is the exact lie `firstSeq` was added to
   * make detectable. A catch-all here routes around the platform's own tripwire.
   *
   * It STREAMS rather than reading the file whole: a 54 MB / 200k-line log cost a
   * measured 28 ms and +77 MB of heap to materialise, on every single subscribe.
   */
  async *streamStdoutLines(taskId: string): AsyncIterable<string> {
    const path = this.stdoutPath(taskId);
    const exists = await stat(path).then(
      () => true,
      (e: NodeJS.ErrnoException) => {
        if (e.code === 'ENOENT') return false;
        throw e;
      },
    );
    if (!exists) return;
    const stream = createReadStream(path, { encoding: 'utf8' });
    try {
      // `crlfDelay: Infinity` so a \r\n never splits into a phantom empty line.
      for await (const line of createInterface({ input: stream, crlfDelay: Infinity })) {
        if (line !== '') yield line;
      }
    } finally {
      stream.destroy();
    }
  }

  /** Flush any queued appends — so a caller can assert on the file it just wrote. */
  async flush(taskId: string): Promise<void> {
    await (this.chains.get(taskId) ?? Promise.resolve());
  }

  /**
   * Forget a task's append chain. Called once the run has landed — without it the map
   * grows one entry per task for the lifetime of the process, which on a long-lived
   * server is an unbounded leak keyed by an id that will never be written again.
   */
  async release(taskId: string): Promise<void> {
    await this.flush(taskId);
    this.chains.delete(taskId);
  }

  private enqueue(taskId: string, work: () => Promise<void>): Promise<void> {
    const next = (this.chains.get(taskId) ?? Promise.resolve()).then(work, work);
    // failures are not swallowed for the CALLER (it awaits `next`), but the chain
    // itself must not stay rejected or every later append inherits the rejection.
    this.chains.set(
      taskId,
      next.catch(() => undefined),
    );
    return next;
  }
}
