import 'reflect-metadata';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createServer, request } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { asSandboxId } from '@platform/shared-kernel';
import type {
  ProviderRegistry,
  RuntimeOwnerScheduling,
  RuntimeOwnerSchedulingSnapshot,
} from '@platform/contracts';
import { RuntimeOwnerProviderRegistry } from '../../../packages/modules/sandbox/src/infrastructure/runtime-rpc/owner-client';
import { RuntimeOwnerServer } from '../../../packages/modules/sandbox/src/infrastructure/runtime-rpc/owner-server';
import {
  withRuntimeBusinessAuthority,
  explicitRuntimeBusinessAuthority,
} from '../../../packages/modules/sandbox/src/infrastructure/runtime-rpc/authority-context';
import { QuotaReconciler } from '../../../packages/modules/sandbox/src/application/quota-reconciler';
import { ResourceAllocator } from '../../../packages/modules/sandbox/src/application/resource-allocator';
import { harness, ScriptedProvider, waitForStatus } from '../../support/sandbox-rig';
import { deferred } from '../../support/strict-ports';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
async function fixture(legacy = false, dropFirstCreate = false) {
  const home = await mkdtemp(join(tmpdir(), 'owner-placement-'));
  let owners = new RuntimeOwnerProviderRegistry();
  const scheduling: RuntimeOwnerScheduling = {
    snapshot: () => owners.snapshot(),
    pin: (id, owner) => owners.pin(id, owner),
    originalOwnerId: (id) => owners.originalOwnerId(id),
    assertCurrent: (o) => owners.assertCurrent(o),
  };
  const h = harness({
    ownerScheduling: scheduling,
    reservations: [
      { owner: 'auth-helper', label: 'helper', quota: { cores: 1, ramMb: 512, diskMb: 0 } },
    ],
    hostCapacity: { cores: 0.35, ramMb: 640 },
    credential: {
      runtimeId: 'claude-code',
      obtainedVia: 'setup-token',
      issuedAt: '2026-10-05T00:00:00Z',
      env: { CLAUDE_CODE_OAUTH_TOKEN: 'synthetic' },
      credentialFiles: [],
      zeroize() {},
    },
    authority: { run: withRuntimeBusinessAuthority, current: explicitRuntimeBusinessAuthority },
  });
  h.sqlite
    .prepare(
      "INSERT INTO projects(id,name,source_type,clone_status,baseline_path,created_at,updated_at) VALUES('prj-1','fixture','empty','ready','/tmp/fixture',0,0)",
    )
    .run();
  const key = 'fixture-owner-placement-private-key-only';
  const next = new ScriptedProvider();
  const servers: RuntimeOwnerServer[] = [];
  const origins = new Map<RuntimeOwnerServer, string>();
  const proxies: ReturnType<typeof createServer>[] = [];
  let droppedOperationId: string | undefined;
  let createPosts = 0;
  for (const [id, provider] of [
    ['old', h.provider],
    ['new', next],
  ] as const) {
    const registry: ProviderRegistry = {
      defaultProvider: provider.name,
      get: () => provider,
      has: () => true,
      list: () => [provider],
      register() {
        throw new Error('fixed');
      },
    };
    const server = new RuntimeOwnerServer({
      instanceId: 'placement-fixture',
      ownerId: id,
      key,
      journalPath: join(home, id + '.sqlite'),
      registry,
      clock: h.clock,
      startIdentity: id + '-physical-start-identity',
      artifactIdentity: {
        artifactDigest: 'sha256:' + 'a'.repeat(64),
        inputFingerprint: 'sha256:' + 'b'.repeat(64),
      },
      capacity:
        legacy && id === 'old'
          ? undefined
          : async () => ({
              cores: 4,
              ramMb: 8192,
              diskTotalBytes: 128 * 1024 ** 3,
              diskAvailableBytes: 100 * 1024 ** 3,
            }),
    });
    await server.listen(0);
    servers.push(server);
    const origin = `http://127.0.0.1:${(server.server.address() as AddressInfo).port}`;
    if (dropFirstCreate && id === 'old') {
      const proxy = createServer(async (incoming, response) => {
        if (incoming.method === 'POST' && incoming.url === '/runtime/call') {
          const chunks: Buffer[] = [];
          for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
          const body = Buffer.concat(chunks);
          const call = JSON.parse(body.toString()) as {
            method: string;
            fence: { operationId: string };
          };
          if (call.method === 'create' && createPosts++ === 0) {
            droppedOperationId = call.fence.operationId;
            response.destroy();
            return;
          }
          const upstream = request(
            new URL(incoming.url, origin),
            { method: incoming.method, headers: incoming.headers },
            (result) => {
              response.writeHead(result.statusCode ?? 502, result.headers);
              result.pipe(response);
            },
          );
          upstream.on('error', () => response.destroy());
          upstream.end(body);
          return;
        }
        const upstream = request(
          new URL(incoming.url ?? '/', origin),
          { method: incoming.method, headers: incoming.headers },
          (result) => {
            response.writeHead(result.statusCode ?? 502, result.headers);
            result.pipe(response);
          },
        );
        upstream.on('error', () => response.destroy());
        incoming.pipe(upstream);
      });
      await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
      proxies.push(proxy);
      origins.set(server, `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`);
    } else origins.set(server, origin);
  }
  const clients: RuntimeOwnerProviderRegistry[] = [];
  const connect = async (deferClaim = false, generation = 1) => {
    const registry = new RuntimeOwnerProviderRegistry();
    for (const server of servers)
      await registry.addOwner(
        {
          instanceId: 'placement-fixture',
          key,
          clock: h.clock,
          generation,
          deferClaim,
          endpoint:
            origins.get(server) ??
            (() => {
              throw new Error('missing fixture origin');
            })(),
        },
        false,
      );
    clients.push(registry);
    return registry;
  };
  owners = await connect();
  h.registry.get = (name) => owners.get(name);
  h.registry.list = () => owners.list();
  h.registry.has = (name) => owners.has(name);
  cleanups.push(async () => {
    for (const client of clients) client.onModuleDestroy();
    for (const proxy of proxies) {
      proxy.closeAllConnections();
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    }
    for (const server of servers) await server.close();
    await rm(home, { recursive: true, force: true });
  });
  return {
    h,
    next,
    servers,
    get owners() {
      return owners;
    },
    helperTransport: () => ({ operationId: droppedOperationId, createPosts }),
    rebuildAuthority: async () => {
      h.advanceClock(31000);
      const rebuilt = await connect(false, 2);
      rebuilt.activateOwner('new');
      return rebuilt;
    },
    restart: async () => {
      const reopened = await connect(true);
      reopened.activateOwner('new');
      return reopened;
    },
  };
}

