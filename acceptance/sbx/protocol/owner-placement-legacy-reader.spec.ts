import 'reflect-metadata';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import Module, { createRequire } from 'node:module';
import { dirname, join, posix, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { asNodeId, asProjectId, asSandboxId } from '@platform/shared-kernel';
import type { SandboxDto, SandboxHandle } from '@platform/contracts';
import { Sandbox } from '../../../packages/modules/sandbox/src/domain/entities/sandbox.entity';
import { ResourceAllocation } from '../../../packages/modules/sandbox/src/domain/entities/resource-allocation.entity';
import { SqliteSandboxRepository } from '../../../packages/modules/sandbox/src/infrastructure/persistence/sqlite/sandbox.repository.impl';
import { SqliteResourceAllocationRepository } from '../../../packages/modules/sandbox/src/infrastructure/persistence/sqlite/resource-allocation.repository.impl';
import { currentDatabase } from '../../support/sqlite';

const fixtureRoot = resolve('acceptance/fixtures/legacy-owner-placement-7da');
const actualDependencies = createRequire(resolve('packages/modules/sandbox/package.json'));
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
interface FrozenFile {
  module: string;
  fixture: string;
  archiveMember: string;
  bytes: number;
  sha256: string;
  sourcePath: string;
  sourceSha256: string;
}
const metadata = JSON.parse(readFileSync(join(fixtureRoot, 'metadata.json'), 'utf8')) as {
  sourceApiRevision: string;
  archive: { sha256: string; bytes: number };
  envelope: { manifestDigest: string };
  externalImports: string[];
  externalArchiveVersions: Record<string, string>;
  files: FrozenFile[];
};

/** Runs immutable A2 JS, including its aggregate and schema, rather than
 * recompiling old source against new code. Bare imports deliberately use real
 * same-version host Nest/Drizzle/SQLite and current workspace dependencies.
 * This is a SQLite reader/writer compatibility test, not an old-service or
 * Linux/Native qualification. No archive node_modules or SDK is loaded. */
function frozenReader() {
  const files = new Map(metadata.files.map((file) => [file.module, file]));
  const cache = new Map<string, Module>();
  const loaded = new Set<string>();
  const load = (name: string): Record<string, unknown> => {
    const file = files.get(name);
    if (!file || posix.normalize(name) !== name || name.startsWith('../'))
      throw new Error('UNLISTED_LEGACY_FIXTURE_MODULE');
    const existing = cache.get(name);
    if (existing) return existing.exports as Record<string, unknown>;
    const path = join(fixtureRoot, file.fixture);
    const bytes = readFileSync(path);
    if (
      file.fixture !== name + '.txt' ||
      bytes.length !== file.bytes ||
      digest(bytes) !== file.sha256
    )
      throw new Error('LEGACY_FIXTURE_BYTES_CHANGED');
    const legacy = new Module(path) as Module & {
      _compile(source: string, filename: string): void;
    };
    cache.set(name, legacy);
    legacy.require = (request: string) => {
      if (request.startsWith('.')) {
        const target = posix.normalize(posix.join(posix.dirname(name), request));
        return load(target.endsWith('.js') ? target : target + '.js');
      }
      if (!metadata.externalImports.includes(request))
        throw new Error('UNLISTED_LEGACY_EXTERNAL_IMPORT');
      return actualDependencies(request);
    };
    legacy._compile(bytes.toString('utf8'), path);
    loaded.add(name);
    return legacy.exports as Record<string, unknown>;
  };
  type Db = ReturnType<typeof currentDatabase>['db'];
  const SandboxRepo = load('infrastructure/persistence/sqlite/sandbox.repository.impl.js')
    .SqliteSandboxRepository as new (
    db: Db,
  ) => Pick<SqliteSandboxRepository, 'findById' | 'countActiveByProject' | 'saveSync'>;
  const AllocationRepo = load(
    'infrastructure/persistence/sqlite/resource-allocation.repository.impl.js',
  ).SqliteResourceAllocationRepository as new (
    db: Db,
  ) => Pick<SqliteResourceAllocationRepository, 'listActive' | 'findActiveBySandbox' | 'saveSync'>;
  const mapper = load('application/dto/sandbox.mapper.js').SandboxMapper as {
    toDto(sandbox: Sandbox, waitingInput: boolean): SandboxDto;
  };
  const Workflow = load('application/workflows/provision-sandbox.workflow.js')
    .ProvisionSandboxWorkflow as {
    new (...args: unknown[]): {
      resumeUnconfirmed(): Promise<void>;
      onModuleDestroy(): void;
    };
    prototype: { handleOf(sandbox: Sandbox): SandboxHandle };
  };
  return { SandboxRepo, AllocationRepo, mapper, Workflow, loaded };
}

function installedVersion(name: string): string {
  let cursor = dirname(actualDependencies.resolve(name));
  for (;;) {
    try {
      const pkg = JSON.parse(readFileSync(join(cursor, 'package.json'), 'utf8')) as {
        name?: string;
        version?: string;
      };
      if (pkg.name === name && pkg.version) return pkg.version;
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
    }
    const parent = dirname(cursor);
    if (parent === cursor) throw new Error('LEGACY_DEPENDENCY_PACKAGE_NOT_FOUND');
    cursor = parent;
  }
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanups.splice(0).reverse()) close();
});

