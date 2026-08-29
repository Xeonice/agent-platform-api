import type {
  Clock,
  DomainEvent,
  EventBus,
  IdGenerator,
  SandboxId,
  Tx,
  UnitOfWork,
} from '@platform/shared-kernel';
import type {
  AgentSessionBootstrap,
  BootstrapAgentSessionInput,
  BootstrapAgentSessionResult,
  CredentialFacade,
  EnsureRuntimeInstalledInput,
  FileEntry,
  GitAuthContext,
  InjectableRuntimeCredential,
  JobChunk,
  JobCursor,
  JobHandle,
  JobReadOptions,
  JobSpec,
  PreparedWorkspace,
  ProcessSpec,
  ProcessStream,
  ImageFacade,
  ProjectFacade,
  ProviderRegistry,
  RefreshableRuntimeCredential,
  RuntimeAdapter,
  RuntimeAdapterRegistry,
  RuntimeEvent,
  RuntimeInstallOrchestrator,
  RuntimeInstallPlan,
  RuntimeStartupSpec,
  RuntimeTaskSpec,
  SandboxCommand,
  SandboxFiles,
  SandboxHandle,
  AuditRecorder,
  AuditRecordInput,
  SandboxJobs,
  SandboxProvider,
  SandboxProviderCapabilities,
  SandboxProviderContext,
  SandboxEventBroadcaster,
  SandboxRuntimeStatus,
  SandboxWsEvent,
  TaskEventBroadcaster,
  TaskLogStore,
  TaskServerFrame,
  WorkspacePreparer,
  WorkspaceSource,
} from '@platform/contracts';
import { UnknownRuntimeError } from '@platform/contracts';
import { SandboxApplicationService } from '../../src/application/sandbox-application.service';
import { AgentTaskApplicationService } from '../../src/application/agent-task.service';
import { ProvisionSandboxWorkflow } from '../../src/application/workflows/provision-sandbox.workflow';
import { RunAgentTaskWorkflow } from '../../src/application/workflows/run-agent-task.workflow';
import type { Sandbox } from '../../src/domain/entities/sandbox.entity';
import { AgentTask } from '../../src/domain/entities/agent-task.entity';
import type { AgentTaskProps } from '../../src/domain/entities/agent-task.entity';
import type { SandboxRepository } from '../../src/domain/repositories/sandbox.repository';
import type { AgentTaskRepository } from '../../src/domain/repositories/agent-task.repository';
import { parseClaudeTaskEvents } from '../../../runtime/src/infrastructure/adapters/claude-code/claude-code.output-parser';

/**
 * Shared in-memory doubles for the sandbox application tests (docs/backend/25) — NO
 * docker, no DB. Everything the `starting` 段 touches records into ONE ordered `calls`
 * log, which is what T-SBX-31 (five-step order) actually asserts against.
 */
export const FULL_CAPS: SandboxProviderCapabilities = {
  spawnTty: true,
  volumeMount: true,
  updateResources: true,
  pauseResume: true,
  snapshot: true,
  watchEvents: true,
  // both built-ins advertise it since S6, and CAP-02 pins the bit to the PRESENCE of
  // the two planes in both directions — so the double carries them too (below).
  headlessTask: true,
};

/** One scripted job inside `FakeJobPlane`: a growing byte stream plus a terminal flag. */
export class FakeJob {
  stdout = '';
  stderr = '';
  exited = false;
  exitCode?: number;
  /** Append to the job's stdout, exactly as the real CLI would. */
  emit(text: string): void {
    this.stdout += text;
  }
  emitStderr(text: string): void {
    this.stderr += text;
  }
  finish(code?: number): void {
    this.exited = true;
    this.exitCode = code;
  }
}

/**
 * In-memory job plane that OBEYS the same cursor rules as the real provider — an
 * opaque JSON cursor and whole-line delivery until the job exits. A looser double
 * would let a half-line bug through the application tests and only surface in e2e,
 * which is precisely where it is most expensive to find.
 */
export class FakeJobPlane implements SandboxJobs {
  readonly specs: JobSpec[] = [];
  readonly jobs = new Map<string, FakeJob>();
  readonly released: string[] = [];
  readonly kills: { jobId: string; signal?: string }[] = [];
  /** How many reads actually spent their `waitMs` — a busy loop drives this to 0. */
  longPolls = 0;
  /** Injected transport faults, consumed one per `readJob` call. */
  readonly readFaults: (Error | undefined)[] = [];
  private seq = 0;

  constructor(private readonly providerName: string) {}

  async startJob(_h: SandboxHandle, spec: JobSpec): Promise<JobHandle> {
    this.specs.push(spec);
    const jobId = `fake-job-${++this.seq}`;
    this.jobs.set(jobId, new FakeJob());
    return { provider: this.providerName, jobId };
  }

