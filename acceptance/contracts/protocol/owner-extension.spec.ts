import { assertDefined } from '../../support/assert-defined';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer, type AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { RuntimeOwnerMetadata } from '@platform/contracts';
import { SystemClock } from '../../../apps/api/src/platform/time/system-clock';
import { RuntimeOwnerProviderRegistry } from '../../../packages/modules/sandbox/src/infrastructure/runtime-rpc/owner-client';
import { useEnv } from '../../support/strict-ports';

const apiRoot = resolve('.');
const key = 'contract-owner-isolated-internal-key-32-characters';
const instanceId = 'contract-owner-installation';
const resources: { close(): Promise<void> }[] = [];

async function startOwner(
  ownerId: string,
  patch: NodeJS.ProcessEnv = {},
  main = false,
  existingHome?: string,
) {
  const home = existingHome ?? (await mkdtemp(join(tmpdir(), 'contract-owner-extension-')));
  const endpointPort = main ? await unusedPort() : 0;
  const args = main
    ? [join(apiRoot, 'apps/api/dist/roles/runtime-owner-main.js')]
    : [join(apiRoot, 'acceptance/contracts/runtime/owner-extension-child.mjs'), apiRoot];
  const child = spawn(process.execPath, args, {
    cwd: apiRoot,
    env: {
      PATH: process.env.PATH,
      NODE_ENV: 'test',
      PLATFORM_PROCESS_ROLE: 'runtime-owner',
      PLATFORM_INSTANCE_ID: instanceId,
      PLATFORM_COORDINATOR_RPC_KEY: key,
      PLATFORM_PROCESS_START_IDENTITY: `start-${ownerId}`,
      RUNTIME_OWNER_ID: ownerId,
      RUNTIME_OWNER_HOME: home,
      BOXLITE_HOME: join(home, 'sdk'),
      RUNTIME_OWNER_PORT: String(endpointPort),
      SANDBOX_DEFAULT_PROVIDER: 'boxlite',
      ...patch,
    },
    stdio: 'pipe',
  });
  const exited = new Promise<number | null>((ok, fail) => {
    child.once('exit', ok);
    child.once('error', fail);
  });
  let output = '';
  let errors = '';
  const ready = new Promise<string>((ok, fail) => {
    const deadline = setTimeout(() => fail(new Error(`Owner startup timed out: ${errors}`)), 10000);
    child.stderr.on('data', (bytes) => {
      errors += String(bytes);
    });
    child.stdout.on('data', (bytes) => {
      output += String(bytes);
      const match = /OWNER_READY:(\{[^\n]+\})/.exec(output);
      if (match) {
        const address = JSON.parse(assertDefined(match[1])) as { endpoint: string };
        clearTimeout(deadline);
        ok(address.endpoint);
      } else if (main && output.includes('RuntimeOwner ready (')) {
        clearTimeout(deadline);
        ok(`http://127.0.0.1:${endpointPort}`);
      }
    });
    child.once('exit', (code) => {
      clearTimeout(deadline);
      fail(new Error(`Owner rejected (${code}): ${output || errors}`));
    });
    child.once('error', (error) => {
      clearTimeout(deadline);
      fail(error);
    });
  });
  resources.push({
    close: async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      await exited;
      if (!existingHome) await rm(home, { recursive: true, force: true });
    },
  });
  return { child, home, ready, exited, output: () => output };
}

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((ok, fail) => server.close((error) => (error ? fail(error) : ok())));
  return port;
}
async function metadata(endpoint: string): Promise<RuntimeOwnerMetadata> {
  const response = await fetch(endpoint + '/runtime/metadata', {
    headers: { 'x-platform-internal-key': key, 'x-platform-instance-id': instanceId },
  });
  expect(response.status).toBe(200);
  return response.json() as Promise<RuntimeOwnerMetadata>;
}
async function directory(endpoint: string): Promise<RuntimeOwnerProviderRegistry> {
  const registry = new RuntimeOwnerProviderRegistry();
  resources.push({ close: async () => registry.onModuleDestroy() });
  await registry.addOwner(
    { endpoint, key, instanceId, generation: 1, clock: new SystemClock() },
    true,
  );
  return registry;
}
const context = (sandboxId: string) => ({
  sandboxId,
  quota: { cores: 1, ramMb: 128, diskMb: 100 },
  image: { ref: 'fixture@sha256:' + 'a'.repeat(64), digest: 'sha256:' + 'a'.repeat(64) },
  env: {},
});
afterEach(async () => {
  for (const resource of resources.splice(0).reverse()) await resource.close();
});

