import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  CLOCK,
  EVENT_BUS,
  ID_GENERATOR,
  UNIT_OF_WORK,
  asAgentTaskId,
} from '@platform/shared-kernel';
import type { Clock, EventBus, IdGenerator, UnitOfWork } from '@platform/shared-kernel';
import {
  RUNTIME_ADAPTER_REGISTRY,
  SANDBOX_PROVIDER_REGISTRY,
  SANDBOX_WORKSPACE_MOUNT,
  SandboxProviderError,
  SandboxProviderErrorCode,
  TASK_EVENT_BROADCASTER,
  TASK_LOG_STORE,
} from '@platform/contracts';
import type {
  JobHandle,
  ProviderRegistry,
  RuntimeAdapter,
  RuntimeAdapterRegistry,
  RuntimeEvent,
  SandboxFiles,
  SandboxHandle,
  SandboxJobs,
  SandboxProvider,
  TaskEventBroadcaster,
  TaskLogStore,
} from '@platform/contracts';
import { AgentTask, type TaskArtifact } from '../../domain/entities/agent-task.entity';
import { verdictFromExitCode } from '../../domain/value-objects/agent-task-status.vo';
import type { AgentTaskStatus } from '../../domain/value-objects/agent-task-status.vo';
import { AGENT_TASK_REPOSITORY } from '../../domain/repositories/agent-task.repository';
import type { AgentTaskRepository } from '../../domain/repositories/agent-task.repository';
import { SANDBOX_REPOSITORY } from '../../domain/repositories/sandbox.repository';
import type { SandboxRepository } from '../../domain/repositories/sandbox.repository';
import type { Sandbox } from '../../domain/entities/sandbox.entity';

/**
 * Where a Task's artifacts are collected from — INSIDE the sandbox, under the
 * workspace the platform already bind-mounts.
 *
 * It is a fixed, agent-visible directory rather than "whatever files changed": the
 * workspace is a git checkout, so a diff-based rule would sweep up build output and
 * `node_modules`. A named drop box is something the prompt can point the agent at, and
 * an empty one is a perfectly normal outcome (`listFiles` answers `[]`).
 */
export const TASK_ARTIFACT_DIR = `${SANDBOX_WORKSPACE_MOUNT}/.agent-artifacts`;

/** Long-poll budget per read. The socket wakes us sooner; this only caps the wait. */
const READ_WAIT_MS = 20_000;
/** Ceiling on how long artifact collection may delay the terminal state. */
const ARTIFACT_LIST_MAX = 500;
/**
 * How many times a RETRYABLE read failure is retried before the run is landed.
 *
 * ⚠️ WITHOUT THIS A SINGLE `ECONNRESET` KILLED A FOUR-HOUR RUN. `readJob` throwing once
 * used to travel straight to `failWith`, which writes a terminal status — and a
 * terminal row is invisible to `findRunning()`, so the restart path could never pick
 * the job up again even though it was still executing happily inside the sandbox.
 * The provider already distinguishes the two cases (`SandboxProviderError.retryable`,
 * set on exactly the transport failures); this is the code that finally reads it.
 */
const READ_RETRY_LIMIT = 5;
/** First backoff step; doubles per attempt up to `READ_RETRY_MAX_MS`. */
const READ_RETRY_BASE_MS = 100;
const READ_RETRY_MAX_MS = 5_000;
/** How many per-task replay indexes are kept before the oldest is dropped. */
const REPLAY_INDEX_MAX_TASKS = 64;

export interface StartAgentTaskInput {
  sandboxId: string;
  runtime: string;
  prompt: string;
  timeoutMinutes: number;
  resumeFrom?: string;
  extraArgs?: string[];
}

/**
 * The whole life of a headless Task (S6), in one place:
 *
 *   buildStartCommand(resumeFrom?) → startJob → PERSIST → stream → parseOutput →
 *   raw JSONL to disk + `seq`-numbered frames out → terminal → collect artifacts →
 *   land the exit code → releaseJob
 *
 * ── The order is load-bearing, not stylistic ────────────────────────────────────
 * `startJob` comes before the row is written and the row is written before ANYTHING
 * is streamed, because the row is the only thing that can find the job again. And
 * `releaseJob` comes dead last, after the exit code and the artifacts are persisted:
 * releasing destroys the sandbox-side output, so releasing early is the one mistake
 * that cannot be retried (04 §2.6).
 *
 * ── Two timeouts, and both are needed ───────────────────────────────────────────
 * `JobSpec.timeoutMs` is enforced INSIDE the sandbox and is the first line — a real
 * kill even if this process is gone. The platform-side deadline below is the backstop
 * for the case the first line cannot cover: an agent that ignores it, or a sandbox
 * whose agent stopped answering. The CLI's own `--timeout`-shaped flags are a third
 * line we do not rely on at all.
 */