function sqliteFixture() {
  const database = currentDatabase();
  cleanups.push(() => database.sqlite.close());
  const old = frozenReader();
  const newSandboxes = new SqliteSandboxRepository(database.db);
  const newAllocations = new SqliteResourceAllocationRepository(database.db);
  database.sqlite
    .prepare(
      "INSERT INTO projects(id,name,source_type,clone_status,baseline_path,created_at,updated_at) VALUES('legacy-placement-project','fixture','empty','ready','/tmp/fixture',0,0)",
    )
    .run();
  const now = new Date('2026-10-20T00:00:00Z');
  function admit(id: string, owner: string) {
    const sandbox = Sandbox.create({
      id: asSandboxId(id),
      projectId: asProjectId('legacy-placement-project'),
      runtime: 'claude-code',
      provider: 'fixture',
      imageRef: '',
      headless: false,
      timeoutMinutes: null,
      idleTimeoutSec: 1800,
      now,
    });
    sandbox.setPendingProviderState({ runtimeOwnerPlacement: { ownerId: owner } });
    const allocation = ResourceAllocation.allocate({
      id: 'allocation-' + id,
      sandboxId: sandbox.id,
      nodeId: asNodeId('local'),
      quota: { cores: 2, ramMb: 2048, diskMb: 10240 },
      now,
    });
    // Current production aggregates and repositories write the actual new T1
    // storage representation in one real SQLite transaction. No DDL is added.
    database.uow.run((tx) => {
      newSandboxes.saveSync(tx, sandbox);
      newAllocations.saveSync(tx, allocation);
    });
    return sandbox;
  }
  return {
    ...database,
    old,
    admit,
    oldSandboxes: new old.SandboxRepo(database.db),
    oldAllocations: new old.AllocationRepo(database.db),
    newSandboxes,
    newAllocations,
  };
}