describe('production Owner composition and out-of-tree DI registration', () => {
  it('starts the actual compiled role main with the independent Owner module and no business database', async () => {
    const owner = await startOwner('builtin-main', {}, true);
    const actual = await metadata(await owner.ready);
    expect(actual.role).toBe('runtime-owner');
    expect(actual.pid).toBe(owner.child.pid);
    expect(actual.databaseScope).toBe('owner-private');
    expect(actual.noBusinessDatabaseAccess).toBe(true);
    expect(actual.providers.map((provider) => provider.name).sort()).toEqual(['aio', 'boxlite']);
    expect(actual.defaultProvider).toBe('boxlite');
    expect((await stat(join(owner.home, 'runtime-owner.sqlite'))).isFile()).toBe(true);
    await expect(stat(join(owner.home, 'sdk'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('finishes third-party async DI registration before listening and uses it through the real Coordinator proxy', async () => {
    const owner = await startOwner('third-party');
    const endpoint = await owner.ready;
    const actual = await metadata(endpoint);
    expect(actual.providers.map((provider) => provider.name).sort()).toEqual([
      'aio',
      'boxlite',
      'installation-provider',
    ]);
    expect(actual.defaultProvider).toBe('installation-provider');
    const constructors = (await readFile(join(owner.home, 'provider-constructions.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { pid: number; role: string });
    expect(constructors).toEqual([{ pid: owner.child.pid, role: 'runtime-owner' }]);
    expect(owner.child.pid).not.toBe(process.pid);
    const restore = useEnv({
      PLATFORM_PROCESS_ROLE: 'coordinator',
      COORDINATOR_WRITER_FENCE_VALID: 'true',
    });
    try {
      const registry = await directory(endpoint);
      expect(registry.defaultProvider).toBe('installation-provider');
      expect(registry.list().map((provider) => provider.name)).toContain('installation-provider');
      const provider = registry.get('installation-provider');
      const handle = await provider.create(context('first-task'));
      await provider.start(handle);
      expect(await provider.inspect(handle)).toMatchObject({
        lifecycleState: 'instance_running',
        raw: { fixturePid: owner.child.pid },
      });
      expect(() => registry.register(provider)).toThrow('Duplicate remote provider');
      expect(() =>
        registry.register({
          name: 'coordinator-local-provider',
          capabilities: provider.capabilities,
          create: provider.create.bind(provider),
          start: provider.start.bind(provider),
          stop: provider.stop.bind(provider),
          destroy: provider.destroy.bind(provider),
          inspect: provider.inspect.bind(provider),
          spawn: provider.spawn.bind(provider),
        }),
      ).toThrow('RuntimeOwner');
      const unauthenticated = await fetch(endpoint + '/runtime/metadata');
      expect(unauthenticated.status).toBe(403);
    } finally {
      restore();
    }
  });

  it('keeps an original handle on its retained Owner when another extended Owner becomes active', async () => {
    const first = await startOwner('retained');
    const firstEndpoint = await first.ready;
    const second = await startOwner('new-active');
    const secondEndpoint = await second.ready;
    const restore = useEnv({
      PLATFORM_PROCESS_ROLE: 'coordinator',
      COORDINATOR_WRITER_FENCE_VALID: 'true',
    });
    try {
      const registry = await directory(firstEndpoint);
      const provider = registry.get('installation-provider');
      const original = await provider.create(context('retained-task'));
      await provider.start(original);
      await registry.addOwner(
        { endpoint: secondEndpoint, key, instanceId, generation: 1, clock: new SystemClock() },
        true,
      );
      const added = await provider.create(context('new-task'));
      await provider.start(added);
      expect(await provider.inspect(original)).toMatchObject({
        lifecycleState: 'instance_running',
        raw: { fixturePid: first.child.pid, ownerId: 'retained' },
      });
      expect(await provider.inspect(added)).toMatchObject({
        lifecycleState: 'instance_running',
        raw: { fixturePid: second.child.pid, ownerId: 'new-active' },
      });
    } finally {
      restore();
    }
  });

  it('rejects duplicate third-party registration before the Owner journal or RPC is started', async () => {
    const owner = await startOwner('duplicate', { OWNER_FIXTURE_CASE: 'duplicate' });
    await expect(owner.ready).rejects.toThrow('duplicate sandbox provider');
    expect(await owner.exited).toBe(1);
    expect(owner.output()).not.toContain('OWNER_READY:');
    await expect(stat(join(owner.home, 'runtime-owner.sqlite'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(stat(join(owner.home, 'owner-process.lock'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(
      (await readFile(join(owner.home, 'context-closed.jsonl'), 'utf8')).trim().split('\n'),
    ).toHaveLength(1);
  });

  it('holds the home lock before plugin construction and never initializes a duplicate live Owner', async () => {
    const owner = await startOwner('exclusive-home');
    const endpoint = await owner.ready;
    const before = await readFile(join(owner.home, 'owner-process.lock'), 'utf8');
    const duplicate = await startOwner('exclusive-home', {}, false, owner.home);
    await expect(duplicate.ready).rejects.toThrow('already owned by a live process');
    expect(await duplicate.exited).toBe(1);
    expect(
      (await readFile(join(owner.home, 'provider-constructions.jsonl'), 'utf8')).trim().split('\n'),
    ).toHaveLength(1);
    expect(await readFile(join(owner.home, 'owner-process.lock'), 'utf8')).toBe(before);
    expect((await metadata(endpoint)).pid).toBe(owner.child.pid);
    await expect(stat(join(owner.home, 'context-closed.jsonl'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    owner.child.kill('SIGTERM');
    expect(await owner.exited).toBe(0);
    expect(
      JSON.parse((await readFile(join(owner.home, 'context-closed.jsonl'), 'utf8')).trim()),
    ).toEqual({ pid: owner.child.pid, heldLockThroughShutdown: true });
    await expect(stat(join(owner.home, 'owner-process.lock'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('closes init hooks and releases the process lock when initialization fails', async () => {
    const owner = await startOwner('init-failure', { OWNER_FIXTURE_CASE: 'hook-failure' });
    await expect(owner.ready).rejects.toThrow('installation init failed');
    expect(await owner.exited).toBe(1);
    expect(
      (await readFile(join(owner.home, 'context-closed.jsonl'), 'utf8')).trim().split('\n'),
    ).toHaveLength(1);
    await expect(stat(join(owner.home, 'runtime-owner.sqlite'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(stat(join(owner.home, 'owner-process.lock'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    const retry = await startOwner('init-failure', {}, false, owner.home);
    expect((await metadata(await retry.ready)).defaultProvider).toBe('installation-provider');
  });

  it('closes the real SQLite journal and context after listen failure, then retries the same home', async () => {
    const blocker = createServer();
    await new Promise<void>((ok) => blocker.listen(0, '127.0.0.1', ok));
    const port = (blocker.address() as AddressInfo).port;
    resources.push({
      close: async () => {
        if (blocker.listening) await new Promise<void>((ok) => blocker.close(() => ok()));
      },
    });
    const owner = await startOwner('listen-failure', { RUNTIME_OWNER_PORT: String(port) });
    await expect(owner.ready).rejects.toThrow('EADDRINUSE');
    expect(await owner.exited).toBe(1);
    expect(
      (await readFile(join(owner.home, 'context-closed.jsonl'), 'utf8')).trim().split('\n'),
    ).toHaveLength(1);
    await expect(stat(join(owner.home, 'owner-process.lock'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    // A closed journal checkpoints/removes its WAL; the Owner home is reusable.
    expect((await stat(join(owner.home, 'runtime-owner.sqlite'))).isFile()).toBe(true);
    await expect(stat(join(owner.home, 'runtime-owner.sqlite-wal'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await new Promise<void>((ok) => blocker.close(() => ok()));
    const retry = await startOwner('listen-failure', {}, false, owner.home);
    expect((await metadata(await retry.ready)).role).toBe('runtime-owner');
  });

  it.each([
    { PLATFORM_PROCESS_ROLE: 'coordinator' },
    { DATABASE_URL: ':memory:' },
    { DATA_ROOT: '/not-opened-business-data' },
    { PLATFORM_CONTROLLER_RPC_KEY: 'must-not-reach-owner' },
    { PLATFORM_CONTROL_RPC_KEY: 'must-not-reach-owner' },
  ])('rejects invalid Owner authority before any plugin constructor: %j', async (patch) => {
    const owner = await startOwner('invalid-authority', patch);
    await expect(owner.ready).rejects.toThrow(/Only RuntimeOwner|may not receive/);
    expect(await owner.exited).toBe(1);
    await expect(stat(join(owner.home, 'provider-constructions.jsonl'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(stat(join(owner.home, 'runtime-owner.sqlite'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});
