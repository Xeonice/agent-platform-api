import { assertDefined } from '../../support/assert-defined';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { Clock } from '@platform/shared-kernel';
import type { ProviderRegistry, SandboxHandle } from '@platform/contracts';
import { RuntimeOwnerServer } from '../../../packages/modules/sandbox/src/infrastructure/runtime-rpc/owner-server';
import { RuntimeOwnerProviderRegistry } from '../../../packages/modules/sandbox/src/infrastructure/runtime-rpc/owner-client';
import { withRuntimeBusinessAuthority } from '../../../packages/modules/sandbox/src/infrastructure/runtime-rpc/authority-context';
import { CounterProcessProvider } from '../runtime/child-provider';

const key = 'isolated-coordinator-key-not-a-production-key';
const contexts: { close(): Promise<void> }[] = [];
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'upg-owner-protocol-'));
  let time = Date.now();
  const clock: Clock = { now: () => new Date(time) };
  const external = new CounterProcessProvider(home);
  const providers: ProviderRegistry = {
    defaultProvider: external.name,
    get: (name) => {
      if (name !== external.name) throw new Error('Unknown provider');
      return external;
    },
    has: (name) => name === external.name,
    list: () => [external],
    register: () => {
      throw new Error('Fixed external resource fixture');
    },
  };
  const server = new RuntimeOwnerServer({
    instanceId: 'isolated-instance',
    ownerId: 'original-owner',
    key,
    journalPath: join(home, 'owner.sqlite'),
    registry: providers,
    clock,
  });
  const requests: { method: string; path: string }[] = [];
  server.server.on('request', (request) =>
    requests.push({
      method: request.method ?? '',
      path: new URL(request.url ?? '/', 'http://127.0.0.1').pathname,
    }),
  );
  await server.listen(0);
  const endpoint = `http://127.0.0.1:${(server.server.address() as AddressInfo).port}`;
  const clients: RuntimeOwnerProviderRegistry[] = [];
  const client = async (generation = 1) => {
    const registry = new RuntimeOwnerProviderRegistry();
    await registry.addOwner(
      { endpoint, key, instanceId: 'isolated-instance', generation, clock },
      true,
    );
    clients.push(registry);
    return registry;
  };
  const ctx = {
    server,
    requests,
    external,
    endpoint,
    clock,
    client,
    advance: (ms: number) => {
      time += ms;
    },
    close: async () => {
      for (const c of clients) c.onModuleDestroy();
      await server.close();
      await external.close();
      await rm(home, { recursive: true, force: true });
    },
  };
  contexts.push(ctx);
  return ctx;
}
async function sandbox(registry: RuntimeOwnerProviderRegistry) {
  const provider = registry.get('counter-process');
  const handle = await provider.create({
    sandboxId: 'original-sandbox',
    quota: { cores: 1, ramMb: 128, diskMb: 100 },
    image: { ref: 'fixture@sha256:' + 'a'.repeat(64), digest: 'sha256:' + 'a'.repeat(64) },
    env: {},
  });
  await provider.start(handle);
  return { provider, handle };
}
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.close();
});

