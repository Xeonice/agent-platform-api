import { assertDefined } from '../../support/assert-defined';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createServer, request } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProviderRegistry, SandboxHandle } from '@platform/contracts';
import { RuntimeOwnerServer } from '../../../packages/modules/sandbox/src/infrastructure/runtime-rpc/owner-server';
import { RuntimeOwnerProviderRegistry } from '../../../packages/modules/sandbox/src/infrastructure/runtime-rpc/owner-client';
import { CounterProcessProvider } from '../runtime/child-provider';
import { withRuntimeBusinessAuthority } from '../../../packages/modules/sandbox/src/infrastructure/runtime-rpc/authority-context';

const key = 'isolated-cleanup-owner-key-at-least-32-characters';
const fixtures: { close(): Promise<void> }[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
});

async function fixture(dropSecondDestroyAck = false) {
  const home = await mkdtemp(join(tmpdir(), 'project-cleanup-owner-'));
  const provider = new CounterProcessProvider(home);
  const registry: ProviderRegistry = {
    defaultProvider: provider.name,
    get: (name) => {
      if (name !== provider.name) throw new Error('Unknown fixture provider');
      return provider;
    },
    has: (name) => name === provider.name,
    list: () => [provider],
    register: () => {
      throw new Error('Fixed external fixture');
    },
  };
  const clock = { now: () => new Date() };
  const owner = new RuntimeOwnerServer({
    instanceId: 'cleanup-instance',
    ownerId: 'original-owner',
    key,
    journalPath: join(home, 'owner.sqlite'),
    clock,
    registry,
  });
  await owner.listen(0);
  const endpoint = `http://127.0.0.1:${(owner.server.address() as AddressInfo).port}`;
  const calls: string[] = [];
  let destroyPosts = 0;
  const transport = createServer(async (incoming, outgoing) => {
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    const input = body.length
      ? (JSON.parse(body.toString()) as { method?: string; fence?: { operationId: string } })
      : {};
    const lostAck = dropSecondDestroyAck && input.method === 'destroy' && ++destroyPosts === 2;
    if (input.method === 'destroy' && input.fence) calls.push(input.fence.operationId);
    const upstream = request(
      new URL(incoming.url ?? '/', endpoint),
      { method: incoming.method, headers: incoming.headers },
      async (response) => {
        if (lostAck) {
          // The real owner completes its SQLite receipt before the response is
          // deliberately lost at an external network boundary.
          for await (const _bytes of response) {
            /* Drain without delivering ACK. */
          }
          outgoing.destroy();
        } else {
          outgoing.writeHead(response.statusCode ?? 500, response.headers);
          response.pipe(outgoing);
        }
      },
    );
    upstream.once('error', () => outgoing.destroy());
    upstream.end(body);
  });
  await new Promise<void>((resolve) => transport.listen(0, '127.0.0.1', resolve));
  const client = new RuntimeOwnerProviderRegistry();
  await client.addOwner(
    {
      instanceId: 'cleanup-instance',
      key,
      endpoint: `http://127.0.0.1:${(transport.address() as AddressInfo).port}`,
      generation: 1,
      clock,
    },
    true,
  );
  const proxy = client.get(provider.name);
  const create = async (sandboxId: string) => {
    const handle = await proxy.create({
      sandboxId,
      quota: { cores: 1, ramMb: 128, diskMb: 100 },
      image: { ref: 'fixture@sha256:' + 'a'.repeat(64), digest: 'sha256:' + 'a'.repeat(64) },
      env: {},
    });
    await proxy.start(handle);
    return handle;
  };
  const f = {
    provider,
    proxy,
    owner,
    create,
    calls,
    client,
    close: async () => {
      client.onModuleDestroy();
      transport.closeAllConnections();
      await new Promise<void>((resolve) => transport.close(() => resolve()));
      await owner.close();
      await provider.close();
      await rm(home, { recursive: true, force: true });
    },
  };
  fixtures.push(f);
  return f;
}