describe('Owner-pinned admission with real HTTP, Owner journals and business SQLite', () => {
  it('uses Owner capacity despite a tiny Coordinator and keeps the T1 Owner after default switches [AC-UPG-006.5]', async () => {
    const f = await fixture();
    const entered = deferred<void>(),
      release = deferred<void>();
    const prepare = f.h.workspace.prepare.bind(f.h.workspace);
    f.h.workspace.prepare = async (...args) => {
      entered.resolve();
      await release.promise;
      return prepare(...args);
    };
    const task = await f.h.service.create({ projectId: 'prj-1', runtime: 'claude-code' });
    await entered.promise;
    const pending = await f.h.repo.findById(asSandboxId(task.id));
    expect(pending?.providerSandboxId).toBeNull();
    expect(pending?.providerState).toEqual({ runtimeOwnerPlacement: { ownerId: 'old' } });
    expect(pending?.providerState).not.toHaveProperty('runtimeOwner');
    expect((await f.h.allocations.findActiveBySandbox(asSandboxId(task.id)))?.nodeId).toBe('local');
    f.owners.activateOwner('new');
    release.resolve();
    await waitForStatus(f.h.service, task.id, 'running');
    expect(f.servers[0].journal.assignments().find((row) => row.sandboxId === task.id)?.state).toBe(
      'owned',
    );
    expect(f.servers[1].journal.assignments()).toEqual([]);
    const bound = await f.h.repo.findById(asSandboxId(task.id));
    expect(bound?.providerState).not.toHaveProperty('runtimeOwnerPlacement');
    expect(bound?.providerState?.runtimeOwner).toEqual({ ownerId: 'old', sandboxId: task.id });
    expect(f.h.provider.calls.filter((call) => call === 'create')).toHaveLength(1);
    expect(f.next.calls).toEqual([]);
    // Global task count is not silently reduced to the new Owner's empty pool.
    expect(
      (await f.h.resources.defaultCapacity({ cores: 1, ramMb: 512, diskMb: 512 })).registeredTasks,
    ).toBe(1);
  });
  it('reconstructs a pre-intent T1 placement on restart and never overwrites its Owner [AC-UPG-007.3]', async () => {
    const f = await fixture();
    const entered = deferred<void>(),
      release = deferred<void>();
    const prepare = f.h.workspace.prepare.bind(f.h.workspace);
    f.h.workspace.prepare = async (...args) => {
      entered.resolve();
      await release.promise;
      return prepare(...args);
    };
    const task = await f.h.service.create({ projectId: 'prj-1', runtime: 'claude-code' });
    await entered.promise;
    const reopened = await f.restart();
    // A restarted allocator reads the existing row; it neither reallocates nor asks active capacity.
    const recovered = new ResourceAllocator(
      f.h.allocations,
      {
        capacity: async () => {
          throw new Error('must not probe Coor');
        },
      },
      f.h.uow,
      f.h.clock,
      {
        next: () => {
          throw new Error('must not allocate');
        },
      },
      f.h.schedulerQueue,
      [],
      reopened,
      f.h.repo,
    );
    await recovered.pinReservedOwner(asSandboxId(task.id));
    expect(reopened.originalOwnerId(task.id)).toBe('old');
    expect(() => reopened.pin(task.id, 'new')).toThrow();
    release.resolve();
    await waitForStatus(f.h.service, task.id, 'running');
    expect(f.servers[1].journal.assignments()).toEqual([]);
  });
  it('rejects an obsolete selection rather than reserving under a different default [AC-UPG-006.5]', async () => {
    const f = await fixture();
    const observed: RuntimeOwnerSchedulingSnapshot = await f.owners.snapshot();
    f.owners.activateOwner('new');
    expect(() => f.owners.assertCurrent(observed)).toThrow();
    expect(f.h.sqlite.prepare('SELECT count(*) n FROM resource_allocations').get()).toEqual({
      n: 0,
    });
  });
  it('charges retained CPU/RAM to its Owner but shared disk to every active pool [AC-UPG-006.5]', async () => {
    const f = await fixture();
    const task = await f.h.service.create({ projectId: 'prj-1', runtime: 'claude-code' });
    await waitForStatus(f.h.service, task.id, 'running');
    f.owners.activateOwner('new');
    // Historical quotas are deliberately larger than the new pool. They stay
    // charged to the original Owner, while the shared volume remains global.
    f.h.sqlite
      .prepare(
        'UPDATE resource_allocations SET cores_reserved=4,ram_mb_reserved=8000,node_id=? WHERE sandbox_id=?',
      )
      .run('local', task.id);
    expect(await f.h.resources.probe({ cores: 2, ramMb: 2048, diskMb: 512 })).toEqual({ ok: true });
    f.h.sqlite
      .prepare('UPDATE resource_allocations SET disk_mb_reserved=110900 WHERE sandbox_id=?')
      .run(task.id);
    const verdict = await f.h.resources.probe({ cores: 2, ramMb: 2048, diskMb: 1024 });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toContain('disk capacity');
    expect((await f.h.allocations.findActiveBySandbox(asSandboxId(task.id)))?.nodeId).toBe('local');
  });
  it('HOLDs new admission for an Owner-only Guest without making its existing handle unusable [AC-UPG-007.3]', async () => {
    const f = await fixture();
    const task = await f.h.service.create({ projectId: 'prj-1', runtime: 'claude-code' });
    await waitForStatus(f.h.service, task.id, 'running');
    f.owners.activateOwner('new');
    const sandbox = await f.h.repo.findById(asSandboxId(task.id));
    if (!sandbox?.providerSandboxId) throw new Error('missing actual handle');
    const handle = {
      provider: sandbox.provider,
      providerSandboxId: sandbox.providerSandboxId,
      providerState: sandbox.providerState ?? undefined,
    };
    f.h.sqlite.prepare('DELETE FROM resource_allocations WHERE sandbox_id=?').run(task.id);
    await expect(f.h.resources.probe({ cores: 1, ramMb: 512, diskMb: 512 })).rejects.toThrow(
      'no active quota',
    );
    expect((await f.owners.get(sandbox.provider).inspect(handle)).lifecycleState).toBe(
      'instance_running',
    );
    await f.h.resources.pinOriginalOwnerForLookup(asSandboxId(task.id));
    await expect(f.h.resources.pinReservedOwner(asSandboxId(task.id))).rejects.toThrow(
      'durable allocation is missing',
    );
    expect(f.next.calls).toEqual([]);
  });
  it('HOLDs a pre-intent legacy unknown placement instead of assigning the active Owner [AC-UPG-007.3]', async () => {
    const f = await fixture();
    const entered = deferred<void>(),
      release = deferred<void>();
    const prepare = f.h.workspace.prepare.bind(f.h.workspace);
    f.h.workspace.prepare = async (...args) => {
      entered.resolve();
      await release.promise;
      return prepare(...args);
    };
    const task = await f.h.service.create({ projectId: 'prj-1', runtime: 'claude-code' });
    await entered.promise;
    f.h.sqlite.prepare('UPDATE sandboxes SET provider_state=NULL WHERE id=?').run(task.id);
    f.owners.activateOwner('new');
    await expect(f.h.resources.probe({ cores: 1, ramMb: 512, diskMb: 512 })).rejects.toThrow(
      'unknown or conflicting',
    );
    const reopened = await f.restart();
    const recovered = new ResourceAllocator(
      f.h.allocations,
      {
        capacity: async () => {
          throw new Error('no Coor fallback');
        },
      },
      f.h.uow,
      f.h.clock,
      {
        next: () => {
          throw new Error('no replacement');
        },
      },
      f.h.schedulerQueue,
      [],
      reopened,
      f.h.repo,
    );
    await expect(recovered.pinReservedOwner(asSandboxId(task.id))).rejects.toThrow(
      'legacy original Owner is unknown',
    );
    await f.h.provision.resumeUnconfirmed();
    expect(f.servers.flatMap((server) => server.journal.assignments())).toEqual([]);
    expect((await f.h.allocations.findActiveBySandbox(asSandboxId(task.id)))?.nodeId).toBe('local');
    expect(f.next.calls).toEqual([]);
    // Dispose only this still-live fixture workflow after the assertions. A real
    // crashed Coordinator has no remaining continuation to release.
    const cancelled = f.h.provision.cancel(task.id);
    release.resolve();
    await cancelled;
  });

  it('reconciles new and retained Owner allocations across retained and new Owner pools [AC-UPG-007.3]', async () => {
    const f = await fixture();
    const first = await f.h.service.create({ projectId: 'prj-1', runtime: 'claude-code' });
    await waitForStatus(f.h.service, first.id, 'running');
    f.owners.activateOwner('new');
    const second = await f.h.service.create({ projectId: 'prj-1', runtime: 'claude-code' });
    await waitForStatus(f.h.service, second.id, 'running');
    // Include a legacy local record with a genuine retained handle.
    f.h.sqlite
      .prepare('UPDATE resource_allocations SET node_id=? WHERE sandbox_id=?')
      .run('local', first.id);
    const reconcile = new QuotaReconciler(
      f.h.allocations,
      f.h.repo,
      f.h.registry,
      f.h.events,
      f.h.clock,
      f.h.resources,
    );
    expect(await reconcile.reconcile()).toEqual({ scanned: 2, confirmed: 2, orphaned: 0 });
    f.h.advanceClock(31 * 60 * 1000);
    expect(await reconcile.reconcileIncremental()).toEqual({
      scanned: 2,
      confirmed: 2,
      orphaned: 0,
    });
    expect((await f.h.allocations.listActiveAll()).map((row) => row.nodeId)).toEqual([
      'local',
      'local',
    ]);
  });
  it('reserves the real retained helper only in its actual Owner pool [AC-UPG-006.5]', async () => {
    const f = await fixture();
    const context = {
      sandboxId: 'auth-helper',
      quota: { cores: 1, ramMb: 512, diskMb: 2048 },
      image: { ref: 'fixture', digest: 'sha256:' + 'a'.repeat(64) },
      env: {},
    };
    const original = await f.owners.get('aio').create(context);
    expect((await f.owners.snapshot()).helperOwnerId).toBe('old');
    expect((await f.h.resources.snapshot()).totalCores).toBeCloseTo(4 * 0.85 * 1.5 - 1);
    f.owners.activateOwner('new');
    expect((await f.owners.snapshot()).helperOwnerId).toBe('old');
    expect((await f.h.resources.snapshot()).totalCores).toBeCloseTo(4 * 0.85 * 1.5);
    expect(await f.h.allocations.listActiveAll()).toEqual([]);
    expect(await f.owners.get('aio').create(context)).toEqual(original);
    expect(f.h.provider.calls.filter((call) => call === 'create')).toHaveLength(1);
    expect(f.next.calls).toEqual([]);
  });
  it('keeps old Owner operations available when only the new capacity endpoint is missing [AC-UPG-006.5]', async () => {
    const f = await fixture(true);
    const provider = f.owners.get('aio');
    f.owners.pin('retained-task', 'old');
    const handle = await provider.create({
      sandboxId: 'retained-task',
      quota: { cores: 1, ramMb: 512, diskMb: 512 },
      image: { ref: 'fixture', digest: 'sha256:' + 'a'.repeat(64) },
      env: {},
    });
    await provider.start(handle);
    await expect(
      f.h.service.create({ projectId: 'prj-1', runtime: 'claude-code' }),
    ).rejects.toThrow('Runtime operation result is not confirmed');
    expect((await provider.inspect(handle)).lifecycleState).toBe('instance_running');
    expect(f.h.provider.calls.filter((call) => call === 'create')).toHaveLength(1);
    expect(await f.h.allocations.listActiveAll()).toEqual([]);
    expect(f.next.calls).toEqual([]);
  });

  it('does not retain an in-memory Owner pin when T1 rolls back before any create [AC-UPG-007.3]', async () => {
    const f = await fixture();
    const id = asSandboxId('rolled-back-task');
    await expect(
      f.h.resources.reserve({ sandboxId: id, quota: { cores: 1, ramMb: 512, diskMb: 512 } }, () => {
        throw new Error('fixture T1 rollback');
      }),
    ).rejects.toThrow('fixture T1 rollback');
    expect(f.owners.originalOwnerId(id)).toBeUndefined();
    expect(await f.h.allocations.findActiveBySandbox(id)).toBeNull();
    f.owners.activateOwner('new');
    // No effect was dispatched, so the failed transaction leaves no stale
    // placement that would conflict with a later newly accepted transaction.
    expect(() => f.owners.pin(id, 'new')).not.toThrow();
    expect(f.servers.flatMap((server) => server.journal.assignments())).toEqual([]);
  });
  it('HOLDs an unknown helper pinned before Owner.begin and fences the old actor when rebuilding [AC-UPG-007.3]', async () => {
    const f = await fixture(false, true);
    const original = f.owners.get('aio');
    const context = {
      sandboxId: 'auth-helper',
      quota: { cores: 1, ramMb: 512, diskMb: 2048 },
      image: { ref: 'fixture', digest: 'sha256:' + 'a'.repeat(64) },
      env: {},
    };
    await expect(original.create(context)).rejects.toThrow();
    const unknown = f.helperTransport();
    if (!unknown.operationId) throw new Error('missing original transport identity');
    expect(f.servers.flatMap((server) => server.journal.assignments())).toEqual([]);
    f.owners.activateOwner('new');
    await expect(f.owners.snapshot()).rejects.toThrow();
    await expect(f.h.resources.probe({ cores: 1, ramMb: 512, diskMb: 512 })).rejects.toThrow();
    expect(await f.owners.connection('old').observeOperation(unknown.operationId)).toEqual({
      state: 'absent',
    });
    expect(f.helperTransport().createPosts).toBe(1);
    expect(f.next.calls).toEqual([]);
    await expect(original.create(context)).rejects.toThrow(
      'Runtime operation result is not confirmed',
    );
    expect(f.helperTransport().createPosts).toBe(1);
    const rebuilt = await f.rebuildAuthority();
    expect(f.servers.map((server) => server.journal.lease()?.generation)).toEqual([2, 2]);
    expect((await rebuilt.snapshot()).helperOwnerId).toBe('new');
    await expect(original.create(context)).rejects.toThrow(
      'Runtime operation result is not confirmed',
    );
    expect(f.helperTransport().createPosts).toBe(1);
    // The actual Owner also fences the previous actor, independently of the
    // provider's read-only unknown-result guard.
    await expect(
      f.owners.connection('old').call('aio', 'create', [context], 'auth-helper'),
    ).rejects.toThrow('fence');
    expect(f.servers.flatMap((server) => server.journal.assignments())).toEqual([]);
    await rebuilt.get('aio').create(context);
    expect(f.servers[0].journal.assignments()).toEqual([]);
    expect(
      f.servers[1].journal.assignments().find((row) => row.sandboxId === 'auth-helper')?.state,
    ).toBe('owned');
  });
});
