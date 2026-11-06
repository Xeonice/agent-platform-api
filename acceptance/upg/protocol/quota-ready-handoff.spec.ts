import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import {
  asProjectId,
  asSandboxId,
  CoordinatorWorkRegistry,
  installCoordinatorWorkRegistry,
} from '@platform/shared-kernel';
import type { DomainEvent, EventBus } from '@platform/shared-kernel';
import type { SandboxProvider } from '@platform/contracts';
import {
  coordinatorWriterControl,
  fenceCoordinatorConnection,
  withCoordinatorBusinessEpoch,
} from '../../../apps/api/src/platform/persistence/coordinator-lease';
import { SqliteUnitOfWork } from '../../../apps/api/src/platform/persistence/unit-of-work.impl';
import { QuotaReconciler } from '../../../packages/modules/sandbox/src/application/quota-reconciler';
import { ResourceAllocator } from '../../../packages/modules/sandbox/src/application/resource-allocator';
import { SchedulerQueue } from '../../../packages/modules/sandbox/src/application/scheduler-queue';
import { Sandbox } from '../../../packages/modules/sandbox/src/domain/entities/sandbox.entity';
import { SqliteSandboxRepository } from '../../../packages/modules/sandbox/src/infrastructure/persistence/sqlite/sandbox.repository.impl';
import { SqliteResourceAllocationRepository } from '../../../packages/modules/sandbox/src/infrastructure/persistence/sqlite/resource-allocation.repository.impl';
import { Project } from '../../../packages/modules/project/src/domain/entities/project.entity';
import { SqliteProjectRepository } from '../../../packages/modules/project/src/infrastructure/persistence/sqlite/project.repository.impl';
import { ScriptedProvider } from '../../support/external-provider';
import { deferred, useEnv } from '../../support/strict-ports';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

