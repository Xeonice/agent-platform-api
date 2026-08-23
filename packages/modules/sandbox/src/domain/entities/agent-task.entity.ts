import { AggregateRoot } from '@platform/shared-kernel';
import type { AgentTaskId, SandboxId } from '@platform/shared-kernel';
import { AgentTaskFinished, AgentTaskStarted } from '../events/agent-task-events';
import { isTerminalTaskStatus, type AgentTaskStatus } from '../value-objects/agent-task-status.vo';

/**
 * The provider's opaque job handle, as PURE DATA.
 *
 * Structurally identical to the contract's `JobHandle`, and deliberately re-declared
 * here: the domain layer never imports the contracts package (01 §3). What matters is
 * not the type name but the discipline — the platform only STORES and COMPARES these
 * two strings and never parses them, which is what lets the whole handle round-trip
 * through the database.
 */
export interface PersistedJobHandle {
  readonly provider: string;
  readonly jobId: string;
}

/** One file the agent left behind. `name` is RELATIVE to the artifact directory. */
export interface TaskArtifact {
  readonly name: string;
  readonly size: number;
  readonly modifiedAt: string;
}

export interface AgentTaskProps {
  id: AgentTaskId;
  sandboxId: SandboxId;
  runtime: string;
  jobHandle: PersistedJobHandle;
  cursor: string | null;
  status: AgentTaskStatus;
  exitCode: number | null;
  sessionRef: string | null;
  lastSeq: number;
  /**
   * How many bytes of stdout are DURABLY in the log at the moment `cursor` was
   * recorded. See `advance` for why the two must move together.
   */
  stdoutBytes: number;
  logPath: string;
  artifacts: TaskArtifact[];
  errorCode: string | null;
  timeoutMs: number;
  startedAt: Date;
  finishedAt: Date | null;
  /**
   * When a human asked for this run to stop. PERSISTED, not held in memory: a cancel
   * that is followed by a platform restart must still land as `killed` rather than as
   * a generic `failed` — the process is gone either way, and the difference between
   * "someone stopped it" and "it broke" is the whole reason the two states are
   * separate.
   */
  cancelRequestedAt: Date | null;
}

/**
 * AgentTask aggregate root (S6) — ONE headless run of one runtime inside one sandbox.
 *
 * ── Why it is a separate aggregate from `Sandbox` ────────────────────────────────
 * A sandbox is a long-lived workspace; a Task is a single execution inside it, and a
 * sandbox can host several in sequence (each resuming the last, 04 §3 ★4). Folding
 * runs into the sandbox row would make "the current run" the only run there is, which
 * is precisely what makes multi-turn continuation impossible to express.
 *
 * ── The three fields that carry the platform's promises ──────────────────────────
 *   `jobHandle` + `cursor` ARE "a platform restart does not lose a running Task".
 *     Nothing else survives a process death: the websocket, the in-memory line buffer
 *     and the parsed events are all reconstructible from these two and nothing else
 *     is. That is why the cursor is advanced only to a LINE BOUNDARY by the provider —
 *     a cursor that pointed mid-line would resume into an unparseable fragment.
 *   `sessionRef` IS multi-turn continuation. It is the CLI's own conversation id,
 *     learned from the first output event rather than assumed, so the next turn can
 *     hand it back as `resumeFrom` and the CLI confirms the attachment by echoing it.
 *   `lastSeq` IS how far the platform's OWN dense event numbering has got. That is a
 *     different axis from the provider's byte cursor — two cursors, two layers, on
 *     purpose (ws-protocol `/tasks`). ⚠️ It is an UPPER BOUND a subscriber checks
 *     itself against, NOT a resume point: `fromSeq` is exclusive, so handing `lastSeq`
 *     back would replay nothing at all.
 */
export class AgentTask extends AggregateRoot<AgentTaskId> {
  readonly sandboxId: SandboxId;
  readonly runtime: string;
  readonly jobHandle: PersistedJobHandle;
  readonly logPath: string;
  readonly timeoutMs: number;
  readonly startedAt: Date;

  private _cursor: string | null;
  private _status: AgentTaskStatus;
  private _exitCode: number | null;
  private _sessionRef: string | null;
  private _lastSeq: number;
  private _stdoutBytes: number;
  private _artifacts: TaskArtifact[];
  private _errorCode: string | null;
  private _finishedAt: Date | null;
  private _cancelRequestedAt: Date | null;

  private constructor(props: AgentTaskProps) {
    super(props.id);
    this.sandboxId = props.sandboxId;
    this.runtime = props.runtime;
    this.jobHandle = props.jobHandle;
    this.logPath = props.logPath;
    this.timeoutMs = props.timeoutMs;
    this.startedAt = props.startedAt;
    this._cursor = props.cursor;
    this._status = props.status;
    this._exitCode = props.exitCode;
    this._sessionRef = props.sessionRef;
    this._lastSeq = props.lastSeq;
    this._stdoutBytes = props.stdoutBytes;
    this._artifacts = props.artifacts;
    this._errorCode = props.errorCode;
    this._finishedAt = props.finishedAt;
    this._cancelRequestedAt = props.cancelRequestedAt;
  }

  /** Rehydrate from persistence — no events raised (this is not a new start). */
  static rehydrate(props: AgentTaskProps): AgentTask {
    return new AgentTask(props);
  }

