import { beforeEach, describe, it, expect } from 'vitest';
import type { Clock, EventBus, IdGenerator, Tx, UnitOfWork } from '@platform/shared-kernel';
import type {
  PreparedWorkspace,
  ProcessSpec,
  ProcessStream,
  ProviderRegistry,
  SandboxHandle,
  SandboxProvider,
  SandboxProviderCapabilities,
  SandboxProviderContext,
  SandboxRuntimeStatus,
  WorkspacePreparer,
} from '@platform/contracts';
import { SandboxApplicationService } from '../../src/application/sandbox-application.service';
import type { SandboxId } from '@platform/shared-kernel';
import type { Sandbox } from '../../src/domain/entities/sandbox.entity';
import type { SandboxRepository } from '../../src/domain/repositories/sandbox.repository';

/**
 * Application-layer test with IN-MEMORY provider doubles (docs/backend/25) — NO
 * docker. Proves the full provision pipeline drives the state machine
 * pending → scheduling → preparing-workspace → creating → starting → running,
 * records the provider handle, and that destroy walks to `destroyed`.
 */
const CAPS: SandboxProviderCapabilities = {
  spawnTty: true,
  volumeMount: true,
  updateResources: false,
  pauseResume: false,
  snapshot: false,
  watchEvents: false,
};

class FakeProvider implements SandboxProvider {
  readonly capabilities = CAPS;
  readonly calls: string[] = [];
  constructor(readonly name: string) {}
  async create(ctx: SandboxProviderContext): Promise<SandboxHandle> {
    this.calls.push('create');
    return { provider: this.name, providerSandboxId: `fake-${ctx.sandboxId}` };
  }
  async start(): Promise<void> {
    this.calls.push('start');
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
  async spawn(_h: SandboxHandle, _s: ProcessSpec): Promise<ProcessStream> {
    throw new Error('not used');
  }
}

class InMemorySandboxRepo implements SandboxRepository {
  readonly store = new Map<string, Sandbox>();
  async findById(id: SandboxId): Promise<Sandbox | null> {
    return this.store.get(id) ?? null;
  }
  async findByProject(): Promise<Sandbox[]> {
    return [...this.store.values()];
  }
  saveSync(_tx: Tx, sandbox: Sandbox): void {
    sandbox.markPersisted(sandbox.version);
    this.store.set(sandbox.id, sandbox);
  }
}

function harness() {
  const provider = new FakeProvider('aio');
  const registry: ProviderRegistry = {
    defaultProvider: 'aio',
    get: () => provider,
    has: (n) => n === 'aio',
    list: () => [provider],
  };
  const wsCalls: string[] = [];
  const workspace: WorkspacePreparer = {
    async prepare(id: string): Promise<PreparedWorkspace> {
      wsCalls.push(`prepare:${id}`);
      return { hostPath: `/tmp/ws/${id}` };
    },
    async cleanup(id, opts): Promise<void> {
      wsCalls.push(`cleanup:${id}:${opts.keep}`);
    },
  };
  const repo = new InMemorySandboxRepo();
  const uow: UnitOfWork = { run: (fn) => fn({} as Tx) };
  const events: EventBus = { publishInTx: () => {}, subscribe: () => {} };
  let n = 0;
  const ids: IdGenerator = { next: () => `sbx-${++n}` };
  const clock: Clock = { now: () => new Date('2026-08-13T00:00:00.000Z') };
  const service = new SandboxApplicationService(repo, uow, events, clock, ids, registry, workspace);
  return { service, provider, repo, wsCalls };
}

/** Poll the service until the sandbox reaches `status` (async provision, P1-#1). */
async function waitForStatus(
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

describe('SandboxApplicationService provision pipeline (in-memory doubles)', () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => {
    h = harness();
  });

  it('create() returns pending immediately, then provision drives it to running', async () => {
    // ASYNC (P1-#1): create returns early; provision runs in the background.
    const dto = await h.service.create({ projectId: 'prj-1', runtime: 'claude-code' });
    expect(dto.status).toBe('pending');

    await waitForStatus(h.service, dto.id, 'running');
    expect(h.provider.calls).toEqual(['create', 'start']);
    expect(h.wsCalls[0]).toMatch(/^prepare:/);

    const stored = await h.repo.findById(dto.id as SandboxId);
    expect(stored!.status).toBe('running');
    expect(stored!.providerSandboxId).toBe(`fake-${dto.id}`);
    const path = stored!.transitions.map((t) => t.to);
    expect(path).toEqual([
      'pending',
      'scheduling',
      'preparing-workspace',
      'creating',
      'starting',
      'running',
    ]);
  });

  it('destroy() stops + destroys + cleans the workspace and reaches destroyed', async () => {
    const dto = await h.service.create({ projectId: 'prj-1', runtime: 'claude-code' });
    await waitForStatus(h.service, dto.id, 'running'); // wait for background provision
    await h.service.destroy(dto.id, { keepVolume: false });
    const stored = await h.repo.findById(dto.id as SandboxId);
    expect(stored!.status).toBe('destroyed');
    expect(h.provider.calls).toContain('destroy');
    expect(h.wsCalls.some((c) => c.startsWith(`cleanup:${dto.id}:false`))).toBe(true);
  });

  it('rejects an unknown provider before creating anything', async () => {
    await expect(
      h.service.create({ projectId: 'prj-1', runtime: 'x', provider: 'nope' }),
    ).rejects.toThrow(/unknown provider/i);
  });

  it('destroys the already-created container when start fails (P1-2, no orphan)', async () => {
    // provider whose create() succeeds but start() throws — the container exists
    // and MUST be torn down on the failure path.
    class FailingStartProvider extends FakeProvider {
      override async start(): Promise<void> {
        this.calls.push('start');
        throw new Error('agent never became ready');
      }
    }
    const provider = new FailingStartProvider('aio');
    const registry: ProviderRegistry = {
      defaultProvider: 'aio',
      get: () => provider,
      has: (n) => n === 'aio',
      list: () => [provider],
    };
    const wsCalls: string[] = [];
    const workspace: WorkspacePreparer = {
      async prepare(id: string): Promise<PreparedWorkspace> {
        return { hostPath: `/tmp/ws/${id}` };
      },
      async cleanup(id, opts): Promise<void> {
        wsCalls.push(`cleanup:${id}:${opts.keep}`);
      },
    };
    const repo = new InMemorySandboxRepo();
    const uow: UnitOfWork = { run: (fn) => fn({} as Tx) };
    const events: EventBus = { publishInTx: () => {}, subscribe: () => {} };
    let n = 0;
    const ids: IdGenerator = { next: () => `sbx-fail-${++n}` };
    const clock: Clock = { now: () => new Date('2026-08-13T00:00:00.000Z') };
    const service = new SandboxApplicationService(
      repo,
      uow,
      events,
      clock,
      ids,
      registry,
      workspace,
    );

    // create resolves early (pending); the background provision fails and lands `failed`.
    const dto = await service.create({ projectId: 'prj-1', runtime: 'x' });
    await waitForStatus(service, dto.id, 'failed');
    // create → start(threw) → destroy (teardown) — the container is not orphaned.
    expect(provider.calls).toEqual(['create', 'start', 'destroy']);
    expect(wsCalls.some((c) => c.startsWith('cleanup:'))).toBe(true);
  });
});
