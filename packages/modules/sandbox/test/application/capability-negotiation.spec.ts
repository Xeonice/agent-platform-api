import { describe, it, expect } from 'vitest';
import { HttpException } from '@nestjs/common';
import type {
  Clock,
  EventBus,
  IdGenerator,
  SandboxId,
  Tx,
  UnitOfWork,
} from '@platform/shared-kernel';
import type {
  CreateSandboxInput,
  PreparedWorkspace,
  ProcessSpec,
  ProcessStream,
  ProjectFacade,
  ProviderRegistry,
  SandboxHandle,
  SandboxProvider,
  SandboxProviderCapabilities,
  SandboxProviderContext,
  SandboxRuntimeStatus,
  WorkspacePreparer,
} from '@platform/contracts';
import { SandboxApplicationService } from '../../src/application/sandbox-application.service';
import type { Sandbox } from '../../src/domain/entities/sandbox.entity';
import type { SandboxRepository } from '../../src/domain/repositories/sandbox.repository';

/**
 * Capabilities協商 (docs/backend/04 §5): the two rules that have a REAL platform branch
 * today — 「创建前静态校验」 and the 「spawnTty=false ⇒ 创建时即拒绝」 row of §2.5 — plus the
 * 「能力发现」 endpoint's application half. This is also the FIRST producer of
 * `UNSUPPORTED_CAPABILITY`: before this slice the error code had no throw site at all.
 */
const FULL: SandboxProviderCapabilities = {
  spawnTty: true,
  volumeMount: true,
  updateResources: true,
  pauseResume: true,
  snapshot: true,
  watchEvents: true,
};

class FakeProvider implements SandboxProvider {
  readonly calls: string[] = [];
  constructor(
    readonly name: string,
    readonly capabilities: SandboxProviderCapabilities,
  ) {}
  async create(ctx: SandboxProviderContext): Promise<SandboxHandle> {
    this.calls.push('create');
    return { provider: this.name, providerSandboxId: `fake-${ctx.sandboxId}` };
  }
  async start(): Promise<void> {
    this.calls.push('start');
  }
  async stop(): Promise<void> {}
  async destroy(): Promise<void> {}
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
  async countActiveByProject(): Promise<Record<string, number>> {
    return {};
  }
  saveSync(_tx: Tx, sandbox: Sandbox): void {
    sandbox.markPersisted(sandbox.version);
    this.store.set(sandbox.id, sandbox);
  }
}