  async readJob(
    _h: SandboxHandle,
    job: JobHandle,
    cursor?: JobCursor,
    opts?: JobReadOptions,
  ): Promise<JobChunk> {
    const state = this.jobs.get(job.jobId);
    if (!state) throw new Error(`no fake job ${job.jobId}`);
    const fault = this.readFaults.shift();
    if (fault) throw fault;
    const at = cursor ? (JSON.parse(cursor) as { o: number; e: number }) : { o: 0, e: 0 };
    let outAll = Buffer.from(state.stdout, 'utf8').subarray(at.o).toString('utf8');
    // ⚠️ MIRRORS THE REAL PROVIDER: the long poll is taken when there is no DELIVERABLE
    // WHOLE LINE, not merely when there are no bytes. A half line makes the slice
    // non-empty while the delivered chunk is still '' and the cursor still does not
    // move — testing byte-emptiness here would reproduce the production busy loop
    // inside the harness and starve the event loop instead of failing loudly.
    if (!hasWholeLine(outAll) && !state.exited && (opts?.waitMs ?? 0) > 0) {
      this.longPolls += 1;
      await new Promise((r) => setTimeout(r, Math.min(opts?.waitMs ?? 0, 15)));
      outAll = Buffer.from(state.stdout, 'utf8').subarray(at.o).toString('utf8');
    }
    const flush = state.exited;
    const nl = outAll.lastIndexOf('\n');
    const stdout = flush ? outAll : nl < 0 ? '' : outAll.slice(0, nl + 1);
    const stderr = Buffer.from(state.stderr, 'utf8').subarray(at.e).toString('utf8');
    return {
      stdout,
      stderr,
      cursor: JSON.stringify({
        o: at.o + Buffer.byteLength(stdout, 'utf8'),
        e: at.e + Buffer.byteLength(stderr, 'utf8'),
      }),
      status: state.exited ? 'exited' : 'running',
      ...(state.exited && state.exitCode !== undefined ? { exitCode: state.exitCode } : {}),
    };
  }

  async killJob(_h: SandboxHandle, job: JobHandle, signal?: NodeJS.Signals): Promise<void> {
    this.kills.push({ jobId: job.jobId, signal });
    this.jobs.get(job.jobId)?.finish(undefined);
  }

  async releaseJob(_h: SandboxHandle, job: JobHandle): Promise<void> {
    this.released.push(job.jobId);
  }
}

/** The same predicate the real provider uses: is there a whole line to hand over? */
function hasWholeLine(s: string): boolean {
  return s.includes('\n');
}

/** In-memory file plane keyed by absolute in-sandbox path. */
export class FakeFilePlane implements SandboxFiles {
  readonly files = new Map<string, Buffer>();

  async readFile(_h: SandboxHandle, path: string): Promise<Buffer | null> {
    return this.files.get(path) ?? null;
  }
  async openFileStream(_h: SandboxHandle, path: string): Promise<NodeJS.ReadableStream | null> {
    const buf = this.files.get(path);
    if (!buf) return null;
    const { Readable } = await import('node:stream');
    return Readable.from(buf);
  }
  async writeFile(_h: SandboxHandle, path: string, content: string | Buffer): Promise<void> {
    this.files.set(path, Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8'));
  }
  async listFiles(
    _h: SandboxHandle,
    path: string,
    opts?: { recursive?: boolean; maxEntries?: number },
  ): Promise<FileEntry[]> {
    const prefix = path.endsWith('/') ? path : `${path}/`;
    const out: FileEntry[] = [];
    for (const [p, buf] of this.files) {
      if (!p.startsWith(prefix)) continue;
      if (opts?.recursive !== true && p.slice(prefix.length).includes('/')) continue;
      out.push({ path: p, kind: 'file', size: buf.length, modifiedAt: '2026-08-21T00:00:00.000Z' });
    }
    return out.slice(0, opts?.maxEntries ?? out.length);
  }
}

export class FakeProvider implements SandboxProvider {
  readonly calls: string[] = [];
  lastContext?: SandboxProviderContext;
  /** commands the derived `SandboxExecFn` was asked to run, in order. */
  readonly execCalls: string[][] = [];
  /** exit codes to answer with, keyed by a substring of the joined argv. */
  execExitCodes: Array<{ match: RegExp; exitCode: number; stdout?: string }> = [];
  /** Present iff `capabilities.headlessTask` — CAP-02 in both directions. */
  readonly jobs?: FakeJobPlane;
  readonly files?: FakeFilePlane;
  /**
   * The OPTIONAL `imageStaged` — **absent until a test declares it**, which is exactly
   * the state a third-party provider that never heard of the method is in. Declaring it
   * is `declareImageStaged` below.
   */
  imageStaged?: () => Promise<boolean>;