  /**
   * A job has been ACCEPTED by the provider and is now running. The handle is
   * required, not optional: a Task row with no way to reach its job would be exactly
   * the orphan the restart path cannot recover.
   */
  static start(input: {
    id: AgentTaskId;
    sandboxId: SandboxId;
    runtime: string;
    jobHandle: PersistedJobHandle;
    logPath: string;
    timeoutMs: number;
    resumeFrom?: string;
    now: Date;
  }): AgentTask {
    const task = new AgentTask({
      id: input.id,
      sandboxId: input.sandboxId,
      runtime: input.runtime,
      jobHandle: input.jobHandle,
      cursor: null,
      status: 'running',
      exitCode: null,
      sessionRef: null,
      lastSeq: 0,
      stdoutBytes: 0,
      logPath: input.logPath,
      artifacts: [],
      errorCode: null,
      timeoutMs: input.timeoutMs,
      startedAt: input.now,
      finishedAt: null,
      cancelRequestedAt: null,
    });
    task.raise(
      new AgentTaskStarted(input.id, input.sandboxId, input.runtime, input.resumeFrom, input.now),
    );
    return task;
  }

  get status(): AgentTaskStatus {
    return this._status;
  }
  get cursor(): string | null {
    return this._cursor;
  }
  get exitCode(): number | null {
    return this._exitCode;
  }
  get sessionRef(): string | null {
    return this._sessionRef;
  }
  get lastSeq(): number {
    return this._lastSeq;
  }
  /** Durable stdout length in bytes — the truncation point a resume rolls back to. */
  get stdoutBytes(): number {
    return this._stdoutBytes;
  }
  get artifacts(): readonly TaskArtifact[] {
    return this._artifacts;
  }
  get errorCode(): string | null {
    return this._errorCode;
  }
  get finishedAt(): Date | null {
    return this._finishedAt;
  }
  get cancelRequestedAt(): Date | null {
    return this._cancelRequestedAt;
  }
  get cancelRequested(): boolean {
    return this._cancelRequestedAt !== null;
  }
  get isRunning(): boolean {
    return !isTerminalTaskStatus(this._status);
  }

  /**
   * Record how far the stream has been consumed. All THREE numbers move together on
   * purpose: persisting a `lastSeq` ahead of its `cursor` would replay events the
   * frontend already has, and a `cursor` ahead of its `lastSeq` would skip them.
   *
   * ⚠️ `stdoutBytes` IS WHAT MAKES THE RAW LOG AND THE CURSOR ONE UNIT. The pump
   * appends the bytes BEFORE it persists the cursor (the other order would lose them
   * outright), so a crash in between leaves a log that is LONGER than the cursor
   * admits — and the resume, reading again from the old cursor, would append the same
   * bytes a second time. `stdout.jsonl` would then hold duplicate lines, replay would
   * produce more events than were ever pushed live, and every subsequent `seq` would
   * be permanently shifted. Recording the durable length in the SAME row write as the
   * cursor is what lets the resume roll the log back to exactly that boundary, which
   * makes the append idempotent instead of merely well-ordered.
   *
   * ⚠️ `lastSeq` NEVER GOES BACKWARDS. A gap in the sequence is a bug the WS contract
   * says not to tolerate, and so is a repeat.
   */
  advance(cursor: string, lastSeq: number, stdoutBytes: number): void {
    if (lastSeq < this._lastSeq) {
      throw new Error(`agent task ${this.id}: lastSeq must not go backwards`);
    }
    if (stdoutBytes < this._stdoutBytes) {
      throw new Error(`agent task ${this.id}: stdoutBytes must not go backwards`);
    }
    this._cursor = cursor;
    this._lastSeq = lastSeq;
    this._stdoutBytes = stdoutBytes;
  }

  /**
   * Bind the CLI's own conversation id, learned from its first output event.
   *
   * Re-binding to a DIFFERENT id is refused: on a resume both CLIs echo back the same
   * id, so a different one means the CLI silently started a fresh conversation instead
   * of continuing — the exact thing the platform verifies rather than assumes
   * (04 §3 ★4). Failing here turns a silent context loss into a visible error.
   */
  bindSessionRef(ref: string): void {
    if (ref === '') return;
    if (this._sessionRef !== null && this._sessionRef !== ref) {
      throw new Error(
        `agent task ${this.id}: runtime reported session '${ref}' but was already bound to ` +
          `'${this._sessionRef}' — the resume did not attach to the expected conversation`,
      );
    }
    this._sessionRef = ref;
  }

  /**
   * Record that a human asked to stop this run.
   *
   * It does NOT move the status: the job is still running until the signal lands and
   * the stream reports an exit, and claiming otherwise would let a caller see `killed`
   * for a process that is still writing files. What it does is decide the VERDICT the
   * eventual exit will be recorded under (see `verdictFor`).
   *
   * Idempotent — a second cancel keeps the first timestamp, so "when was it asked for"
   * stays the truth rather than the last click.
   */
  requestCancel(now: Date): void {
    if (!this.isRunning) {
      throw new Error(`agent task ${this.id} already finished as '${this._status}'`);
    }
    if (this._cancelRequestedAt === null) this._cancelRequestedAt = now;
  }

  /**
   * Terminal state. Idempotent for the SAME verdict (the pump and an explicit kill can
   * race to report the same exit), and refuses to overwrite one terminal state with a
   * different one — the first verdict is the true one.
   */
  finish(input: {
    status: AgentTaskStatus;
    exitCode?: number;
    artifacts?: TaskArtifact[];
    errorCode?: string;
    now: Date;
  }): void {
    if (!this.isRunning) {
      if (this._status === input.status) return;
      throw new Error(
        `agent task ${this.id} already finished as '${this._status}'; refusing '${input.status}'`,
      );
    }
    this._status = input.status;
    this._exitCode = input.exitCode ?? null;
    if (input.artifacts) this._artifacts = input.artifacts;
    this._errorCode = input.errorCode ?? null;
    this._finishedAt = input.now;
    this.raise(
      new AgentTaskFinished(this.id, this.sandboxId, input.status, input.exitCode, input.now),
    );
  }
}
