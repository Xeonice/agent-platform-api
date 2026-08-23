import type {
  FileEntry,
  JobChunk,
  JobCursor,
  JobHandle,
  JobReadOptions,
  JobSpec,
  OpenPtyOptions,
  PreparedWorkspace,
  ProcessSpec,
  ProcessStream,
  ProjectFacade,
  ProjectRuntimeContext,
  ProviderRegistry,
  SandboxFiles,
  SandboxHandle,
  SandboxJobs,
  SandboxProvider,
  SandboxProviderCapabilities,
  SandboxProviderContext,
  SandboxPtyPort,
  SandboxRuntimeStatus,
  WorkspacePreparer,
} from '@platform/contracts';

/**
 * In-memory doubles so the REST/MCP/terminal e2e prove the wiring WITHOUT a live
 * docker daemon (the real docker providers are exercised only in the skipping
 * docker-required e2e).
 */
const CAPS: SandboxProviderCapabilities = {
  spawnTty: true,
  volumeMount: true,
  updateResources: false,
  pauseResume: false,
  snapshot: false,
  watchEvents: false,
  // both built-ins advertise it since S6; the double carries the two planes to match
  // (CAP-02 pins the bit to their PRESENCE in both directions).
  headlessTask: true,
};

/**
 * A scripted headless job: the e2e drives its stdout and its exit by hand, so the REST
 * / WS / MCP legs can be proven without a container and without waiting on a real CLI.
 */
export class ScriptedJob {
  stdout = '';
  stderr = '';
  exited = false;
  exitCode?: number;
  emit(text: string): void {
    this.stdout += text;
  }
  finish(code?: number): void {
    this.exited = true;
    this.exitCode = code;
  }
}

/**
 * In-memory job plane obeying the SAME rules the real provider does — an opaque cursor
 * and WHOLE-LINE delivery until the job exits. A looser double would hide a half-line
 * bug behind green e2e.
 */
export class FakeJobPlane implements SandboxJobs {
  readonly jobs = new Map<string, ScriptedJob>();
  readonly specs: JobSpec[] = [];
  readonly released: string[] = [];
  readonly kills: { jobId: string; signal?: string }[] = [];
  private seq = 0;

  constructor(private readonly providerName: string) {}

  /** The single job started so far — what an e2e reaches for. */
  latest(): ScriptedJob {
    return [...this.jobs.values()][this.jobs.size - 1];
  }

  async startJob(_h: SandboxHandle, spec: JobSpec): Promise<JobHandle> {
    this.specs.push(spec);
    const jobId = `e2e-job-${++this.seq}`;
    this.jobs.set(jobId, new ScriptedJob());
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
    const at = cursor ? (JSON.parse(cursor) as { o: number; e: number }) : { o: 0, e: 0 };
    const read = (): string => Buffer.from(state.stdout, 'utf8').subarray(at.o).toString('utf8');
    let all = read();
    // Same predicate as the real provider: wait when there is no DELIVERABLE WHOLE
    // LINE. Testing byte-emptiness would let a half line skip the wait, which is a
    // busy loop rather than a failure — see AioSandboxAgentClient.readJob.
    if (!all.includes('\n') && !state.exited && (opts?.waitMs ?? 0) > 0) {
      await new Promise((r) => setTimeout(r, Math.min(opts?.waitMs ?? 0, 15)));
      all = read();
    }
    const nl = all.lastIndexOf('\n');
    const stdout = state.exited ? all : nl < 0 ? '' : all.slice(0, nl + 1);
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
      out.push({ path: p, kind: 'file', size: buf.length, modifiedAt: '2026-08-22T00:00:00.000Z' });
    }
    return out.slice(0, opts?.maxEntries ?? out.length);
  }
}

/** A ProcessStream that echoes stdin to stdout — lets the terminal e2e assert a round-trip. */
export class EchoProcessStream implements ProcessStream {
  /**
   * 断开 = detach：替身要照搬真实语义——**不往对面写任何东西**。
   *
   * ⚠️ 这个方法不是形式主义。`ProcessStream.detach()` 是**必选**的，而 `typecheck`
   * 跑的是 `tsc -b`，三个 tsconfig 的 `include` 只覆盖 src ——**测试文件从来
   * 不在类型检查范围内**，vitest 又走 SWC 不做类型检查。于是替身漏实现在两道门禁下
   * 都是隐形的：网关 `handleDisconnect` 无条件调 `detach()`，e2e 里真的抛
   * `TypeError`，被 socket.io 的 disconnect 回调吞掉，测试**照样全绿**。
   */
  detach(): void {
    /* 没有真实传输可关；关键是它存在、且一个字节都不写 */
  }