function harness(providers: FakeProvider[], defaultProvider = providers[0].name) {
  const byName = new Map(providers.map((p) => [p.name, p]));
  const registry: ProviderRegistry = {
    defaultProvider,
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
  const workspace: WorkspacePreparer = {
    async prepare(id: string): Promise<PreparedWorkspace> {
      return { hostPath: `/tmp/ws/${id}` };
    },
    async cleanup(): Promise<void> {},
  };
  let projectLookups = 0;
  const projectFacade: ProjectFacade = {
    async getRuntimeContextForTask(projectId) {
      projectLookups += 1;
      return { projectId, baselinePath: `/tmp/baseline/${projectId}`, sourceType: 'empty' };
    },
  };
  const repo = new InMemorySandboxRepo();
  const uow: UnitOfWork = { run: (fn) => fn({} as Tx) };
  const events: EventBus = { publishInTx: () => {}, subscribe: () => {} };
  let n = 0;
  const ids: IdGenerator = { next: () => `sbx-${++n}` };
  const clock: Clock = { now: () => new Date('2026-08-21T00:00:00.000Z') };
  const service = new SandboxApplicationService(
    repo,
    uow,
    events,
    clock,
    ids,
    registry,
    workspace,
    projectFacade,
  );
  return { service, registry, repo, projectLookups: () => projectLookups };
}

const base: CreateSandboxInput = { projectId: 'prj-1', runtime: 'claude-code' };

/** Assert the rejection is the contract error mapped through 04 §4 (409 + code). */
async function expectUnsupported(p: Promise<unknown>): Promise<HttpException> {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(HttpException);
  const http = e as HttpException;
  expect(http.getStatus()).toBe(409);
  expect(http.getResponse()).toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
  return http;
}

describe('create-time capability negotiation (04 §5 创建前静态校验)', () => {
  it('rejects a request that requires a capability the provider lacks — WITHOUT scheduling', async () => {
    const noSnapshot = new FakeProvider('aio', { ...FULL, snapshot: false });
    const h = harness([noSnapshot]);

    const err = await expectUnsupported(h.service.create({ ...base, require: { snapshot: true } }));
    expect(err.message).toMatch(/snapshot/);

    // 「不进调度队列」: no provider call, no project lookup, no persisted row.
    expect(noSnapshot.calls).toEqual([]);
    expect(h.projectLookups()).toBe(0);
    expect(h.repo.store.size).toBe(0);
  });

  it('lets the same request through on a provider that DOES advertise the bit', async () => {
    const withSnapshot = new FakeProvider('aio', FULL);
    const h = harness([withSnapshot]);

    const dto = await h.service.create({ ...base, require: { snapshot: true } });
    expect(dto.status).toBe('pending');
    expect(h.projectLookups()).toBe(1);
  });

  it('checks every requested bit, not just snapshot', async () => {
    const p = new FakeProvider('aio', { ...FULL, pauseResume: false, updateResources: false });
    const h = harness([p]);

    await expectUnsupported(h.service.create({ ...base, require: { pauseResume: true } }));
    await expectUnsupported(h.service.create({ ...base, require: { updateResources: true } }));
    // `false` means "do not care", not "must be false"
    const dto = await h.service.create({ ...base, require: { pauseResume: false } });
    expect(dto.status).toBe('pending');
  });

  it('the requirement is evaluated against the REQUESTED provider, not the default', async () => {
    const aio = new FakeProvider('aio', FULL);
    const lite = new FakeProvider('boxlite', { ...FULL, snapshot: false });
    const h = harness([aio, lite], 'aio');

    await expectUnsupported(
      h.service.create({ ...base, provider: 'boxlite', require: { snapshot: true } }),
    );
    expect(lite.calls).toEqual([]);
    // the default provider supports it, so the same request without `provider` passes
    await h.service.create({ ...base, require: { snapshot: true } });
  });
});

describe('spawnTty is required unconditionally (04 §2.5 spawnTty row)', () => {
  it('refuses to create on a provider that cannot spawn a TTY, even with no `require`', async () => {
    const headlessOnly = new FakeProvider('noTty', { ...FULL, spawnTty: false });
    const h = harness([headlessOnly]);

    const err = await expectUnsupported(h.service.create(base));
    expect(err.message).toMatch(/spawnTty/);
    expect(err.message).toMatch(/TTY/);
    expect(headlessOnly.calls).toEqual([]);
    expect(h.repo.store.size).toBe(0);
  });

  it('a TTY-capable provider is unaffected', async () => {
    const ok = new FakeProvider('aio', FULL);
    const h = harness([ok]);
    await expect(h.service.create(base)).resolves.toMatchObject({ status: 'pending' });
  });
});

describe('capability discovery (04 §5 能力发现)', () => {
  it('projects the whole registry — all 6 bits per provider + which one is default', () => {
    const aio = new FakeProvider('aio', FULL);
    const lite = new FakeProvider('boxlite', { ...FULL, updateResources: false, snapshot: false });
    const h = harness([aio, lite], 'aio');

    expect(h.service.listProviders()).toEqual([
      { name: 'aio', capabilities: FULL, isDefault: true },
      {
        name: 'boxlite',
        capabilities: { ...FULL, updateResources: false, snapshot: false },
        isDefault: false,
      },
    ]);
  });

  it('is REGISTRY-driven: a provider registered after boot appears with no code change', () => {
    const aio = new FakeProvider('aio', FULL);
    const h = harness([aio], 'aio');
    expect(h.service.listProviders().map((p) => p.name)).toEqual(['aio']);

    // exactly what an out-of-tree module does in its onModuleInit
    const acme = new FakeProvider('acme', { ...FULL, pauseResume: false });
    h.registry.register(acme);

    const rows = h.service.listProviders();
    expect(rows.map((p) => p.name)).toEqual(['aio', 'acme']);
    expect(rows.find((p) => p.name === 'acme')?.capabilities.pauseResume).toBe(false);
    expect(rows.find((p) => p.name === 'acme')?.isDefault).toBe(false);
  });
});