  constructor(
    readonly name: string,
    readonly capabilities: SandboxProviderCapabilities = FULL_CAPS,
    private readonly log: string[] = [],
  ) {
    if (capabilities.headlessTask) {
      this.jobs = new FakeJobPlane(name);
      this.files = new FakeFilePlane();
    }
  }

  /**
   * INSTALL the optional method (answering `answer`, or rejecting when it is an Error).
   *
   * ⚠️ 「没实现」在这个替身里就是**方法不存在**，不是「方法存在但返回 undefined」。
   * 平台侧那条分支写的是 `if (!provider.imageStaged)`；一个恒存在、只是答 undefined 的
   * 方法会**穿过**那个分支，于是「第三方 provider 根本没这个方法」这条路径就一次都没被
   * 走到过 —— 而那恰恰是本仓唯一有真实实现的 provider（boxlite）之外所有 provider 的常态。
   */
  declareImageStaged(answer: boolean | Error): void {
    this.imageStaged = async (): Promise<boolean> => {
      this.calls.push('imageStaged');
      if (answer instanceof Error) throw answer;
      return answer;
    };
  }

  async create(ctx: SandboxProviderContext): Promise<SandboxHandle> {
    this.calls.push('create');
    this.log.push('provider.create');
    this.lastContext = ctx;
    return { provider: this.name, providerSandboxId: `fake-${ctx.sandboxId}` };
  }
  async start(): Promise<void> {
    this.calls.push('start');
    this.log.push('provider.start');
    // both built-ins gate on in-sandbox agent readiness INSIDE start() (03 §4 step ②)
    this.log.push('agent-readiness-probe');
  }
  async stop(): Promise<void> {
    this.calls.push('stop');
  }
  async destroy(): Promise<void> {
    this.calls.push('destroy');
  }
  async inspect(): Promise<SandboxRuntimeStatus> {
    return { lifecycleState: 'instance_running' };
  }
  async spawn(_h: SandboxHandle, spec: ProcessSpec): Promise<ProcessStream> {
    if (spec.tty) throw new Error('tty spawn is not used by these tests');
    this.execCalls.push(spec.cmd);
    const joined = spec.cmd.join(' ');
    const rule = this.execExitCodes.find((r) => r.match.test(joined));
    return fakeExecStream(rule?.stdout ?? '', rule?.exitCode ?? 0);
  }
}

function fakeExecStream(output: string, code: number): ProcessStream {
  return {
    ref: 'fake-exec',
    onData: (cb) => cb(Buffer.from(output, 'utf8')),
    onExit: (cb) => cb(code),
    write: () => {},
    resize: () => {},
    kill: async () => {},
  };
}

export class InMemorySandboxRepo implements SandboxRepository {
  readonly store = new Map<string, Sandbox>();
  async findById(id: SandboxId): Promise<Sandbox | null> {
    return this.store.get(id) ?? null;
  }
  // ⚠️ 这个替身以前**忽略 projectId 直接返回全部**，比真实 sqlite 实现宽松
  // （后者 `where(eq(sandboxes.projectId, ...))`）。于是任何"按项目过滤"的断言在
  // 单测里都是假的——测的是替身的行为，不是产品的。
  async findByProject(projectId: ProjectId): Promise<Sandbox[]> {
    return [...this.store.values()].filter((s) => s.projectId === projectId);
  }
  async findAll(): Promise<Sandbox[]> {
    return [...this.store.values()];
  }
  async countActiveByProject(projectIds: string[]): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const id of projectIds) out[id] = 0;
    for (const s of this.store.values()) {
      if (s.status !== 'destroyed' && out[s.projectId] !== undefined) out[s.projectId] += 1;
    }
    return out;
  }
  saveSync(_tx: Tx, sandbox: Sandbox): void {
    sandbox.markPersisted(sandbox.version);
    this.store.set(sandbox.id, sandbox);
  }
}

/**
 * In-memory `AgentTaskRepository` that stores a SNAPSHOT of the persisted columns and
 * rehydrates a FRESH aggregate on every read.
 *
 * ⚠️ STORING THE INSTANCE IS WHAT MADE THE RESTART TESTS VACUOUS. `findById` then
 * handed back the very object the pump was mutating, so "what survives a restart" was
 * never actually constrained: a field the repository does not persist looked persisted,
 * and `AgentTask.rehydrate` — the only code path a real restart takes — had ZERO
 * coverage. It also made `finalize`'s re-read of the cancel intent dead code, because
 * the "stored" aggregate WAS the pump's aggregate and the flag was always already
 * there.
 *
 * The snapshot below is exactly the column set `SqliteAgentTaskRepository.saveSync`
 * writes, with the same two JSON round-trips, so anything the real table cannot carry
 * cannot survive here either.
 */