describe('RuntimeOwner real socket, durable SQLite and external process boundary', () => {
  it('preloads a read-only coordinator and transfers authority without replacing the original process [AC-UPG-006.5]', async () => {
    const f = await fixture(),
      old = await f.client();
    const { provider, handle } = await sandbox(old);
    const job = await withRuntimeBusinessAuthority(
      { operationId: 'original-persisted-run', actor: { kind: 'user', id: 'test-viewer' } },
      () => assertDefined(provider.jobs).startJob(handle, { cmd: [] }),
    );
    const original = f.external.instances.get(handle.providerSandboxId)?.child?.pid;
    const prepared = new RuntimeOwnerProviderRegistry();
    await prepared.addOwner(
      {
        endpoint: f.endpoint,
        key,
        instanceId: 'isolated-instance',
        generation: 1,
        clock: f.clock,
        deferClaim: true,
      },
      true,
    );
    try {
      const before = f.server.journal.lease();
      expect((await prepared.get('counter-process').inspect(handle)).lifecycleState).toBe(
        'instance_running',
      );
      await expect(prepared.get('counter-process').stop(handle)).rejects.toThrow(
        'Prepared coordinator',
      );
      expect(f.server.journal.lease()).toEqual(before);
      await old.releaseBusinessAuthority();
      await prepared.activateBusinessAuthority(2);
      expect((await prepared.get('counter-process').inspect(handle)).lifecycleState).toBe(
        'instance_running',
      );
      await expect(provider.stop(handle)).rejects.toThrow('fence');
      expect(f.external.instances.get(handle.providerSandboxId)?.child?.pid).toBe(original);
      expect(f.external.stops).toBe(0);
      expect(f.external.starts).toBe(1);
      expect(
        (await assertDefined(prepared.get('counter-process').jobs).readJob(handle, job)).status,
      ).toBe('running');
    } finally {
      prepared.onModuleDestroy();
    }
  });
  it('retains an uncertain create reservation and never blindly creates a replacement [AC-UPG-007.3]', async () => {
    const f = await fixture();
    const create = f.external.create.bind(f.external);
    f.external.create = async (context) => {
      await create(context);
      throw new Error('The external effect completed but its result was lost');
    };
    const registry = await f.client();
    const provider = registry.get('counter-process');
    const context = {
      sandboxId: 'uncertain-sandbox',
      quota: { cores: 1, ramMb: 128, diskMb: 100 },
      image: { ref: 'fixture@sha256:' + 'a'.repeat(64), digest: 'sha256:' + 'a'.repeat(64) },
      env: {},
    };
    await expect(provider.create(context)).rejects.toThrow();
    const dispatches = f.requests.filter(
      (row) => row.method === 'POST' && row.path === '/runtime/call',
    ).length;
    await expect(provider.create(context)).rejects.toThrow('unconfirmed');
    expect(
      f.requests.filter((row) => row.method === 'POST' && row.path === '/runtime/call'),
    ).toHaveLength(dispatches);
    expect(
      f.requests.some((row) => row.method === 'GET' && row.path.startsWith('/runtime/operations/')),
    ).toBe(true);
    expect(f.external.creates).toBe(1);
    expect(f.server.journal.assignments()).toEqual([
      {
        sandboxId: 'uncertain-sandbox',
        provider: 'counter-process',
        providerSandboxId: '',
        state: 'unconfirmed',
      },
    ]);
    expect(f.external.destroys).toBe(0);
  });
  it('rejects controller credentials and another instance before any resource action [AC-UPG-006.5]', async () => {
    const f = await fixture();
    const rejected = await fetch(f.endpoint + '/runtime/metadata', {
      headers: {
        'x-platform-internal-key': 'controller-key-is-never-an-owner-business-key',
        'x-platform-instance-id': 'isolated-instance',
      },
    });
    expect(rejected.status).toBe(403);
    const wrong = await fetch(f.endpoint + '/runtime/metadata', {
      headers: { 'x-platform-internal-key': key, 'x-platform-instance-id': 'other-instance' },
    });
    expect(wrong.status).toBe(403);
    expect(f.external.creates).toBe(0);
    expect(f.external.stops).toBe(0);
  });

  it('keeps original process alive when an observation transport detaches and reattaches [AC-UPG-001.1] [AC-UPG-003.5]', async () => {
    const f = await fixture();
    const registry = await f.client();
    const { provider, handle } = await sandbox(registry);
    const first = await provider.spawn(handle, { cmd: [], tty: false });
    let received = '';
    first.onData((bytes) => {
      received += bytes.toString();
    });
    await expect.poll(() => received).toContain('SEQ 3');
    const pid = f.external.instances.get(handle.providerSandboxId)?.child?.pid;
    first.detach();
    const before = f.external.instances.get(handle.providerSandboxId)?.output.length ?? 0;
    await expect
      .poll(() => f.external.instances.get(handle.providerSandboxId)?.output.length ?? 0)
      .toBeGreaterThan(before + 2);
    const restored = await provider.spawn(handle, { cmd: [], tty: false, reuse: first.ref });
    let resumed = '';
    restored.onData((bytes) => {
      resumed += bytes.toString();
    });
    await expect.poll(() => resumed).toContain('SEQ');
    expect(restored.ref).toBe(first.ref);
    expect((await provider.inspect(handle)).raw).toEqual({ pid, runtimeIdentity: null });
    expect(f.external.creates).toBe(1);
    expect(f.external.stops).toBe(0);
    expect(f.external.destroys).toBe(0);
    restored.detach();
  });

  it('round-trips binary files and real streaming bytes through the owner [AC-UPG-008.3]', async () => {
    const f = await fixture();
    const registry = await f.client();
    const { provider, handle } = await sandbox(registry);
    const bytes = Buffer.from(Array.from({ length: 65536 }, (_, i) => i % 256));
    await assertDefined(provider.files).writeFile(handle, '/artifact.bin', bytes);
    expect(await assertDefined(provider.files).readFile(handle, '/artifact.bin')).toEqual(bytes);
    const stream = await assertDefined(provider.files).openFileStream(handle, '/artifact.bin');
    expect(stream).not.toBeNull();
    const chunks: Buffer[] = [];
    for await (const chunk of assertDefined(stream))
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
    expect(Buffer.concat(chunks)).toEqual(bytes);
    expect(await assertDefined(provider.files).readFile(handle, '/missing')).toBeNull();
    expect(await assertDefined(provider.files).openFileStream(handle, '/missing')).toBeNull();
  });

  it('persists a run intent and returns its original job for duplicate delivery [AC-UPG-001.2] [AC-UPG-006.5]', async () => {
    const f = await fixture();
    const registry = await f.client();
    const { provider, handle } = await sandbox(registry);
    await expect(assertDefined(provider.jobs).startJob(handle, { cmd: [] })).rejects.toThrow(
      'persisted run intent',
    );
    const execute = () =>
      withRuntimeBusinessAuthority(
        { operationId: 'persisted-run-id', actor: { kind: 'automation', id: 'occurrence-1' } },
        () => assertDefined(provider.jobs).startJob(handle, { cmd: [] }),
      );
    const first = await execute();
    const dispatches = f.requests.filter(
      (row) => row.method === 'POST' && row.path === '/runtime/call',
    ).length;
    const duplicate = await execute();
    expect(
      f.requests.filter((row) => row.method === 'POST' && row.path === '/runtime/call'),
    ).toHaveLength(dispatches);
    expect(duplicate).toEqual(first);
    expect(f.external.jobsStarted).toBe(1);
    const chunk = await assertDefined(provider.jobs).readJob(handle, first);
    expect(chunk.status).toBe('running');
    expect(f.external.stops).toBe(0);
  });

  it('fences a stale coordinator without stopping or falsely releasing its original resource [AC-UPG-006.5] [AC-UPG-007.3]', async () => {
    const f = await fixture();
    const old = await f.client();
    const { provider, handle } = await sandbox(old);
    const stream = await provider.spawn(handle, { cmd: [], tty: false });
    let output = '';
    stream.onData((bytes) => {
      output += bytes.toString();
    });
    await expect.poll(() => output).toContain('SEQ 2');
    await expect(f.client(2)).rejects.toThrow('authoritative coordinator');
    f.advance(31000);
    const current = await f.client(2);
    await expect(provider.stop(handle)).rejects.toThrow('fence');
    expect((await current.get('counter-process').inspect(handle)).lifecycleState).toBe(
      'instance_running',
    );
    expect(f.external.stops).toBe(0);
    expect(f.server.journal.assignments()).toEqual([
      {
        sandboxId: 'original-sandbox',
        provider: 'counter-process',
        providerSandboxId: handle.providerSandboxId,
        state: 'owned',
      },
    ]);
    stream.detach();
  });

  it('refuses an unconfirmed handle and cannot activate a stopped resource during observation [AC-UPG-001.5]', async () => {
    const f = await fixture();
    const registry = await f.client();
    const { provider, handle } = await sandbox(registry);
    await provider.stop(handle);
    const starts = f.external.starts;
    expect((await provider.inspect(handle)).lifecycleState).toBe('instance_exited');
    await expect(provider.spawn(handle, { cmd: [], tty: true })).rejects.toThrow(
      'attach is deferred',
    );
    expect(f.external.starts).toBe(starts);
    const foreign: SandboxHandle = { ...handle, providerSandboxId: 'unowned-resource' };
    await expect(provider.inspect(foreign)).rejects.toThrow('assignment');
    expect(f.external.destroys).toBe(0);
  });
});