describe('A2 7da compiled-reader compatibility with opaque pending Owner placement', () => {
  it('checks frozen archive provenance, module hashes and real dependency versions [AC-UPG-007.3]', () => {
    expect(metadata.sourceApiRevision).toBe('7da1e0b22ae43f79a4b9ed0baf0b1be34eabf427');
    expect(metadata.archive).toMatchObject({
      sha256: 'ad8aeded3ae50b38e0e427d8aa6fa5042fbcd9ece63c84e73a5d4d6f8e0cac9d',
      bytes: 94888961,
    });
    expect(metadata.envelope.manifestDigest).toBe(
      'sha256:6716aa4bcab77def70273fb5b5322598b354e74fed971e2908f6cd3e5c446143',
    );
    for (const [name, version] of Object.entries(metadata.externalArchiveVersions))
      expect(installedVersion(name), name).toBe(version);
    const old = frozenReader();
    expect([...old.loaded].sort()).toEqual(metadata.files.map((file) => file.module).sort());
    for (const file of metadata.files) {
      expect(file.archiveMember.endsWith('/sandbox/dist/' + file.module)).toBe(true);
      expect(file.sourcePath).toBe(
        'packages/modules/sandbox/src/' + file.module.slice(0, -3) + '.ts',
      );
      expect(file.sourceSha256).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it('old local readers count both Owner pools and keep opaque placement through old saves [AC-UPG-007.3]', async () => {
    const f = sqliteFixture();
    const a = f.admit('legacy-placement-a', 'owner-a');
    const b = f.admit('legacy-placement-b', 'owner-b');
    expect(await f.oldSandboxes.countActiveByProject(['legacy-placement-project'])).toEqual({
      'legacy-placement-project': 2,
    });
    const ledger = await f.oldAllocations.listActive(asNodeId('local'));
    expect(ledger.map((row) => row.sandboxId)).toEqual([a.id, b.id]);
    expect(ledger.reduce((sum, row) => sum + row.coresReserved, 0)).toBe(4);
    expect(ledger.reduce((sum, row) => sum + row.ramMbReserved, 0)).toBe(4096);
    expect(ledger.reduce((sum, row) => sum + row.diskMbReserved, 0)).toBe(20480);
    for (const [id, owner] of [
      [a.id, 'owner-a'],
      [b.id, 'owner-b'],
    ] as const) {
      const oldSandbox = await f.oldSandboxes.findById(id);
      expect(oldSandbox).not.toBeNull();
      if (!oldSandbox) throw new Error('MISSING_OLD_SANDBOX');
      expect(oldSandbox).not.toBeInstanceOf(Sandbox);
      expect(oldSandbox.providerState).toEqual({ runtimeOwnerPlacement: { ownerId: owner } });
      expect(oldSandbox.providerSandboxId).toBeNull();
      oldSandbox.transitionTo('scheduling', 'scheduler', new Date('2026-10-20T00:00:01Z'));
      const allocation = await f.oldAllocations.findActiveBySandbox(id);
      expect(allocation).not.toBeNull();
      if (!allocation) throw new Error('MISSING_OLD_ALLOCATION');
      allocation.confirm();
      f.uow.run((tx) => {
        f.oldSandboxes.saveSync(tx, oldSandbox);
        f.oldAllocations.saveSync(tx, allocation);
      });
      const reloaded = await f.newSandboxes.findById(id);
      expect(reloaded?.providerState).toEqual({ runtimeOwnerPlacement: { ownerId: owner } });
      expect(reloaded?.providerSandboxId).toBeNull();
      expect(reloaded?.status).toBe('scheduling');
      expect((await f.newAllocations.findActiveBySandbox(id))?.nodeId).toBe('local');
      expect((await f.newAllocations.findActiveBySandbox(id))?.reconciliationStatus).toBe(
        'confirmed',
      );
    }
    expect((await f.oldAllocations.listActive(asNodeId('local'))).length).toBe(2);
  });

  it('old mapper and recovery do not turn pending opaque placement into a Guest handle or replay create [AC-UPG-007.3]', async () => {
    const f = sqliteFixture();
    const accepted = f.admit('legacy-placement-pending', 'owner-a');
    const pending = await f.oldSandboxes.findById(accepted.id);
    expect(pending).not.toBeNull();
    if (!pending) throw new Error('MISSING_OLD_SANDBOX');
    const dto = f.old.mapper.toDto(pending, false);
    expect(dto.status).toBe('pending');
    expect(dto).not.toHaveProperty('providerState');
    expect(dto).not.toHaveProperty('providerSandboxId');
    expect(() => f.old.Workflow.prototype.handleOf(pending)).toThrow('has no provider handle');
    const providerCalls: string[] = [];
    const workflow = new f.old.Workflow(
      f.oldSandboxes,
      f.uow,
      undefined,
      { now: () => new Date('2026-10-20T00:00:02Z') },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        // Even if an intent exists, old recovery checks the persisted status
        // before resolving a provider. It does not resume pending T1 state.
        pending: async () => [{ sandboxId: accepted.id, operationId: 'original-operation' }],
      },
      {
        get: () => {
          providerCalls.push('get');
          throw new Error('PENDING_PLACEMENT_MUST_NOT_RESOLVE_PROVIDER');
        },
      },
    );
    await workflow.resumeUnconfirmed();
    workflow.onModuleDestroy();
    expect(providerCalls).toEqual([]);
    expect((await f.newSandboxes.findById(accepted.id))?.providerState).toEqual({
      runtimeOwnerPlacement: { ownerId: 'owner-a' },
    });
    expect((await f.oldAllocations.listActive(asNodeId('local'))).length).toBe(1);
  });
});