  readonly ref = 'echo-ref-1';
  private readonly dataCbs: ((c: Buffer) => void)[] = [];
  private readonly exitCbs: ((c: number | null) => void)[] = [];

  onData(cb: (c: Buffer) => void): void {
    this.dataCbs.push(cb);
    setTimeout(() => cb(Buffer.from('/ # ')), 5); // initial prompt banner
  }
  write(data: string | Buffer): void {
    const s = typeof data === 'string' ? data : data.toString('utf8');
    for (const cb of this.dataCbs) cb(Buffer.from(s));
  }
  resize(): void {}
  onExit(cb: (c: number | null) => void): void {
    this.exitCbs.push(cb);
  }
  async kill(): Promise<void> {
    for (const cb of this.exitCbs) cb(0);
  }
}

/**
 * A one-shot exec double: replays output then the exit code, so the platform's
 * `toExecFn` (which resolves on `onExit`) actually settles. Without it every
 * `starting`-段 step that needs an exec — install probe, credential injection, the
 * tmux self-check — would hang forever and the sandbox would sit in `starting`.
 */
export class FakeExecProcessStream implements ProcessStream {
  readonly ref = 'fake-exec-ref';
  /** 一次性 exec：没有可保活的会话，松手即可。 */
  detach(): void {}
  constructor(
    private readonly output: string = '',
    private readonly code: number = 0,
  ) {}
  onData(cb: (c: Buffer) => void): void {
    cb(Buffer.from(this.output, 'utf8'));
  }
  write(): void {}
  resize(): void {}
  onExit(cb: (c: number | null) => void): void {
    cb(this.code);
  }
  async kill(): Promise<void> {}
}

export class FakeProvider implements SandboxProvider {
  readonly capabilities: SandboxProviderCapabilities;
  readonly jobs?: FakeJobPlane;
  readonly files?: FakeFilePlane;
  constructor(
    readonly name: string,
    capabilities: SandboxProviderCapabilities = CAPS,
  ) {
    this.capabilities = capabilities;
    if (capabilities.headlessTask) {
      this.jobs = new FakeJobPlane(name);
      this.files = new FakeFilePlane();
    }
  }
  async create(ctx: SandboxProviderContext): Promise<SandboxHandle> {
    return { provider: this.name, providerSandboxId: `fake-${ctx.sandboxId}` };
  }
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async destroy(): Promise<void> {}
  async inspect(): Promise<SandboxRuntimeStatus> {
    return { lifecycleState: 'instance_running' };
  }
  async spawn(_h: SandboxHandle, spec: ProcessSpec): Promise<ProcessStream> {
    // tty:false is an EXEC (04 §2.3) and must terminate; tty:true is a live terminal.
    return spec.tty ? new EchoProcessStream() : new FakeExecProcessStream('fake 1.0.0', 0);
  }
}

export function makeFakeRegistry(extra: SandboxProvider[] = []): ProviderRegistry {
  const providers = new Map<string, SandboxProvider>([
    ['aio', new FakeProvider('aio')],
    ['boxlite', new FakeProvider('boxlite')],
  ]);
  for (const p of extra) providers.set(p.name, p);
  return {
    defaultProvider: 'aio',
    register: (p) => {
      if (providers.has(p.name)) throw new Error(`duplicate provider ${p.name}`);
      providers.set(p.name, p);
    },
    get: (n) => {
      const p = providers.get(n);
      if (!p) throw new Error(`no provider ${n}`);
      return p;
    },
    has: (n) => providers.has(n),
    list: () => [...providers.values()],
  };
}

export const fakeWorkspace: WorkspacePreparer = {
  async prepare(sandboxId: string): Promise<PreparedWorkspace> {
    return { hostPath: `/tmp/platform-test-ws/${sandboxId}` };
  },
  async cleanup(): Promise<void> {},
};

/** A project facade that always resolves a ready project (no docker/git needed). */
export const fakeProjectFacade: ProjectFacade = {
  async getRuntimeContextForTask(projectId: string): Promise<ProjectRuntimeContext> {
    return {
      projectId,
      baselinePath: `/tmp/platform-test-baseline/${projectId}`,
      sourceType: 'empty',
    };
  },
};

/** A provider WITHOUT the two planes — the 409 admission branch needs one to exist. */
export function makeNoHeadlessProvider(name = 'noheadless'): FakeProvider {
  return new FakeProvider(name, { ...CAPS, headlessTask: false });
}

export const fakePtyPort: SandboxPtyPort = {
  async openPty(_sandboxId: string, _opts: OpenPtyOptions): Promise<ProcessStream> {
    return new EchoProcessStream();
  },
};