@Injectable()
export class RunAgentTaskWorkflow {
  private readonly logger = new Logger('RunAgentTaskWorkflow');
  /** Tasks this process is currently pumping — so a resume never doubles a pump. */
  private readonly pumping = new Set<string>();
  /**
   * Set once this workflow has been retired. Every pump checks it and returns WITHOUT
   * landing the task, which is exactly the shape a platform restart leaves behind: a
   * row still marked `running`, recoverable through `job_handle` + `cursor`.
   *
   * ⚠️ IT IS ALSO WHAT MAKES THE RESTART TESTS HONEST. Constructing a second workflow
   * object does not stop the first one — its `for(;;)` keeps reading the same job — so
   * a test that only news up a replacement is watching the OLD pump finish the work
   * and proving nothing about recovery. Retiring the old object first is the
   * difference between simulating a restart and simulating a second observer.
   */
  private stopped = false;
  /**
   * taskId → cumulative event count after each stdout line. See `replay`: it is what
   * lets a reconnect skip straight to the first line that can still matter instead of
   * re-parsing the whole log.
   */
  private readonly seqIndex = new Map<string, number[]>();

  constructor(
    @Inject(AGENT_TASK_REPOSITORY) private readonly tasks: AgentTaskRepository,
    @Inject(SANDBOX_REPOSITORY) private readonly sandboxes: SandboxRepository,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(EVENT_BUS) private readonly events: EventBus,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
    @Inject(SANDBOX_PROVIDER_REGISTRY) private readonly providers: ProviderRegistry,
    @Inject(RUNTIME_ADAPTER_REGISTRY) private readonly runtimes: RuntimeAdapterRegistry,
    @Inject(TASK_LOG_STORE) private readonly logs: TaskLogStore,
    @Inject(TASK_EVENT_BROADCASTER) private readonly broadcaster: TaskEventBroadcaster,
  ) {}

  /**
   * Accept a Task and return as soon as the job is RUNNING — the caller gets a 202 and
   * an id, never a blocked connection. Everything after this point is the pump.
   */
  async start(sandbox: Sandbox, input: StartAgentTaskInput): Promise<AgentTask> {
    const provider = this.providers.get(sandbox.provider);
    const { jobs } = this.planesOf(provider);
    const adapter = this.runtimes.get(input.runtime);
    const handle = handleOf(sandbox);
    const taskId = asAgentTaskId(this.ids.next());
    const timeoutMs = input.timeoutMinutes * 60_000;

    const command = adapter.buildStartCommand({
      prompt: input.prompt,
      taskId,
      headless: true,
      // the ONLY format the platform can parse into events; `text` would reduce a Task
      // to an opaque blob and delete the whole `/tasks` channel's reason to exist.
      outputFormat: 'json-stream',
      extraArgs: input.extraArgs,
      workdir: SANDBOX_WORKSPACE_MOUNT,
      resumeFrom: input.resumeFrom,
    });

    const logPath = await this.logs.prepare(taskId);
    const job = await jobs.startJob(handle, {
      cmd: command.cmd,
      env: command.env,
      cwd: command.cwd ?? SANDBOX_WORKSPACE_MOUNT,
      timeoutMs,
    });

    const task = AgentTask.start({
      id: taskId,
      sandboxId: sandbox.id,
      runtime: input.runtime,
      jobHandle: { provider: job.provider, jobId: job.jobId },
      logPath,
      timeoutMs,
      resumeFrom: input.resumeFrom,
      now: this.clock.now(),
    });
    // The row and the AgentTaskStarted audit event land in ONE transaction (28 §7.3
    // R-3). This is the platform's first externally-triggered EXECUTION, so "we ran
    // something but there is no record of it" must not be reachable by a crash.
    try {
      this.persist(task);
    } catch (e) {
      // ⚠️ THE JOB IS ALREADY RUNNING AND THE ROW IS THE ONLY THING THAT COULD FIND IT
      // AGAIN. Reachable in practice: the sandbox is deleted between `startJob` and
      // this write, and the FK cascade rejects the insert. Leaving it would burn a
      // sandbox slot on an agent nobody can read, stop or account for — so the job is
      // stopped and released on the way out, and the caller learns the start failed.
      this.logger.error(`task ${taskId} could not be persisted: ${(e as Error).message}`);
      await jobs
        .killJob(handle, { provider: job.provider, jobId: job.jobId }, 'SIGKILL')
        .catch(() => undefined);
      await jobs
        .releaseJob(handle, { provider: job.provider, jobId: job.jobId })
        .catch(() => undefined);
      throw e;
    }

    void this.pumpSafely(task, sandbox);
    return task;
  }

