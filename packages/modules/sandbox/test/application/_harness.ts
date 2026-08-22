import type {
  Clock,
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
  GitAuthContext,
  InjectableRuntimeCredential,
  PreparedWorkspace,
  ProcessSpec,
  ProcessStream,
  ProjectFacade,
  ProviderRegistry,
  RefreshableRuntimeCredential,
  RuntimeAdapter,
  RuntimeAdapterRegistry,
  RuntimeInstallOrchestrator,
  RuntimeInstallPlan,
  RuntimeTaskSpec,
  SandboxCommand,
  SandboxHandle,
  SandboxProvider,
  SandboxProviderCapabilities,
  SandboxProviderContext,
  SandboxRuntimeStatus,
  WorkspacePreparer,
} from '@platform/contracts';
import { SandboxApplicationService } from '../../src/application/sandbox-application.service';
import { ProvisionSandboxWorkflow } from '../../src/application/workflows/provision-sandbox.workflow';
import type { Sandbox } from '../../src/domain/entities/sandbox.entity';
import type { SandboxRepository } from '../../src/domain/repositories/sandbox.repository';

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
};

export class FakeProvider implements SandboxProvider {
  readonly calls: string[] = [];
  lastContext?: SandboxProviderContext;
  /** commands the derived `SandboxExecFn` was asked to run, in order. */
  readonly execCalls: string[][] = [];
  /** exit codes to answer with, keyed by a substring of the joined argv. */
  execExitCodes: Array<{ match: RegExp; exitCode: number; stdout?: string }> = [];

  constructor(
    readonly name: string,
    readonly capabilities: SandboxProviderCapabilities = FULL_CAPS,
    private readonly log: string[] = [],
  ) {}

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
  async findByProject(): Promise<Sandbox[]> {
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
      if (!a) throw new Error(`no adapter ${id}`);
      return a;
    },
    has: (id) => byId.has(id),
    list: () => [...byId.values()],
  };

  const wsCalls: string[] = [];
  const workspace: WorkspacePreparer = {
    async prepare(id: string): Promise<PreparedWorkspace> {
      wsCalls.push(`prepare:${id}`);
      return { hostPath: `/tmp/ws/${id}` };
    },
    async cleanup(id, o): Promise<void> {
      wsCalls.push(`cleanup:${id}:${o.keep}`);
    },
  };

  let projectLookups = 0;
  const projectFacade: ProjectFacade = {
    async getRuntimeContextForTask(projectId) {
      projectLookups += 1;
      return { projectId, baselinePath: `/tmp/baseline/${projectId}`, sourceType: 'empty' };
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
  const events: EventBus = { publishInTx: () => {}, subscribe: () => {} };
  let n = 0;
  const ids: IdGenerator = { next: () => `sbx-${++n}` };
  const clock: Clock = { now: () => opts.now ?? new Date('2026-08-21T00:00:00.000Z') };

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
    runtimes,
    provision,
  );

  return {
    service,
    provision,
    registry,
    runtimes,
    repo,
    provider: providers[0],
    adapter: adapters[0],
    calls,
    txLog,
    wsCalls,
    installInputs,
    bootstrapInputs,
    injections,
    projectLookups: () => projectLookups,
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
