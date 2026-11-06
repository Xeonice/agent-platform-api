import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { asProjectId, asSandboxId, type BusinessWriterAuthority } from '@platform/shared-kernel';
import type { RuntimeBusinessAuthorityPort, WorkspacePreparer } from '@platform/contracts';
import { SandboxFacadeAdapter } from '../../../packages/modules/sandbox/src/application/sandbox-facade.adapter';
import { SandboxApplicationService } from '../../../packages/modules/sandbox/src/application/sandbox-application.service';
import { SandboxHealthMonitor } from '../../../packages/modules/sandbox/src/application/sandbox-health.monitor';
import { ProvisionSandboxWorkflow } from '../../../packages/modules/sandbox/src/application/workflows/provision-sandbox.workflow';
import { ResourceAllocator } from '../../../packages/modules/sandbox/src/application/resource-allocator';
import { SchedulerQueue } from '../../../packages/modules/sandbox/src/application/scheduler-queue';
import { Sandbox } from '../../../packages/modules/sandbox/src/domain/entities/sandbox.entity';
import { SqliteSandboxRepository } from '../../../packages/modules/sandbox/src/infrastructure/persistence/sqlite/sandbox.repository.impl';
import { SqliteResourceAllocationRepository } from '../../../packages/modules/sandbox/src/infrastructure/persistence/sqlite/resource-allocation.repository.impl';
import { FsWorkspacePreparer } from '../../../packages/modules/sandbox/src/infrastructure/workspace/workspace-preparer';
import { DefaultRuntimeAdapterRegistry } from '../../../packages/modules/runtime/src/infrastructure/registry/runtime-adapter.registry';
import { CodexAdapter } from '../../../packages/modules/runtime/src/infrastructure/adapters/codex/codex.adapter';
import { ClaudeCodeAdapter } from '../../../packages/modules/runtime/src/infrastructure/adapters/claude-code/claude-code.adapter';
import { SqliteTerminalBookmarks } from '../../../packages/modules/terminal/src/infrastructure/terminal-bookmarks.sqlite';
import { SqliteUnitOfWork } from '../../../apps/api/src/platform/persistence/unit-of-work.impl';
import { InProcessEventBus } from '../../../apps/api/src/platform/events/in-process-event-bus';
import { DbAuditRecorder } from '../../../apps/api/src/platform/audit/audit-recorder.impl';
import { AuditRepository } from '../../../apps/api/src/platform/audit/audit.repository';
import {
  coordinatorWriterControl,
  fenceCoordinatorConnection,
  withCoordinatorBusinessEpoch,
} from '../../../apps/api/src/platform/persistence/coordinator-lease';
import { ScriptedProvider } from '../../support/external-provider';
import { deferred, unused, useEnv } from '../../support/strict-ports';

// Real committed SQLite schema, application services, repositories and filesystem.
// Only the external resource boundary is scripted; these are not native SDK proofs.
let root: string;
let restore: () => void;
const databases: Database.Database[] = [];
const controls: ReturnType<typeof coordinatorWriterControl>[] = [];
const clock = { now: () => new Date('2026-10-12T00:00:00.000Z') };
const ids = { next: () => randomUUID() };
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'upg-cleanup-ownership-'));
  restore = useEnv({
    DATA_ROOT: root,
    PLATFORM_PROCESS_ROLE: undefined,
    COORDINATOR_GENERATION: undefined,
    COORDINATOR_WRITER_FENCE_VALID: undefined,
  });
});
afterEach(async () => {
  for (const control of controls.splice(0).reverse()) {
    try {
      control.assert();
      control.release();
    } catch (error) {
      // B2 was explicitly released before A3; it must not release A3's lease.
      if (!(error instanceof Error) || error.message !== 'COORDINATOR_WRITER_FENCE_EXPIRED')
        throw error;
    }
  }
  for (const db of databases.splice(0).reverse()) db.close();
  restore();
  await rm(root, { recursive: true, force: true });
});