  /**
   * Retire this workflow: every pump returns at its next checkpoint WITHOUT landing
   * its task, leaving exactly the row a crash would have left.
   *
   * It is what a graceful shutdown needs (the alternative is pumps writing into a
   * closing process), and it is what makes a restart TEST a restart rather than two
   * observers of one live pump.
   */
  shutdown(): void {
    this.stopped = true;
  }

  /**
   * Re-attach to every job this process lost — the restart path.
   *
   * It works because `job_handle` and `cursor` were persisted on every step: the
   * handle finds the job again inside a sandbox that never stopped running it, and
   * the cursor says which byte to continue from. Nothing else is needed, and nothing
   * else survived.
   */
  async resumeRunning(): Promise<number> {
    const running = await this.tasks.findRunning();
    let resumed = 0;
    for (const task of running) {
      if (this.pumping.has(task.id)) continue;
      try {
        const sandbox = await this.sandboxes.findById(task.sandboxId);
        if (!sandbox) {
          // the sandbox is gone, so the job is gone with it — land the task rather
          // than leaving a row that claims to be running forever. ⚠️ AND SAY SO ON THE
          // CHANNEL: a subscriber that is already attached has no other way to learn
          // this happened, and would sit on "运行中" until the tab is closed.
          this.landAndAnnounce(task, { status: 'failed', errorCode: 'SANDBOX_GONE' });
          continue;
        }
        void this.pumpSafely(task, sandbox);
        resumed += 1;
      } catch (e) {
        // Same reasoning: a task that cannot even be re-attached is not "still
        // running", and leaving it that way is the orphan row this method exists to
        // prevent. `RESUME_FAILED` names the fact that recovery — not the run — broke.
        this.logger.warn(`could not resume task ${task.id}: ${(e as Error).message}`);
        this.landAndAnnounce(task, { status: 'failed', errorCode: 'RESUME_FAILED' });
      }
    }
    return resumed;
  }

  /**
   * Stop a run on request — the user-facing half of `killJob`.
   *
   * ⚠️ IT DOES NOT RELEASE THE JOB, and that is the whole discipline: releasing
   * destroys the sandbox-side output, and the exit code plus the tail of the output are
   * exactly what a caller wants to see AFTER stopping something (04 §2.6). The intent
   * is PERSISTED FIRST so the eventual exit is recorded as `killed` rather than as a
   * generic failure — including when a platform restart lands between the two.
   *
   * The status does not move here: the job is still running until the signal is
   * delivered and the stream reports an exit. The pump then finalises normally, which
   * is also what collects the artifacts and releases the job — one terminal path, not
   * two racing ones.
   */
  async cancel(task: AgentTask, sandbox: Sandbox): Promise<void> {
    const at = this.clock.now();
    task.requestCancel(at);
    // ⚠️ NOT `persist(task)`. This aggregate was loaded by an HTTP request and is by
    // definition older than the pump's copy; a full-row upsert would write `cursor`,
    // `last_seq`, `stdout_bytes`, `status` and `finished_at` BACKWARDS — measured: the
    // cursor rewinds from {"o":900} to {"o":100} (⇒ every event in between is
    // re-delivered with fresh seq numbers after the next restart) and an already
    // `succeeded` row comes back as `running` with a NULL `finished_at`, i.e. a task
    // stuck running forever. One conditional column cannot do either.
    this.uow.run((tx) => {
      this.tasks.requestCancelSync(tx, task.id, at);
      this.events.publishInTx(tx, task.pullEvents());
    });
    const provider = this.providers.get(sandbox.provider);
    const { jobs } = this.planesOf(provider);
    // SIGTERM → 5s grace → SIGKILL lives INSIDE the provider's killJob (03 §8.3);
    // re-implementing it here would only shorten the grace the agent was given.
    await jobs.killJob(handleOf(sandbox), jobHandleOf(task), 'SIGTERM');
  }