function fixture() {
  cleanup.push(useEnv({ DISABLE_QUOTA_RECONCILE: undefined }));
  const directory = mkdtempSync(join(tmpdir(), 'upg-quota-ready-'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const filename = join(directory, 'state.db');
  const clock = { now: () => new Date() };
  const raw = new Database(filename);
  raw.pragma('journal_mode = WAL');
  // Construct the real writer before installing this test's quota-only census.
  const sqlite = fenceCoordinatorConnection(raw, 'quota-ready', clock, { next: randomUUID });
  cleanup.push(() => {
    sqlite.close();
  });
  const db = drizzle(sqlite);
  migrate(db, { migrationsFolder: resolve('drizzle') });
  const uow = new SqliteUnitOfWork(sqlite);
  const sandboxes = new SqliteSandboxRepository(db);
  const allocations = new SqliteResourceAllocationRepository(db);
  const projects = new SqliteProjectRepository(db);
  uow.run((tx) =>
    projects.saveSync(
      tx,
      Project.create({
        id: asProjectId('quota-project'),
        name: 'quota-project',
        sourceType: 'empty',
        baselinePath: directory,
        now: clock.now(),
      }),
    ),
  );
  const published: DomainEvent[] = [];
  const events: EventBus = {
    publishInTx: (_tx, values) => published.push(...values),
    subscribe: () => {},
  };
  const queue = new SchedulerQueue(clock, { record: () => {} });
  const resources = new ResourceAllocator(
    allocations,
    {
      capacity: async () => ({
        cores: 16,
        ramMb: 32768,
        diskTotalBytes: 100 * 1024 ** 3,
        diskAvailableBytes: 80 * 1024 ** 3,
      }),
    },
    uow,
    clock,
    { next: randomUUID },
    queue,
  );
  const provider: SandboxProvider = new ScriptedProvider();
  const newReconciler = () =>
    new QuotaReconciler(
      allocations,
      sandboxes,
      {
        defaultProvider: provider.name,
        has: (name) => name === provider.name,
        get: () => provider,
        list: () => [provider],
        register: () => {
          throw new Error('Provider registration is outside this scenario');
        },
      },
      events,
      clock,
      resources,
      {
        assert: () => coordinatorWriterControl(sqlite).assert(),
        run: (work) => withCoordinatorBusinessEpoch(sqlite, work),
      },
    );
  const reserve = async (id: string) => {
    const sandbox = Sandbox.create({
      id: asSandboxId(id),
      projectId: asProjectId('quota-project'),
      runtime: 'claude-code',
      provider: provider.name,
      imageRef: '',
      headless: false,
      timeoutMinutes: null,
      idleTimeoutSec: 1800,
      now: clock.now(),
    });
    for (const status of [
      'scheduling',
      'preparing-workspace',
      'creating',
      'starting',
      'running',
    ] as const)
      sandbox.transitionTo(status, 'scheduler', clock.now());
    sandbox.bindRuntime({ providerSandboxId: `instance-${id}`, workspacePath: directory });
    await resources.reserve(
      { sandboxId: sandbox.id, quota: { cores: 2, ramMb: 2048, diskMb: 512 } },
      (tx) => sandboxes.saveSync(tx, sandbox),
    );
  };
  return {
    filename,
    clock,
    sqlite,
    allocations,
    resources,
    provider,
    newReconciler,
    reserve,
    published,
  };
}

describe('REQ-UPG-006 — quota reconciliation starts after ready and retains real work', () => {
  it('cancels a queued startup scan before it can inspect a provider', async () => {
    const f = fixture();
    await f.reserve('queued');
    const inspect = vi.spyOn(f.provider, 'inspect');
    const quota = f.newReconciler();
    quota.deferStartupUntilReady();
    await quota.onApplicationBootstrap();
    expect(inspect).not.toHaveBeenCalled();
    quota.startAfterReady();
    await quota.onModuleDestroy();
    await new Promise<void>((ok) => setImmediate(ok));
    expect(inspect).not.toHaveBeenCalled();
    expect(await f.resources.snapshot()).toMatchObject({ usedCores: 2, usedRamMb: 2048 });
  });

  it('does not rebind a queued startup scan to a later reacquired writer epoch', async () => {
    const f = fixture();
    await f.reserve('queued-old-epoch');
    const inspect = vi.spyOn(f.provider, 'inspect');
    const quota = f.newReconciler();
    cleanup.push(() => quota.onModuleDestroy());
    quota.deferStartupUntilReady();
    quota.onApplicationBootstrap();
    quota.startAfterReady();
    coordinatorWriterControl(f.sqlite).release();
    const other = fenceCoordinatorConnection(new Database(f.filename), 'quota-ready', f.clock, {
      next: randomUUID,
    });
    coordinatorWriterControl(other).release();
    other.close();
    expect(coordinatorWriterControl(f.sqlite).reacquire()).toBe(3);
    await new Promise<void>((ok) => setImmediate(ok));
    expect(inspect).not.toHaveBeenCalled();
    expect(await f.resources.snapshot()).toMatchObject({ usedCores: 2, usedRamMb: 2048 });
    expect(f.published).toEqual([]);
  });

  it('serves real HTTP with every allocation charged, rejects a superseded epoch, and drains active work before DB close', async () => {
    const f = fixture();
    await f.reserve('active');
    // Only this new registry is certified here, not a complete production composition.
    const workers = new CoordinatorWorkRegistry();
    installCoordinatorWorkRegistry(workers);
    const quota = f.newReconciler();
    cleanup.push(() => quota.onModuleDestroy());
    const pending: ReturnType<typeof deferred<Awaited<ReturnType<SandboxProvider['inspect']>>>>[] =
      [];
    cleanup.push(() => {
      for (const next of pending) next.resolve({ lifecycleState: 'instance_missing' });
    });
    const inspect = vi.spyOn(f.provider, 'inspect').mockImplementation(() => {
      const next = deferred<Awaited<ReturnType<SandboxProvider['inspect']>>>();
      pending.push(next);
      return next.promise;
    });
    // The actual production role compositions defer before Nest hooks and start after listen.
    quota.deferStartupUntilReady();
    await quota.onApplicationBootstrap();
    expect(inspect).not.toHaveBeenCalled();
    const server = createServer((_req, res) => {
      void f.resources.snapshot().then((snapshot) => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(snapshot));
      });
    });
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    cleanup.push(() => new Promise<void>((ok) => server.close(() => ok())));
    quota.startAfterReady();
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    expect(workers.snapshot().active).toBeGreaterThan(0);
    const response = await request(server).get('/quota-view').expect(200);
    expect(response.body).toMatchObject({ usedCores: 2, usedRamMb: 2048, usedDiskMb: 512 });
    pending[0].reject(new Error('Declared provider unavailable'));
    await vi.waitFor(() => expect(workers.snapshot().active).toBe(0));
    expect(await f.allocations.findActiveBySandbox(asSandboxId('active'))).toMatchObject({
      reconciliationStatus: 'pending',
      releasedAt: null,
    });
    expect(f.published).toEqual([]);

    const stale = quota.reconcile();
    // Attach rejection handling before the controlled provider is released.
    const staleResult = expect(stale).rejects.toThrow('COORDINATOR_OPERATION_EPOCH_SUPERSEDED');
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    coordinatorWriterControl(f.sqlite).release();
    const other = fenceCoordinatorConnection(new Database(f.filename), 'quota-ready', f.clock, {
      next: randomUUID,
    });
    coordinatorWriterControl(other).release();
    other.close();
    expect(coordinatorWriterControl(f.sqlite).reacquire()).toBe(3);
    pending[1].resolve({ lifecycleState: 'instance_missing' });
    await staleResult;
    expect(await f.resources.snapshot()).toMatchObject({ usedCores: 2, usedRamMb: 2048 });
    expect(f.published).toEqual([]);

    // A new operation admitted under the actual current epoch can still reconcile.
    const current = quota.reconcile();
    await vi.waitFor(() => expect(pending).toHaveLength(3));
    pending[2].resolve({ lifecycleState: 'instance_missing' });
    expect(await current).toMatchObject({ orphaned: 1 });
    expect(await f.allocations.findActiveBySandbox(asSandboxId('active'))).toBeNull();
    expect(f.published.map((event) => event.type)).toEqual(['SandboxReconciledAsOrphan']);

    await f.reserve('retiring');
    const active = quota.reconcile();
    await vi.waitFor(() => expect(pending).toHaveLength(4));
    workers.seal(['sandbox.quota', 'platform.writer-renewal']);
    let retired = false;
    const stopping = workers.stop().then(() => {
      retired = true;
    });
    let destroyed = false;
    const closing = quota.onModuleDestroy().then(() => {
      destroyed = true;
    });
    await new Promise<void>((ok) => setImmediate(ok));
    expect(workers.snapshot()).toMatchObject({ state: 'draining', queued: 0 });
    expect(workers.snapshot().active).toBeGreaterThan(0);
    expect(retired).toBe(false);
    expect(destroyed).toBe(false);
    pending[3].resolve({ lifecycleState: 'instance_missing' });
    await Promise.all([active, stopping, closing]);
    expect(workers.snapshot()).toMatchObject({ state: 'drained', active: 0, queued: 0 });
    expect(await f.resources.snapshot()).toMatchObject({ usedCores: 2, usedRamMb: 2048 });
    expect(await f.allocations.findActiveBySandbox(asSandboxId('retiring'))).not.toBeNull();
    // The late missing result cannot mutate or publish after quota admission closed.
    expect(f.published).toHaveLength(1);
  });
});
