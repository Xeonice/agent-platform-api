import type {
  OpenPtyOptions,
  PreparedWorkspace,
  ProcessSpec,
  ProcessStream,
  ProjectFacade,
  ProjectRuntimeContext,
  ProviderRegistry,
  SandboxHandle,
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
};

/** A ProcessStream that echoes stdin to stdout — lets the terminal e2e assert a round-trip. */
export class EchoProcessStream implements ProcessStream {
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

class FakeProvider implements SandboxProvider {
  readonly capabilities = CAPS;
  constructor(readonly name: string) {}
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

export function makeFakeRegistry(): ProviderRegistry {
  const providers = new Map<string, SandboxProvider>([
    ['aio', new FakeProvider('aio')],
    ['boxlite', new FakeProvider('boxlite')],
  ]);
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

export const fakePtyPort: SandboxPtyPort = {
  async openPty(_sandboxId: string, _opts: OpenPtyOptions): Promise<ProcessStream> {
    return new EchoProcessStream();
  },
};