  /** Background runner — never rejects into an unhandled promise. */
  private async pumpSafely(task: AgentTask, sandbox: Sandbox): Promise<void> {
    if (this.pumping.has(task.id)) return;
    this.pumping.add(task.id);
    try {
      await this.pump(task, sandbox);
    } catch (e) {
      // Reached only when the pump could not be SET UP at all (a provider with no
      // job plane, an unreadable job handle). Nothing was acquired, so there is
      // nothing to release — the branches that DID acquire release inside `pump`.
      this.logger.error(`task ${task.id} pump failed: ${(e as Error).message}`);
      this.failWith(task, e);
    } finally {
      this.pumping.delete(task.id);
    }
  }

  private async pump(task: AgentTask, sandbox: Sandbox): Promise<void> {
    const provider = this.providers.get(sandbox.provider);
    const { jobs, files } = this.planesOf(provider);
    const handle = handleOf(sandbox);
    const job = jobHandleOf(task);
    try {
      await this.streamUntilTerminal(task, jobs, files, handle, job);
    } catch (e) {
      // ⚠️ THE FAILURE PATH RELEASES TOO. A read that finally gave up used to land the
      // task and walk away, leaving the sandbox-side session and its attached
      // websocket alive for the life of the sandbox — while the row, now terminal, was
      // invisible to `findRunning()` and could never be cleaned up by anything else.
      this.logger.error(`task ${task.id} pump failed: ${(e as Error).message}`);
      this.failWith(task, e);
      await this.releaseAndForget(task.id, jobs, handle, job);
    }
  }

  /**
   * The read loop. Returns normally on a terminal chunk (having finalised) or when
   * this workflow has been retired; every other exit is a throw the caller lands.
   */
  private async streamUntilTerminal(
    task: AgentTask,
    jobs: SandboxJobs,
    files: SandboxFiles,
    handle: SandboxHandle,
    job: JobHandle,
  ): Promise<void> {
    const adapter = this.runtimes.get(task.runtime);
    let cursor = task.cursor ?? undefined;
    let seq = task.lastSeq;
    let stdoutBytes = task.stdoutBytes;
    let killEscalated = false;
    let platformTimedOut = false;

    // ⓪ roll the raw log back to the length the persisted cursor admits.
    //
    // ⚠️ THIS IS WHAT MAKES THE APPEND IDEMPOTENT. The bytes are written before the
    // cursor is persisted (the reverse would lose them), so a crash in between leaves a
    // log LONGER than the cursor — and this resume, reading from that same cursor, is
    // about to write the identical bytes again. Measured without it: 2 lines before the
    // crash became 4 after recovery, replay produced more events than were ever pushed
    // live, and every subsequent `seq` was permanently shifted. On the happy path the
    // file is already exactly this long and the call is a no-op.
    await this.logs.truncateStdout(task.id, stdoutBytes);
    this.seqIndex.delete(task.id);

    for (;;) {
      if (this.stopped) return;
      const chunk = await this.readWithRetry(task, jobs, handle, job, cursor);
      if (chunk === null) return; // retired mid-backoff
      // ⚠️ CHECK AGAIN AFTER THE READ, NOT ONLY BEFORE IT. A read can be in flight for
      // the whole long-poll budget, and a retired pump that goes on to append, persist
      // and FINALISE the chunk it happens to be holding is still the old process doing
      // the work — which is exactly what let a gutted `resumeRunning()` keep 25 of 26
      // tests green. Dropping the chunk is safe: the cursor has not moved, so the
      // bytes are re-read by whoever picks the job up next.
      if (this.stopped) return;
      cursor = chunk.cursor;

      // ① raw first, parsed second. If the process dies between the two, the bytes are
      // already durable and replay rebuilds the events; the other order would lose them.
      if (chunk.stdout !== '') await this.logs.appendStdout(task.id, chunk.stdout);
      if (chunk.stderr !== '') await this.logs.appendStderr(task.id, chunk.stderr);
      const nextStdoutBytes = stdoutBytes + Buffer.byteLength(chunk.stdout, 'utf8');

      if (chunk.stdout !== '') {
        const parsed = this.parse(adapter, chunk.stdout);
        for (const event of parsed) {
          seq += 1;
          this.absorb(task, event);
          this.broadcaster.publish(task.id, { type: 'event', taskId: task.id, seq, event });
        }
      }

      // ② persist the TRIPLE before looking at the exit, so a crash right here resumes
      // from exactly what was already delivered AND from exactly what is on disk.
      if (chunk.stdout !== '' || chunk.stderr !== '' || task.cursor !== cursor) {
        task.advance(cursor, seq, nextStdoutBytes);
        this.persist(task);
        stdoutBytes = nextStdoutBytes;
      }

      if (chunk.status === 'exited') {
        await this.finalize(task, files, handle, jobs, job, chunk.exitCode, platformTimedOut);
        return;
      }

      // ③ platform-side backstop. The sandbox-side `hard_timeout` is the first line and
      // usually fires first; this covers the case where it cannot (an agent that
      // ignores it, or one that stopped answering). SIGTERM once, then SIGKILL on the
      // next pass — never a tight loop of signals.
      if (this.overdue(task)) {
        this.logger.warn(`task ${task.id} exceeded ${task.timeoutMs}ms — forcing termination`);
        // ⚠️ REMEMBER WHY IT DIED. A signal-killed process has no exit code, so without
        // this flag `verdictFromExitCode(undefined)` lands the run as a generic
        // `failed` — and `timed_out` would then be reachable ONLY through the
        // sandbox-side exit 124, i.e. exactly half of the two sources 03 §8.3 names.
        // The one thing the platform knows here that nothing downstream can infer is
        // that IT decided the deadline had passed.
        platformTimedOut = true;
        await jobs.killJob(handle, job, killEscalated ? 'SIGKILL' : 'SIGTERM');
        killEscalated = true;
      }
    }
  }

