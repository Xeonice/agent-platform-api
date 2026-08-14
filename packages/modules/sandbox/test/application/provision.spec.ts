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
  const events: EventBus = { publishInTx: () => {} };
  let n = 0;
  const ids: IdGenerator = { next: () => `sbx-${++n}` };
  const clock: Clock = { now: () => new Date('2026-08-13T00:00:00.000Z') };
  const service = new SandboxApplicationService(repo, uow, events, clock, ids, registry, workspace);
  return { service, provider, repo, wsCalls };
}

describe('SandboxApplicationService provision pipeline (in-memory doubles)', () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => {
    h = harness();
  });

  it('create() drives pending→…→running and records the provider handle', async () => {
    const dto = await h.service.create({ projectId: 'prj-1', runtime: 'claude-code' });
    expect(dto.status).toBe('running');
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
});
