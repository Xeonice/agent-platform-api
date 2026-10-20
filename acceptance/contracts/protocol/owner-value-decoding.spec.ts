import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProviderRegistry } from '@platform/contracts';
import { RuntimeOwnerServer } from '../../../packages/modules/sandbox/src/infrastructure/runtime-rpc/owner-server';
import { RuntimeOwnerProviderRegistry } from '../../../packages/modules/sandbox/src/infrastructure/runtime-rpc/owner-client';
import { CounterProcessProvider } from '../../upg/runtime/child-provider';
import { assertDefined } from '../../support/assert-defined';

const fixtures: { close(): Promise<void> }[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
});

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'owner-value-decoding-'));
  const external = new CounterProcessProvider(home);
  const registry: ProviderRegistry = {
    defaultProvider: external.name,
    get: () => external,
    has: (name) => name === external.name,
    list: () => [external],
    register: () => {
      throw new Error('Fixed controlled boundary');
    },
  };
  const clock = { now: () => new Date('2026-10-18T00:00:00Z') };
  const key = 'isolated-owner-decoding-key-not-production';
  const server = new RuntimeOwnerServer({
    instanceId: 'decoding-instance',
    ownerId: 'decoding-owner',
    key,
    clock,
    registry,
    journalPath: join(home, 'owner.sqlite'),
  });
  const remote = new RuntimeOwnerProviderRegistry();
  fixtures.push({
    close: async () => {
      remote.onModuleDestroy();
      await server.close();
      await external.close();
      await rm(home, { force: true, recursive: true });
    },
  });
  await server.listen(0);
  const address = server.server.address();
  if (!address || typeof address === 'string') throw new Error('Expected owned TCP listener');
  await remote.addOwner({
    endpoint: `http://127.0.0.1:${address.port}`,
    instanceId: 'decoding-instance',
    key,
    clock,
    generation: 1,
  });
  const provider = remote.get(external.name);
  remote.pin('decoding-sandbox', remote.activeOwnerId);
  const handle = await provider.create({
    sandboxId: 'decoding-sandbox',
    quota: { cores: 1, ramMb: 128, diskMb: 100 },
    env: {},
    image: { ref: 'fixture', digest: 'sha256:' + 'a'.repeat(64) },
  });
  await provider.start(handle);
  return { server, remote, external, provider, handle };
}

describe('RuntimeOwner method payload validation over real HTTP and SQLite', () => {
  it('rejects malformed spawn input before creating an external process', async () => {
    const f = await fixture();
    await expect(
      f.remote.active.call(
        f.external.name,
        'spawn',
        [f.handle, { cmd: [42], tty: false }],
        'decoding-sandbox',
      ),
    ).rejects.toThrow();
    expect(f.external.instances.get(f.handle.providerSandboxId)?.child).toBeUndefined();
    expect(f.external.starts).toBe(1);
    expect(f.external.stops).toBe(0);
  });

  it('rejects an invalid job result instead of persisting a numeric opaque cursor', async () => {
    const f = await fixture();
    // A third-party boundary can violate its TS declaration at runtime.
    Object.defineProperty(f.external.jobs, 'readJob', {
      value: () =>
        Promise.resolve({
          stdout: '',
          stderr: '',
          cursor: 123,
          status: 'running',
        }),
    });
    await expect(
      assertDefined(f.provider.jobs).readJob(f.handle, {
        provider: f.external.name,
        jobId: 'opaque-job',
      }),
    ).rejects.toThrow();
    expect(f.external.instances.get(f.handle.providerSandboxId)?.child).toBeUndefined();
  });

  it('retains opaque job cursors, private state, raw fields and binary/null file results', async () => {
    const f = await fixture();
    const cursor = 'provider:v2:{"offset":[4,9]}';
    f.external.jobs.readJob = async () => ({ stdout: '', stderr: '', cursor, status: 'running' });
    const read = await assertDefined(f.provider.jobs).readJob(
      f.handle,
      {
        provider: f.external.name,
        jobId: 'opaque-job',
      },
      cursor,
    );
    expect(read.cursor).toBe(cursor);
    expect(f.handle.providerState?.original).toEqual({ privateOpaque: 'retained' });
    Object.defineProperty(f.external, 'inspect', {
      value: () =>
        Promise.resolve({
          lifecycleState: 'instance_running',
          raw: { futureProviderField: { value: [1, 'x', null] } },
        }),
    });
    expect((await f.provider.inspect(f.handle)).raw).toMatchObject({
      futureProviderField: { value: [1, 'x', null] },
    });
    const files = assertDefined(f.provider.files);
    const bytes = Buffer.from([0, 255, 128, 10]);
    await files.writeFile(f.handle, '/binary.dat', bytes);
    expect(await files.readFile(f.handle, '/binary.dat')).toEqual(bytes);
    expect(await files.readFile(f.handle, '/absent.dat')).toBeNull();
    expect(f.external.stops).toBe(0);
  });
});