  /**
   * One read, retried while the provider says the failure was TRANSPORT and not verdict.
   *
   * ⚠️ THE DISTINCTION IS THE POINT. `SandboxProviderError.retryable` is already set by
   * the provider on exactly the failures that mean "the agent did not answer", and it
   * was being ignored: one `ECONNRESET` landed the task as `failed`, which removed it
   * from `findRunning()` forever — while the agent kept running inside the sandbox,
   * unreachable, unkillable and unaccounted for. A NON-retryable failure (the session
   * is genuinely gone: `NOT_FOUND`) is landed immediately, because retrying it only
   * delays a verdict that will not change.
   *
   * `null` means this workflow was retired mid-backoff — the caller returns without
   * landing anything, exactly as a crash would.
   */
  private async readWithRetry(
    task: AgentTask,
    jobs: SandboxJobs,
    handle: SandboxHandle,
    job: JobHandle,
    cursor: string | undefined,
  ): Promise<Awaited<ReturnType<SandboxJobs['readJob']>> | null> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await jobs.readJob(handle, job, cursor, { waitMs: READ_WAIT_MS });
      } catch (e) {
        if (!isRetryable(e) || attempt >= READ_RETRY_LIMIT) throw e;
        const backoff = Math.min(READ_RETRY_BASE_MS * 2 ** attempt, READ_RETRY_MAX_MS);
        this.logger.warn(
          `task ${task.id} read failed (${(e as Error).message}); ` +
            `retry ${attempt + 1}/${READ_RETRY_LIMIT} in ${backoff}ms`,
        );
        await sleep(backoff);
        if (this.stopped) return null;
      }
    }
  }

  /**
   * Terminal handling, in the ONE order that is safe:
   *   collect artifacts → persist the verdict → THEN release.
   * Releasing first would destroy the very output the artifacts and the exit code are
   * being read from (04 §2.6 `releaseJob`).
   */
  private async finalize(
    task: AgentTask,
    files: SandboxFiles,
    handle: SandboxHandle,
    jobs: SandboxJobs,
    job: JobHandle,
    exitCode: number | undefined,
    platformTimedOut = false,
  ): Promise<void> {
    // ⚠️ RE-READ THE CANCEL INTENT FROM STORAGE. `cancel()` runs on the aggregate the
    // REQUEST loaded, which is a DIFFERENT instance from the one this pump is holding —
    // so the in-memory copy here never sees the flag, and every deliberate stop would
    // land as a generic `failed`. The persisted row is the only thing the two share.
    const persisted = await this.tasks.findById(task.id).catch(() => null);
    if (persisted?.cancelRequested && !task.cancelRequested) {
      task.requestCancel(persisted.cancelRequestedAt ?? this.clock.now());
    }
    const artifacts = await this.collectArtifacts(files, handle).catch((e: unknown) => {
      // artifact collection must never turn a SUCCEEDED run into a failure — the work
      // is done, we merely could not enumerate what it left behind.
      this.logger.warn(`task ${task.id} artifact listing failed: ${(e as Error).message}`);
      return [] as TaskArtifact[];
    });
    // A cancelled run is `killed`, not `failed`: a signal-killed process has no exit
    // code, so without the recorded intent every deliberate stop would be indistinguishable
    // from a crash.
    const status: AgentTaskStatus =
      task.status !== 'running'
        ? task.status
        : task.cancelRequested
          ? 'killed'
          : // the PLATFORM-side backstop is the second documented source of `timed_out`
            // (03 §8.3); the sandbox-side exit 124 is the first. A killed process has no
            // exit code, so this flag is the only carrier of the fact.
            platformTimedOut
            ? 'timed_out'
            : verdictFromExitCode(exitCode);
    this.finishAndPersist(task, {
      status,
      exitCode,
      artifacts,
      errorCode: status === 'succeeded' ? undefined : `TASK_${status.toUpperCase()}`,
    });
    await this.logs.flush(task.id);
    this.broadcaster.publish(task.id, {
      type: 'exit',
      taskId: task.id,
      status,
      ...(exitCode !== undefined ? { exitCode } : {}),
    });
    // everything the platform needs is now durable ⇒ safe to drop the sandbox-side
    // session. Failing here leaks a session, which the sandbox's own teardown reaps.
    await this.releaseAndForget(task.id, jobs, handle, job);
  }

  /**
   * Drop everything this run held OUTSIDE the database: the sandbox-side session (and
   * with it the attached wakeup websocket, which `releaseJob` closes), the per-task
   * append chain and the replay index.
   *
   * ⚠️ IT IS CALLED FROM EVERY TERMINAL PATH, INCLUDING THE FAILURE ONE. A run that
   * ends because a read stopped answering holds exactly the same resources as one that
   * ended cleanly, and it is the LESS likely of the two to be cleaned up later — its
   * row is already terminal, so no reconciler will ever look at it again.
   */
  private async releaseAndForget(
    taskId: string,
    jobs: SandboxJobs,
    handle: SandboxHandle,
    job: JobHandle,
  ): Promise<void> {
    await jobs.releaseJob(handle, job).catch((e: unknown) => {
      this.logger.warn(`task ${taskId} releaseJob failed: ${(e as Error).message}`);
    });
    this.seqIndex.delete(taskId);
    await this.logs.release?.(taskId).catch(() => undefined);
  }

  /**
   * `listFiles` the drop box, then `readFile` is NOT called for the content — only the
   * listing is persisted. Sizes come from the listing itself, so a 2 GB artifact costs
   * nothing to record; the bytes travel only when someone downloads them.
   */
  private async collectArtifacts(
    files: SandboxFiles,
    handle: SandboxHandle,
  ): Promise<TaskArtifact[]> {
    const entries = await files.listFiles(handle, TASK_ARTIFACT_DIR, {
      recursive: true,
      maxEntries: ARTIFACT_LIST_MAX,
    });
    return (
      entries
        .filter((e) => e.kind === 'file')
        .map((e) => ({
          // relative to the drop box — an absolute in-sandbox path is not something to
          // hand an API client (`TaskArtifactSchema.name`).
          name: relativeArtifactName(e.path),
          size: e.size ?? 0,
          modifiedAt: e.modifiedAt,
        }))
        // ⚠️ A NAME IS DROPPED, NOT SANITISED. `relativeArtifactName` only strips the drop
        // box prefix, so a listing that reported `../../etc/passwd` under it would put a
        // traversal string on the DTO. The download endpoint refuses it (`sanitizeArtifactName`),
        // but a name that can never resolve has no business being advertised either —
        // defence in depth means the bad value does not exist at BOTH layers.
        .filter((a) => a.name !== '' && isSafeArtifactName(a.name))
    );
  }

  /**
   * Rebuild the event sequence for a `subscribe` carrying `fromSeq`, from the
   * platform's own raw log.
   *
   * There is no stored event log to read: `parseOutput` is pure and line-independent,
   * so replaying the raw lines through the same adapter reproduces the identical
   * events with the identical dense numbering. That is the property that lets the
   * platform keep ONE copy of the output instead of three.
   */
  async replay(task: AgentTask, fromSeq: number): Promise<{ seq: number; event: RuntimeEvent }[]> {
    const adapter = this.runtimes.get(task.runtime);
    const index = this.indexFor(task.id);
    // Where the first event this subscriber still needs can possibly live. Everything
    // before it is READ (the log is a stream, not a random-access structure) but never
    // PARSED and never materialised — which is where the 157 ms and the 77 MB went.
    const startLine = firstLineAfter(index, fromSeq);
    const out: { seq: number; event: RuntimeEvent }[] = [];
    let seq = startLine > 0 ? index[startLine - 1] : 0;
    let lineNo = 0;
    for await (const line of this.logs.streamStdoutLines(task.id)) {
      const at = lineNo++;
      if (at < startLine) continue;
      for (const event of this.parse(adapter, `${line}\n`)) {
        seq += 1;
        if (seq > fromSeq) out.push({ seq, event });
      }
      // extend the index only where it actually ends, so it stays a prefix of the log.
      if (at === index.length) index.push(seq);
    }
    return out;
  }

  /** The per-task line→seq index, created on demand and bounded in count. */
  private indexFor(taskId: string): number[] {
    const existing = this.seqIndex.get(taskId);
    if (existing) return existing;
    // Map iteration is insertion-ordered, so the first key is the oldest.
    if (this.seqIndex.size >= REPLAY_INDEX_MAX_TASKS) {
      const oldest = this.seqIndex.keys().next().value;
      if (oldest !== undefined) this.seqIndex.delete(oldest);
    }
    const fresh: number[] = [];
    this.seqIndex.set(taskId, fresh);
    return fresh;
  }

  /**
   * Run the adapter's parser and STAMP the timestamps here.
   *
   * `parseOutput` is infrastructure with no `Clock` (01 §3 bans reading the wall clock
   * outside that port) and none of the CLI events carries a time of its own, so the
   * adapters emit an empty `timestamp` and the application — which does hold the
   * Clock — fills it in. An adapter that declines to implement `parseOutput` yields
   * nothing rather than an error: the raw log is still written either way.
   */
  private parse(adapter: RuntimeAdapter, chunk: string): RuntimeEvent[] {
    if (!adapter.parseOutput) return [];
    const at = this.clock.now().toISOString();
    return adapter
      .parseOutput(Buffer.from(chunk, 'utf8'))
      .map((e) => (e.timestamp === '' ? { ...e, timestamp: at } : e));
  }

  /** Pull the facts the aggregate cares about out of the event stream. */
  private absorb(task: AgentTask, event: RuntimeEvent): void {
    if (event.type !== 'session-started') return;
    const ref = (event.data as { ref?: unknown })?.ref;
    if (typeof ref !== 'string') return;
    try {
      task.bindSessionRef(ref);
    } catch (e) {
      // a resume that attached to a DIFFERENT conversation is a real failure, but not
      // one worth throwing the running job away for — record it and let the run finish.
      this.logger.error(`task ${task.id}: ${(e as Error).message}`);
    }
  }

  private overdue(task: AgentTask): boolean {
    return this.clock.now().getTime() - task.startedAt.getTime() > task.timeoutMs;
  }

  private planesOf(provider: SandboxProvider): { jobs: SandboxJobs; files: SandboxFiles } {
    const { jobs, files } = provider;
    if (!jobs || !files) {
      // Unreachable through `create` (the admission branch refuses a headless sandbox
      // on such a provider), so this catches the OTHER route: a provider re-registered
      // without the planes while a task was in flight.
      throw new SandboxProviderError(
        SandboxProviderErrorCode.UNSUPPORTED_CAPABILITY,
        `provider '${provider.name}' has no job/file plane; it cannot run a headless Task`,
      );
    }
    return { jobs, files };
  }

  private failWith(task: AgentTask, error: unknown): void {
    if (!task.isRunning) return;
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { code?: unknown }).code)
        : 'INTERNAL';
    this.landAndAnnounce(task, { status: 'failed', errorCode: code });
  }

  /**
   * Land a run AND tell the channel about it — the two halves that must never be
   * separated.
   *
   * ⚠️ EVERY EARLY RETURN MUST COME THROUGH HERE. A subscriber's only terminal signal
   * is the `exit` frame; a branch that persists a verdict without publishing one
   * leaves every attached client pinned on "运行中" until the tab is closed, and the
   * REST DTO it would have to poll for is exactly the second source of truth the
   * `/tasks` channel exists to avoid.
   */
  private landAndAnnounce(
    task: AgentTask,
    input: { status: AgentTaskStatus; exitCode?: number; errorCode?: string },
  ): void {
    if (!task.isRunning) return;
    this.finishAndPersist(task, input);
    if (input.errorCode !== undefined) {
      this.broadcaster.publish(task.id, { type: 'error', taskId: task.id, code: input.errorCode });
    }
    this.broadcaster.publish(task.id, {
      type: 'exit',
      taskId: task.id,
      status: input.status,
      ...(input.exitCode !== undefined ? { exitCode: input.exitCode } : {}),
    });
  }

  private finishAndPersist(
    task: AgentTask,
    input: {
      status: AgentTaskStatus;
      exitCode?: number;
      artifacts?: TaskArtifact[];
      errorCode?: string;
    },
  ): void {
    task.finish({ ...input, now: this.clock.now() });
    this.persist(task);
  }

  private persist(task: AgentTask): void {
    this.uow.run((tx) => {
      this.tasks.saveSync(tx, task);
      this.events.publishInTx(tx, task.pullEvents());
    });
  }
}

