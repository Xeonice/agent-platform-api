import type {
  OpenPtyOptions,
  PreparedWorkspace,
  ProcessSpec,
  ProcessStream,
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
  async spawn(_h: SandboxHandle, _s: ProcessSpec): Promise<ProcessStream> {
    return new EchoProcessStream();
  }
}

export function makeFakeRegistry(): ProviderRegistry {
  const providers = new Map<string, SandboxProvider>([
    ['aio', new FakeProvider('aio')],
    ['boxlite', new FakeProvider('boxlite')],
  ]);
  return {
    defaultProvider: 'aio',
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

export const fakePtyPort: SandboxPtyPort = {
  async openPty(_sandboxId: string, _opts: OpenPtyOptions): Promise<ProcessStream> {
    return new EchoProcessStream();
  },
};