function connection(filename = ':memory:', migrateSchema = true) {
  const raw = new Database(filename);
  databases.push(raw);
  raw.pragma('foreign_keys=ON');
  if (migrateSchema) migrate(drizzle(raw), { migrationsFolder: resolve(process.cwd(), 'drizzle') });
  return raw;
}
function assembly(
  sqlite: Database.Database,
  writer?: BusinessWriterAuthority,
  authority?: RuntimeBusinessAuthorityPort,
) {
  const db = drizzle(sqlite),
    uow = new SqliteUnitOfWork(sqlite),
    repo = new SqliteSandboxRepository(db),
    bookmarks = new SqliteTerminalBookmarks(db, ids, uow, clock),
    provider = new ScriptedProvider(),
    registry = {
      defaultProvider: provider.name,
      list: () => [provider],
      has: (name: string) => name === provider.name,
      register: () => {
        throw new Error('outside scenario');
      },
      get: (name: string) => {
        if (name !== provider.name) throw new Error('unknown provider');
        return provider;
      },
    },
    events = new InProcessEventBus(),
    audit = new DbAuditRecorder(new AuditRepository(db), clock),
    runtimes = new DefaultRuntimeAdapterRegistry(new CodexAdapter(), new ClaudeCodeAdapter()),
    files = new FsWorkspacePreparer(),
    workspaceCalls: string[] = [],
    workspace: WorkspacePreparer = {
      prepare: (...args) => files.prepare(...args),
      cleanup: async (id, input) => {
        workspaceCalls.push(id);
        return files.cleanup(id, input);
      },
    },
    waiting = { isWaiting: () => false, filterWaiting: () => new Set<string>() },
    resources = new ResourceAllocator(
      new SqliteResourceAllocationRepository(db),
      unused('host capacity'),
      uow,
      clock,
      ids,
      new SchedulerQueue(clock, audit),
    ),
    provision = new ProvisionSandboxWorkflow(
      repo,
      uow,
      events,
      clock,
      workspace,
      runtimes,
      unused('runtime installer'),
      unused('credentials'),
      unused('agent bootstrap'),
      unused('images'),
      audit,
      unused('instance broadcaster'),
      resources,
      undefined,
      undefined,
      registry,
      writer,
    ),
    service = new SandboxApplicationService(
      repo,
      uow,
      events,
      clock,
      ids,
      registry,
      workspace,
      unused('project facade'),
      unused('image facade'),
      runtimes,
      provision,
      new SandboxHealthMonitor(repo, registry, clock, audit),
      resources,
      waiting,
      undefined,
      bookmarks,
    ),
    facade = new SandboxFacadeAdapter(
      repo,
      registry,
      workspace,
      uow,
      service,
      waiting,
      writer,
      bookmarks,
      authority,
    );
  return { sqlite, repo, uow, bookmarks, provider, workspaceCalls, service, facade };
}
async function seed(f: ReturnType<typeof assembly>, id: string, project = 'project-original') {
  const path = join(root, 'workspaces', id);
  await mkdir(path, { recursive: true });
  await writeFile(join(path, 'user.txt'), 'original user data');
  const sandbox = Sandbox.create({
    id: asSandboxId(id),
    projectId: asProjectId(project),
    runtime: 'claude-code',
    provider: 'aio',
    imageRef: '',
    headless: false,
    timeoutMinutes: null,
    idleTimeoutSec: 1800,
    now: clock.now(),
  });
  for (const phase of ['scheduling', 'preparing-workspace', 'creating'] as const)
    sandbox.transitionTo(phase, 'scheduler', clock.now());
  sandbox.bindRuntime({ providerSandboxId: 'original-resource-' + id, workspacePath: path });
  for (const phase of ['starting', 'running', 'stopping', 'stopped'] as const)
    sandbox.transitionTo(phase, 'scheduler', clock.now());
  f.uow.run((tx) => f.repo.saveSync(tx, sandbox));
  const bookmark = await f.bookmarks.ensure(id, 'agent', 'platform-agent');
  return { id, path, sandbox, bookmark };
}
function bookmarkCount(f: ReturnType<typeof assembly>, id: string) {
  return (
    f.sqlite.prepare('SELECT count(*) n FROM terminal_bookmarks WHERE sandbox_id=?').get(id) as {
      n: number;
    }
  ).n;
}