export class InMemoryAgentTaskRepo implements AgentTaskRepository {
  readonly rows = new Map<string, AgentTaskProps>();
  /** Reads rehydrate — a caller can never reach the pump's live instance. */
  readonly store = {
    get: (id: string): AgentTask | undefined => {
      const row = this.rows.get(id);
      return row ? AgentTask.rehydrate(cloneProps(row)) : undefined;
    },
    has: (id: string): boolean => this.rows.has(id),
    delete: (id: string): boolean => this.rows.delete(id),
    get size(): number {
      return 0;
    },
  };

  async findById(id: string): Promise<AgentTask | null> {
    return this.store.get(id) ?? null;
  }
  async findBySandbox(sandboxId: string): Promise<AgentTask[]> {
    return [...this.rows.keys()]
      .map((id) => this.store.get(id)!)
      .filter((t) => t.sandboxId === sandboxId);
  }
  async findRunning(): Promise<AgentTask[]> {
    return [...this.rows.keys()].map((id) => this.store.get(id)!).filter((t) => t.isRunning);
  }
  saveSync(_tx: Tx, task: AgentTask): void {
    const previous = this.rows.get(task.id);
    this.rows.set(task.id, {
      id: task.id,
      sandboxId: task.sandboxId,
      runtime: task.runtime,
      // immutable after the start — the real table leaves them out of the UPDATE set.
      jobHandle: previous?.jobHandle ?? { ...task.jobHandle },
      logPath: previous?.logPath ?? task.logPath,
      timeoutMs: previous?.timeoutMs ?? task.timeoutMs,
      startedAt: previous?.startedAt ?? task.startedAt,
      cursor: task.cursor,
      status: task.status,
      exitCode: task.exitCode,
      sessionRef: task.sessionRef,
      lastSeq: task.lastSeq,
      stdoutBytes: task.stdoutBytes,
      artifacts: JSON.parse(JSON.stringify(task.artifacts)) as AgentTaskProps['artifacts'],
      errorCode: task.errorCode,
      finishedAt: task.finishedAt,
      // mirrors the storage-engine COALESCE: write-once-forward.
      cancelRequestedAt: previous?.cancelRequestedAt ?? task.cancelRequestedAt,
    });
  }
  /**
   * The narrow cancel write: ONE column, and only while the row is still running —
   * the same shape (and the same guard) as the SQL `UPDATE ... WHERE status='running'`.
   */
  requestCancelSync(_tx: Tx, taskId: string, at: Date): void {
    const row = this.rows.get(taskId);
    if (!row || row.status !== 'running') return;
    row.cancelRequestedAt = row.cancelRequestedAt ?? at;
  }
}

/** Deep-enough copy so a rehydrated aggregate shares nothing mutable with the row. */
function cloneProps(row: AgentTaskProps): AgentTaskProps {
  return {
    ...row,
    jobHandle: { ...row.jobHandle },
    artifacts: row.artifacts.map((a) => ({ ...a })),
    startedAt: new Date(row.startedAt.getTime()),
    finishedAt: row.finishedAt === null ? null : new Date(row.finishedAt.getTime()),
    cancelRequestedAt:
      row.cancelRequestedAt === null ? null : new Date(row.cancelRequestedAt.getTime()),
  };
}

/** In-memory `TaskLogStore` — the raw JSONL that replay is rebuilt from. */
export class InMemoryTaskLogStore implements TaskLogStore {
  readonly stdout = new Map<string, string>();
  readonly stderr = new Map<string, string>();
  async prepare(taskId: string): Promise<string> {
    return `/tmp/logs/agent-tasks/${taskId}`;
  }
  async appendStdout(taskId: string, chunk: string): Promise<void> {
    this.stdout.set(taskId, (this.stdout.get(taskId) ?? '') + chunk);
  }
  async appendStderr(taskId: string, chunk: string): Promise<void> {
    this.stderr.set(taskId, (this.stderr.get(taskId) ?? '') + chunk);
  }
  /** Roll the raw log back to its durable length — the real store truncates the file. */
  async truncateStdout(taskId: string, bytes: number): Promise<void> {
    const buf = Buffer.from(this.stdout.get(taskId) ?? '', 'utf8');
    if (buf.length <= bytes) return;
    this.stdout.set(taskId, buf.subarray(0, bytes).toString('utf8'));
  }
  async *streamStdoutLines(taskId: string): AsyncIterable<string> {
    if (this.failReads) throw this.failReads;
    for (const line of (this.stdout.get(taskId) ?? '').split('\n')) {
      if (line !== '') yield line;
    }
  }
  /** Injected read fault — the store must NOT turn it into an empty replay. */
  failReads?: Error;
  async flush(): Promise<void> {}
  async release(taskId: string): Promise<void> {
    this.released.push(taskId);
  }
  readonly released: string[] = [];
}

/** Records every frame the `/tasks` channel would have sent. */
export class RecordingTaskBroadcaster implements TaskEventBroadcaster {
  readonly frames: { taskId: string; frame: TaskServerFrame }[] = [];
  publish(taskId: string, frame: TaskServerFrame): void {
    this.frames.push({ taskId, frame });
  }
}