/** Sleep without reading the wall clock (01 §3 bans that outside the Clock port). */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => {
    const t = setTimeout(r, ms);
    t.unref?.();
  });
}

/**
 * Did the provider call this failure TRANSPORT rather than verdict?
 *
 * The flag is already on `SandboxProviderError` and is set exactly where it belongs
 * (an unreachable agent, a refused ws ticket). Reading it here is what separates
 * "the agent did not answer this time" from "the job is genuinely gone".
 */
function isRetryable(e: unknown): boolean {
  return e instanceof SandboxProviderError && e.retryable;
}

/**
 * First line index whose cumulative event count EXCEEDS `fromSeq` — i.e. the first
 * line that can still contain something the subscriber has not seen. `index` is
 * non-decreasing, so a binary search is exact.
 */
function firstLineAfter(index: number[], fromSeq: number): number {
  let lo = 0;
  let hi = index.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (index[mid] > fromSeq) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

export function handleOf(sandbox: Sandbox): SandboxHandle {
  if (!sandbox.providerSandboxId) {
    throw new SandboxProviderError(
      SandboxProviderErrorCode.INVALID_STATE,
      `sandbox ${sandbox.id} has no live instance to run a Task in`,
    );
  }
  return {
    provider: sandbox.provider,
    providerSandboxId: sandbox.providerSandboxId,
    agentEndpointPort: sandbox.agentEndpointPort ?? undefined,
    agentAuthToken: sandbox.agentAuthToken ?? undefined,
  };
}

export function jobHandleOf(task: AgentTask): JobHandle {
  if (task.jobHandle.jobId === '') {
    throw new SandboxProviderError(
      SandboxProviderErrorCode.INVALID_STATE,
      `agent task ${task.id} has no readable job handle`,
    );
  }
  return { provider: task.jobHandle.provider, jobId: task.jobHandle.jobId };
}

/** `/workspace/.agent-artifacts/out/report.md` → `out/report.md`. */
export function relativeArtifactName(absolutePath: string): string {
  const prefix = `${TASK_ARTIFACT_DIR}/`;
  if (absolutePath.startsWith(prefix)) return absolutePath.slice(prefix.length);
  // a listing that reported a path outside the drop box is dropped rather than
  // exposed: the name is what a download endpoint resolves, so it must stay inside.
  return absolutePath.includes('/') ? '' : absolutePath;
}

/**
 * Same segment rule as `sanitizeArtifactName` in the application service, applied at
 * COLLECTION time so a traversal name never reaches the DTO in the first place.
 *
 * Stripping the prefix is not enough on its own: `/workspace/.agent-artifacts/../../etc/passwd`
 * starts with the prefix and comes out as `../../etc/passwd`, a perfectly well-formed
 * relative name that happens to point outside the drop box.
 */
function isSafeArtifactName(name: string): boolean {
  return !name.split('/').some((seg) => seg === '' || seg === '.' || seg === '..');
}