describe('REQ-UPG-001/006/007 — real project cleanup and retained writer ownership', () => {
  it('explicit sandbox destruction clears only its own bookmarks and rejects a late bookmark resurrection', async () => {
    const f = assembly(connection()),
      original = await seed(f, 'original'),
      other = await seed(f, 'other', 'project-other');
    await f.service.destroy(original.id);
    expect((await f.repo.findById(asSandboxId(original.id)))?.status).toBe('destroyed');
    expect(f.provider.calls.filter((call) => call === 'destroy')).toHaveLength(1);
    expect(bookmarkCount(f, original.id)).toBe(0);
    expect(await f.bookmarks.resolve(other.id, other.bookmark.terminalIdentity)).not.toBeNull();
    await expect(readFile(join(original.path, 'user.txt'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(f.bookmarks.ensure(original.id, 'agent', 'platform-agent')).rejects.toThrow(
      'TERMINAL_BOOKMARK_NOT_COMMITTED',
    );
    expect(await f.bookmarks.resolve(original.id, original.bookmark.terminalIdentity)).toBeNull();
    expect(
      await f.bookmarks.confirm(original.id, original.bookmark.terminalIdentity, 'old-runtime'),
    ).toBe(false);
    await f.service.destroy(original.id);
    expect(f.provider.calls.filter((call) => call === 'destroy')).toHaveLength(1);
    expect(bookmarkCount(f, original.id)).toBe(0);
  });
  it('project transaction failure rolls back sandbox, cleanup intent and terminal bookmark deletion together', async () => {
    const f = assembly(connection()),
      original = await seed(f, 'rollback');
    expect(() =>
      f.uow.run((tx) => {
        f.facade.deleteByProjectSync(tx, original.sandbox.projectId);
        throw new Error('project commit rejected');
      }),
    ).toThrow('project commit rejected');
    await f.facade.retryPending();
    expect((await f.repo.findById(asSandboxId(original.id)))?.status).toBe('stopped');
    expect(await f.repo.listPendingProjectCleanup()).toEqual([]);
    expect(bookmarkCount(f, original.id)).toBe(1);
    expect(f.provider.calls).toEqual([]);
    expect(f.workspaceCalls).toEqual([]);
    expect(await readFile(join(original.path, 'user.txt'), 'utf8')).toBe('original user data');
  });
  it('purging an already destroyed sandbox never destroys the provider resource again and completes its durable cleanup intent', async () => {
    const f = assembly(connection()),
      original = await seed(f, 'already-destroyed');
    await f.service.destroy(original.id);
    const paths = f.uow.run((tx) => f.facade.deleteByProjectSync(tx, original.sandbox.projectId));
    expect((await f.repo.listPendingProjectCleanup())[0].providerSandboxId).toBeNull();
    await f.facade.removeProjectWorkspaces(paths);
    expect(f.provider.calls.filter((call) => call === 'destroy')).toHaveLength(1);
    expect(await f.repo.listPendingProjectCleanup()).toEqual([]);
    expect(await f.repo.findById(asSandboxId(original.id))).toBeNull();
    expect(await f.bookmarks.resolve(original.id, original.bookmark.terminalIdentity)).toBeNull();
    expect(
      await f.bookmarks.confirm(original.id, original.bookmark.terminalIdentity, 'old-runtime'),
    ).toBe(false);
    await expect(f.bookmarks.ensure(original.id, 'agent', 'platform-agent')).rejects.toThrow(
      'TERMINAL_BOOKMARK_NOT_COMMITTED',
    );
    expect(bookmarkCount(f, original.id)).toBe(0);
  });
  it('committed stopped cleanup still removes the original resource and real workspace while preserving another project', async () => {
    const f = assembly(connection()),
      original = await seed(f, 'stopped'),
      other = await seed(f, 'isolated-other', 'other-project');
    const paths = f.uow.run((tx) => f.facade.deleteByProjectSync(tx, original.sandbox.projectId));
    expect(bookmarkCount(f, original.id)).toBe(0);
    expect(await readFile(join(original.path, 'user.txt'), 'utf8')).toBe('original user data');
    await f.facade.removeProjectWorkspaces(paths);
    expect(f.provider.calls.filter((call) => call === 'destroy')).toHaveLength(1);
    expect(f.workspaceCalls).toEqual([original.id]);
    expect(await f.repo.listPendingProjectCleanup()).toEqual([]);
    await expect(readFile(join(original.path, 'user.txt'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(bookmarkCount(f, other.id)).toBe(1);
    expect(await readFile(join(other.path, 'user.txt'), 'utf8')).toBe('original user data');
  });
  it('A1 delayed destroy acknowledgement cannot remove workspace or intent after B2 and retained A3; a fresh retry keeps the same intent', async () => {
    const filename = join(root, 'business.sqlite'),
      rawA = connection(filename),
      rawB = connection(filename, false),
      a = fenceCoordinatorConnection(rawA, 'cleanup-instance', clock, ids),
      controlA = coordinatorWriterControl(a);
    controls.push(controlA);
    const writer: BusinessWriterAuthority = {
        assert: () => controlA.assert(),
        epoch: () => controlA.generation,
        run: (work) => withCoordinatorBusinessEpoch(a, work),
      },
      operations: string[] = [],
      authority: RuntimeBusinessAuthorityPort = {
        run: (operation, work) => {
          operations.push(operation.operationId);
          return work();
        },
      },
      f = assembly(a, writer, authority),
      original = await seed(f, 'late-ack'),
      other = await seed(f, 'retained-bookmark', 'other-project');
    const paths = f.uow.run((tx) => f.facade.deleteByProjectSync(tx, original.sandbox.projectId));
    const dispatched = deferred<void>(),
      ack = deferred<void>();
    let destroyCalls = 0;
    f.provider.destroy = async () => {
      destroyCalls++;
      if (destroyCalls === 1) {
        dispatched.resolve();
        await ack.promise;
      }
    };
    const previous = f.facade.removeProjectWorkspaces(paths);
    await dispatched.promise;
    expect(f.facade.pauseOwnership()).toBe(false);
    controlA.release();
    const b = fenceCoordinatorConnection(rawB, 'cleanup-instance', clock, ids),
      controlB = coordinatorWriterControl(b);
    controls.push(controlB);
    expect(controlB.generation).toBe(2);
    controlB.release();
    controlA.reacquire();
    expect(controlA.generation).toBe(3);
    ack.resolve();
    await previous;
    expect(f.workspaceCalls).toEqual([]);
    expect(await f.repo.listPendingProjectCleanup()).toHaveLength(1);
    expect(await readFile(join(original.path, 'user.txt'), 'utf8')).toBe('original user data');
    expect(bookmarkCount(f, other.id)).toBe(1);
    await f.facade.retryPending();
    expect(operations).toEqual([
      `project-cleanup:${original.id}`,
      `project-cleanup:${original.id}`,
    ]);
    expect(f.workspaceCalls).toEqual([original.id]);
    expect(await f.repo.listPendingProjectCleanup()).toEqual([]);
    expect(bookmarkCount(f, other.id)).toBe(1);
    await expect(readFile(join(original.path, 'user.txt'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
  it('paused cleanup dispatches nothing and resumes the original durable stopped intent without allocating another sandbox', async () => {
    const f = assembly(connection()),
      original = await seed(f, 'paused');
    f.uow.run((tx) => f.facade.deleteByProjectSync(tx, original.sandbox.projectId));
    expect(f.facade.pauseOwnership()).toBe(true);
    await f.facade.retryPending();
    expect(f.provider.calls).toEqual([]);
    expect(f.workspaceCalls).toEqual([]);
    expect(await f.repo.listPendingProjectCleanup()).toHaveLength(1);
    f.facade.resumeOwnership();
    await f.facade.retryPending();
    expect(f.provider.calls).toEqual(['destroy']);
    expect(f.workspaceCalls).toEqual([original.id]);
    expect(await f.repo.listPendingProjectCleanup()).toEqual([]);
    expect((f.sqlite.prepare('SELECT count(*) n FROM sandboxes').get() as { n: number }).n).toBe(0);
  });
});