/** A minimal RuntimeAdapter double covering the S5 run half. */
export class FakeAdapter implements RuntimeAdapter {
  readonly displayName: string;
  readonly vendor = 'Fake';
  readonly startCommands: RuntimeTaskSpec[] = [];
  attachCommandCalls = 0;

  constructor(
    readonly id: string,
    displayName?: string,
    private readonly log: string[] = [],
  ) {
    this.displayName = displayName ?? id;
  }

  loginCommand(): string[] {
    return [this.id, 'login'];
  }
  getAuthMethods(): ['api-key'] {
    return ['api-key'];
  }
  async beginAuth(): Promise<never> {
    throw new Error('not used');
  }
  async completeAuth(): Promise<never> {
    throw new Error('not used');
  }
  async injectCredential(): Promise<void> {
    this.log.push('injectCredential');
  }
  /** 落启动文件（可选钩子）。`seedThrows` 用来验"失败不阻断 provision"。 */
  seedThrows = false;
  async seedStartupFiles(spec: RuntimeStartupSpec): Promise<void> {
    this.log.push(`seedStartupFiles:${spec.workdir}`);
    if (this.seedThrows) throw new Error('seed boom');
  }
  getInstallPlan(): RuntimeInstallPlan {
    return {
      strategy: 'install-on-start',
      packageManagerCmds: [`install ${this.id}`],
      requiredBinaries: [this.id],
      envRequirements: [],
    };
  }
  async isInstalled(): Promise<boolean> {
    return true;
  }
  async install(): Promise<void> {}
  buildStartCommand(task: RuntimeTaskSpec): SandboxCommand {
    this.startCommands.push(task);
    this.log.push('buildStartCommand');
    return { cmd: [this.id, task.prompt ?? ''], cwd: task.workdir };
  }
  buildAttachCommand(): SandboxCommand {
    this.attachCommandCalls += 1;
    this.log.push('buildAttachCommand');
    return { cmd: [this.id] };
  }

  /**
   * The REAL claude stream-json parser, on purpose.
   *
   * Stubbing it would make every orchestration assertion below a test of the stub:
   * the platform's `seq` numbering, its `session-started` absorption and its replay
   * equality are all downstream of what a genuine `parseOutput` produces from genuine
   * CLI lines. The parser's own golden coverage lives in the runtime module.
   */
  parseOutput(chunk: Buffer): RuntimeEvent[] {
    return parseClaudeTaskEvents(chunk.toString('utf8'));
  }
}

export interface HarnessOptions {
  providers?: FakeProvider[];
  defaultProvider?: string;
  adapters?: FakeAdapter[];
  /** Make `ensureInstalled` throw (T-SBX-33). */
  installError?: Error;
  /** Make `bootstrapAgentSession` throw (E2E-1-bootstrapNoTmux). */
  bootstrapError?: Error;
  /** What `prepareRuntimeCredential` returns; `null` ⇒ throws NO_CREDENTIAL. */
  credential?: InjectableRuntimeCredential | null;
  /**
   * Make the project facade refuse. It is the LAST check in the create door, so it is
   * also the only seam through which a test can inject a door rejection the door's own
   * code has never seen — which is what `create-door.spec.ts` uses to prove that the
   * 零副作用 flag is earned by POSITION rather than by each throw site remembering it.
   */
  projectError?: Error;
  /**
   * Make `WorkspacePreparer.prepare` throw. The seam exists to prove that an error
   * escaping the preparer is NAMED by the closed set before it becomes a
   * `failureCode` — a raw Node fs error carries `.code = 'ENOSPC'`, and that used to
   * be recorded and broadcast verbatim.
   */
  workspaceError?: Error;
  /**
   * `prepare()` 成功但 baseline 读不到 —— **静默降级成空工作区**那条路
   * （03 §7.8「workspace 空了无人报错」）。
   */
  workspaceBaselineMissing?: boolean;
  /**
   * `prepare()` 成功、baseline **也读到了**，但导入进来的东西是空的（空项目）——
   * 与 `workspaceBaselineMissing` 是**两件事**，走的是 workflow 里另一条 warn 分支。
   *
   * ⚠️ 那条分支曾经是死代码：真实 adapter 把自己写的 `.platform-workspace-state`
   * 也数进 `entryCount`，于是真实文件系统上它恒 ≥ 1（`test/integration/
   * workspace-entry-count.spec.ts` 实测）。计数口径已改，这个 seam 才有意义。
   */
  workspaceEmpty?: boolean;
  /**
   * Make the image facade refuse (I-IMG-2 / I-IMG-3, 04 §7 时刻③). Without this seam
   * a test cannot distinguish 「the door consulted the catalogue」 from 「the door
   * accepted any string」, which is exactly the pre-slice behaviour.
   */
  imageError?: Error;
  now?: Date;
}