describe('project cleanup against original RuntimeOwner durable destroy receipts', () => {
  it('returns an already completed deletion for the exact original resource without another SDK destroy/stop', async () => {
    const f = await fixture();
    const handle = await f.create('original-sandbox');
    await f.proxy.destroy(handle);
    expect(
      f.owner.journal.confirmedDestroyed(
        handle.provider,
        handle.providerSandboxId,
        'original-sandbox',
      ),
    ).toBe(true);
    expect(f.provider.destroys).toBe(1);
    expect(f.provider.stops).toBe(1);
    const before = f.owner.journal.continuity();
    await f.proxy.destroy(handle);
    expect(f.provider.destroys).toBe(1);
    expect(f.provider.stops).toBe(1);
    expect(f.owner.journal.continuity()).toMatchObject({
      assignments: [{ sandboxId: 'original-sandbox', state: 'destroyed' }],
    });
    // The newly accepted no-op remains durably queryable, without another SDK effect.
    const after = f.owner.journal.continuity() as { operations: unknown[] };
    expect(after.operations).toHaveLength(
      (before as { operations: unknown[] }).operations.length + 1,
    );
    expect(f.owner.journal.operation(assertDefined(f.calls.at(-1)))?.state).toBe('complete');
  });

  it('does not confuse absent, another provider or another sandbox with a completed exact destroy receipt', async () => {
    const f = await fixture();
    const original = await f.create('original-sandbox');
    const other = await f.create('other-sandbox');
    await f.proxy.destroy(original);
    expect(f.owner.journal.confirmedDestroyed(original.provider, original.providerSandboxId)).toBe(
      false,
    );
    expect(
      f.owner.journal.confirmedDestroyed(
        original.provider,
        original.providerSandboxId,
        'other-sandbox',
      ),
    ).toBe(false);
    expect(
      f.owner.journal.confirmedDestroyed(
        'different-provider',
        original.providerSandboxId,
        'original-sandbox',
      ),
    ).toBe(false);
    expect(
      f.owner.journal.confirmedDestroyed(
        original.provider,
        'absent-provider-id',
        'original-sandbox',
      ),
    ).toBe(false);
    const wrong: SandboxHandle = {
      ...original,
      providerState: {
        ...original.providerState,
        runtimeOwner: { ownerId: 'original-owner', sandboxId: 'other-sandbox' },
      },
    };
    await expect(f.proxy.destroy(wrong)).rejects.toThrow('Unconfirmed runtime assignment');
    expect(f.provider.destroys).toBe(1);
    expect((await f.proxy.inspect(other)).lifecycleState).toBe('instance_running');
    await f.client.releaseBusinessAuthority();
    await expect(f.proxy.destroy(original)).rejects.toThrow('fence');
    expect(f.provider.destroys).toBe(1);
  });

  it('keeps a failed or unknown provider deletion unconfirmed rather than reporting a completed tombstone', async () => {
    const f = await fixture();
    const handle = await f.create('original-sandbox');
    f.provider.destroy = async () => {
      throw new Error('Original provider result unavailable');
    };
    await expect(f.proxy.destroy(handle)).rejects.toThrow(
      'Runtime request could not be safely applied',
    );
    expect(
      f.owner.journal.confirmedDestroyed(
        handle.provider,
        handle.providerSandboxId,
        'original-sandbox',
      ),
    ).toBe(false);
    expect(f.owner.journal.assignmentBySandbox('original-sandbox')?.state).toBe('owned');
    expect(f.provider.stops).toBe(0);
  });

  it('recovers a lost exact-tombstone ACK by observing the same durable intent, with zero additional POST or SDK lifecycle effects', async () => {
    const f = await fixture(true);
    const handle = await f.create('original-sandbox');
    await f.proxy.destroy(handle);
    const accepted = {
      operationId: 'committed-project-cleanup-original-sandbox',
      actor: { kind: 'system' as const, id: 'project-deletion-cleanup' },
    };
    await expect(
      withRuntimeBusinessAuthority(accepted, () => f.proxy.destroy(handle)),
    ).rejects.toThrow();
    expect(f.calls).toHaveLength(2);
    const cleanupOperationId = assertDefined(f.calls[1]);
    expect(await f.client.active.observeOperation(cleanupOperationId)).toMatchObject({
      state: 'complete',
      result: undefined,
    });
    await withRuntimeBusinessAuthority(accepted, () => f.proxy.destroy(handle));
    expect(f.calls).toHaveLength(2);
    expect(f.provider.destroys).toBe(1);
    expect(f.provider.stops).toBe(1);
  });
});