export function harness(opts: HarnessOptions = {}) {
  /** ONE ordered log of every externally observable step (T-SBX-31). */
  const calls: string[] = [];
  const txLog: string[] = [];

  const providers = opts.providers ?? [new FakeProvider('aio', FULL_CAPS, calls)];
  for (const p of providers) Object.assign(p, {});
  const byName = new Map(providers.map((p) => [p.name, p]));
  const registry: ProviderRegistry = {
    defaultProvider: opts.defaultProvider ?? providers[0].name,
    register: (p) => {
      byName.set(p.name, p as FakeProvider);
    },
    get: (n) => {
      const p = byName.get(n);
      if (!p) throw new Error(`no provider ${n}`);
      return p;
    },
    has: (n) => byName.has(n),
    list: () => [...byName.values()],
  };

  const adapters = opts.adapters ?? [new FakeAdapter('claude-code', 'Claude Code', calls)];
  const byId = new Map(adapters.map((a) => [a.id, a]));
  const runtimes: RuntimeAdapterRegistry = {
    register: (a) => {
      byId.set(a.id, a as FakeAdapter);
    },
    get: (id) => {
      const a = byId.get(id);
      // the SAME typed error the real `DefaultRuntimeAdapterRegistry` raises — a bare
      // `Error` here would give the double no `code`, and every application-layer test
      // would then be asserting against `INTERNAL` while production says
      // `UNKNOWN_RUNTIME` (25: a double that is looser than the contract hides exactly
      // the behaviour the tests exist to pin).
      if (!a) throw new UnknownRuntimeError(id);
      return a;
    },
    has: (id) => byId.has(id),
    list: () => [...byId.values()],
  };
  /**
   * Drop an adapter from the registry — the ONE thing `RuntimeAdapterRegistry` cannot
   * do on purpose (registration is one-way, 04 §8), and therefore not part of the
   * double's `RuntimeAdapterRegistry` surface.
   *
   * It exists to reproduce a real state the platform can find itself in: a task row
   * survives a restart, but the out-of-tree module that registered its adapter is no
   * longer loaded — so `runtimes.get(task.runtime)` throws on a task that was perfectly
   * valid when it started. That is the ONLY way to reach `UNKNOWN_RUNTIME` on the task
   * plane now that the create door refuses an unregistered runtime up front.
   */
  const forgetRuntime = (id: string): boolean => byId.delete(id);

  const wsCalls: string[] = [];
  /**
   * The `WorkspaceSource` each `prepare` was handed, in order. Separate from `wsCalls`
   * because the branch (03 §7.2★) has to survive THREE hand-offs — door → admitted →
   * provision → preparer — and a string log can only show that prepare was reached.
   */
  const wsSources: WorkspaceSource[] = [];
  const workspace: WorkspacePreparer = {
    async prepare(id: string, source: WorkspaceSource): Promise<PreparedWorkspace> {
      wsCalls.push(`prepare:${id}`);
      wsSources.push(source);
      if (opts.workspaceError) throw opts.workspaceError;
      if (opts.workspaceBaselineMissing) {
        return { hostPath: `/tmp/ws/${id}`, baselineExisted: false, entryCount: 0 };
      }
      if (opts.workspaceEmpty) {
        return { hostPath: `/tmp/ws/${id}`, baselineExisted: true, entryCount: 0 };
      }
      return { hostPath: `/tmp/ws/${id}`, baselineExisted: true, entryCount: 1 };
    },
    async cleanup(id, o): Promise<void> {
      wsCalls.push(`cleanup:${id}:${o.keep}`);
    },
  };

  let projectLookups = 0;
  /** Branch argument of each facade call — `undefined` when the request named none. */
  const branchesAsked: (string | undefined)[] = [];
  const projectFacade: ProjectFacade = {
    async getRuntimeContextForTask(projectId, branch) {
      projectLookups += 1;
      branchesAsked.push(branch);
      if (opts.projectError) throw opts.projectError;
      return {
        projectId,
        baselinePath: `/tmp/baseline/${projectId}`,
        sourceType: 'empty',
        branch,
      };
    },
  };

  const installInputs: EnsureRuntimeInstalledInput[] = [];
  const installs: RuntimeInstallOrchestrator = {
    async ensureInstalled(input) {
      installInputs.push(input);
      calls.push('ensureRuntimeInstalled');
      // the real orchestrator writes `runtime_installations` in its OWN short
      // transaction — modelled here so T-SBX-32 can see the ordering.
      txLog.push('tx:runtime_installations');
      if (opts.installError) throw opts.installError;
    },
  };

  const bootstrapInputs: BootstrapAgentSessionInput[] = [];
  const agentSessions: AgentSessionBootstrap = {
    async bootstrapAgentSession(input): Promise<BootstrapAgentSessionResult> {
      bootstrapInputs.push(input);
      calls.push('bootstrapAgentSession');
      if (opts.bootstrapError) throw opts.bootstrapError;
      const prompt = input.initialPrompt?.trim();
      // mirror the real service: consult the adapter so the tests can assert WHICH
      // command was built (E2E-1-bootstrap / E2E-8-attachOnly / T-SBX-35).
      const adapter = runtimes.get(input.runtimeId);
      if (prompt !== undefined && prompt !== '') {
        adapter.buildStartCommand({ prompt, headless: false, workdir: input.workdir });
        return { promptConsumed: true, reusedExisting: false };
      }
      adapter.buildAttachCommand();
      return { promptConsumed: false, reusedExisting: false };
    },
  };

  const injections: string[] = [];
  const credentials: CredentialFacade = {
    async prepareRuntimeCredential(): Promise<InjectableRuntimeCredential> {
      calls.push('prepareRuntimeCredential');
      if (opts.credential === undefined || opts.credential === null) {
        const { CredentialPreparationError } = await import('@platform/contracts');
        throw new CredentialPreparationError('NO_CREDENTIAL', 'none configured in this harness');
      }
      return opts.credential;
    },
    async prepareForRefresh(): Promise<RefreshableRuntimeCredential> {
      throw new Error('not used');
    },
    async recordRuntimeInjection(runtimeId, sandboxId): Promise<void> {
      calls.push('recordRuntimeInjection');
      injections.push(`${runtimeId}:${sandboxId}`);
    },
    async prepareGitAuth(): Promise<GitAuthContext> {
      throw new Error('not used');
    },
  };

  const repo = new InMemorySandboxRepo();
  const uow: UnitOfWork = {
    run: (fn) => {
      txLog.push('tx:sandbox');
      return fn({} as Tx);
    },
  };
  /**
   * 发出去的领域事件。⚠️ 记下来是为了能断言**「这条路上一个事件都没有」** ——
   * 13 §2.8.2 说审计的第二个写入口不是可选项，理由正是失败/技术路径不发事件；
   * 那句话只有对着一份真实的事件清单才能被机械验证。
   */
  const publishedEvents: DomainEvent[] = [];
  const events: EventBus = {
    publishInTx: (_tx, batch) => void publishedEvents.push(...batch),
    subscribe: () => {},
  };
  let n = 0;
  const ids: IdGenerator = { next: () => `sbx-${++n}` };
  /**
   * ⚠️ A MOVABLE CLOCK, NOT A CONSTANT. With `now` frozen, `overdue()` is identically
   * false and the platform-side hard-timeout backstop is STRUCTURALLY untestable — the
   * one branch that turns a 4-hour run that stopped answering into a landed task.
   */
  let currentNow = opts.now ?? new Date('2026-08-21T00:00:00.000Z');
  const clock: Clock = { now: () => currentNow };
  const advanceClock = (ms: number): void => {
    currentNow = new Date(currentNow.getTime() + ms);
  };

  const taskRepo = new InMemoryAgentTaskRepo();
  const taskLogs = new InMemoryTaskLogStore();
  const taskBroadcaster = new RecordingTaskBroadcaster();

  /**
   * In-memory image catalogue (04 §7 时刻③④).
   *
   * ⚠️ IT DELIBERATELY MAKES `manifestId` DIFFERENT FROM `ref`. Before the image slice
   * the two were the same string, and any double that keeps them equal would let a
   * `sandboxes.image_ref` misread as a coordinate (or vice versa) pass every test —
   * the very confusion 04 §7 ⚠️ warns about. Here the row stores `img-<coordinate>`
   * and the provider receives the coordinate, so a step that mixed them up fails.
   */
  const imageDigests = new Map<string, string>();
  const imageFacade: ImageFacade = {
    async resolveForTask(selector?: string) {
      if (opts.imageError) throw opts.imageError;
      const ref =
        selector === undefined || selector === ''
          ? (process.env.SANDBOX_DEFAULT_IMAGE ?? 'alpine:3.20')
          : selector;
      const digest = imageDigests.get(ref) ?? `sha256:${ref.length.toString(16).padStart(64, 'b')}`;
      imageDigests.set(ref, digest);
      // NOT recorded in `calls`: that log is the 「starting 段 five-step order」
      // assertion (T-SBX-31), and this happens at the DOOR, before any of it.
      return {
        manifestId: `img-${ref}`,
        ref,
        digest,
        entrypoint: undefined,
        manifest: {
          name: ref,
          version: 'latest',
          baseImage: ref,
          entrypointContract: { workdir: '/', entrypoint: ['/bin/sh'] },
          supportedRuntimes: [],
          resourceDefaults: { cores: 1, ramMb: 512, diskMb: 1024 },
          labelsRequired: ['platform.tmux'],
          diffIds: ['sha256:base-layer'],
        },
        resolvedAt: clock.now().toISOString(),
      };
    },
    async findTaskImage(manifestId: string) {
      if (!manifestId.startsWith('img-')) return null;
      const ref = manifestId.slice('img-'.length);
      const digest = imageDigests.get(ref);
      if (digest === undefined) return null;
      return {
        manifestId,
        ref,
        digest,
        entrypoint: undefined,
        manifest: {
          name: ref,
          version: 'latest',
          baseImage: ref,
          entrypointContract: { workdir: '/', entrypoint: ['/bin/sh'] },
          supportedRuntimes: [],
          resourceDefaults: { cores: 1, ramMb: 512, diskMb: 1024 },
          labelsRequired: ['platform.tmux'],
          diffIds: ['sha256:base-layer'],
        },
        resolvedAt: clock.now().toISOString(),
      };
    },
    // 诊断第 ⑧ 项第 4 步的读口。sandbox 上下文一处都不调它（它服务的是
    // `platform/system/diagnostics`），这里存在只是为了让 double 与 port 同形 ——
    // 少一个方法，`ImageFacade` 的类型注解就会当场报红。
    async findRegisteredByRef(ref: string) {
      const digest = imageDigests.get(ref);
      if (digest === undefined) return null;
      return {
        manifestId: `img-${ref}`,
        ref,
        digest,
        validationStatus: 'valid',
        isActive: true,
        isBuiltin: true,
      };
    },
  };

  // 记录式审计 double —— provision 阶段计时/失败那一刻的断言直接读它（03 §7.8）。
  const auditRecords: AuditRecordInput[] = [];
  const audit: AuditRecorder = { record: (r) => void auditRecords.push(r) };
  // `/events` 帧的记录式替身 —— `sandbox.instance_progress` 的断言直接读它（10 §7.4）。
  const wsEvents: SandboxWsEvent[] = [];
  const broadcaster: SandboxEventBroadcaster = { broadcast: (e) => void wsEvents.push(e) };
  const provision = new ProvisionSandboxWorkflow(
    repo,
    uow,
    events,
    clock,
    workspace,
    runtimes,
    installs,
    credentials,
    agentSessions,
    imageFacade,
    audit,
    broadcaster,
  );
  const service = new SandboxApplicationService(
    repo,
    uow,
    events,
    clock,
    ids,
    registry,
    workspace,
    projectFacade,
    imageFacade,
    runtimes,
    provision,
  );
  /**
   * Build a workflow that shares NOTHING but the persisted state — this is how a
   * platform restart is simulated: a brand-new object whose only knowledge of the
   * running jobs is what the repository holds.
   */
  /**
   * ⚠️ THE PREVIOUS WORKFLOW IS RETIRED FIRST, AND THAT IS THE WHOLE SIMULATION.
   *
   * Constructing a second object does not stop the first: its `for(;;)` keeps reading
   * the same job, so a test that only news up a replacement watches the OLD pump finish
   * the work and proves nothing about recovery. Measured on the version without this:
   * gutting `resumeRunning()` to `return 1` left 25 of 26 tests GREEN.
   */
  let live: RunAgentTaskWorkflow | null = null;
  const newTaskWorkflow = (): RunAgentTaskWorkflow => {
    live?.shutdown();
    live = new RunAgentTaskWorkflow(
      taskRepo,
      repo,
      uow,
      events,
      clock,
      ids,
      registry,
      runtimes,
      taskLogs,
      taskBroadcaster,
    );
    return live;
  };
  const taskWorkflow = newTaskWorkflow();
  const taskService = new AgentTaskApplicationService(
    taskRepo,
    repo,
    registry,
    runtimes,
    taskWorkflow,
  );

  return {
    service,
    provision,
    auditRecords,
    wsEvents,
    publishedEvents,
    registry,
    runtimes,
    forgetRuntime,
    repo,
    taskService,
    taskWorkflow,
    newTaskWorkflow,
    advanceClock,
    /** Retire whatever pump is live — used by the suite teardown. */
    stopPumps: (): void => live?.shutdown(),
    taskRepo,
    taskLogs,
    taskBroadcaster,
    provider: providers[0],
    adapter: adapters[0],
    calls,
    txLog,
    wsCalls,
    wsSources,
    branchesAsked,
    installInputs,
    bootstrapInputs,
    injections,
    projectLookups: () => projectLookups,
    imageFacade,
    /** The digest the fake catalogue froze for a coordinate — 时刻④ assertions use it. */
    frozenDigestOf: (ref: string): string | undefined => imageDigests.get(ref),
  };
}

/** Poll the service until the sandbox reaches `status` (async provision, P1-#1). */
export async function waitForStatus(
  service: SandboxApplicationService,
  id: string,
  status: string,
  ms = 2000,
): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const dto = await service.get(id).catch(() => null);
    if (dto?.status === status) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`sandbox ${id} never reached ${status}`);
}
