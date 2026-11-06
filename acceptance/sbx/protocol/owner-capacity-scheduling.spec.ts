import 'reflect-metadata';
import {
  mkdtemp,
  mkdir,
  writeFile,
  rm,
  readFile,
  readdir,
  lstat,
  symlink,
  chmod,
  realpath,
  chown,
} from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { availableParallelism, cpus, tmpdir, totalmem } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { filesystemStatsFor, type Clock } from '@platform/shared-kernel';
import {
  RuntimeOwnerCapacitySchema,
  RuntimeOwnerMetadataSchema,
  type ProviderRegistry,
  type RuntimeOwnerCapacity,
} from '@platform/contracts';
import { RuntimeOwnerServer } from '../../../packages/modules/sandbox/src/infrastructure/runtime-rpc/owner-server';
import {
  RuntimeOwnerConnection,
  RuntimeOwnerProviderRegistry,
} from '../../../packages/modules/sandbox/src/infrastructure/runtime-rpc/owner-client';
import { sampleRuntimeOwnerCapacity } from '../../../packages/modules/sandbox/src/infrastructure/runtime-rpc/owner-capacity';
import {
  acquireRuntimeOwnerHomeLock,
  startRuntimeOwnerFromEnvironment,
} from '../../../packages/modules/sandbox/src/infrastructure/runtime-rpc/owner-factory';
import { CounterProcessProvider } from '../../upg/runtime/child-provider';
import { useEnv } from '../../support/strict-ports';

const key = 'capacity-fixture-coordinator-key-not-production';
const instanceId = 'capacity-fixture-instance';
const ownerId = 'capacity-fixture-owner';
const startIdentity = 'capacity-fixture-owner-start-identity';
const artifactDigest = 'sha256:' + 'a'.repeat(64);
const contexts: { close(): Promise<void> }[] = [];
type Capacity = RuntimeOwnerCapacity['capacity'];

async function coldFactoryInput() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'owner-cold-factory-')));
  await chmod(root, 0o700);
  const home = join(root, 'owner'),
    sdkRoot = join(home, 'boxlite');
  const restore = useEnv({
    PLATFORM_PROCESS_ROLE: 'runtime-owner',
    PLATFORM_INSTANCE_ID: instanceId,
    PLATFORM_COORDINATOR_RPC_KEY: key,
    PLATFORM_PROCESS_START_IDENTITY: startIdentity,
    RUNTIME_OWNER_ID: ownerId,
    RUNTIME_OWNER_HOME: home,
    BOXLITE_HOME: sdkRoot,
    RUNTIME_OWNER_PORT: '0',
    PLATFORM_ARTIFACT_DIGEST: undefined,
    DATABASE_URL: undefined,
    DATA_ROOT: undefined,
    PLATFORM_CONTROL_RPC_KEY: undefined,
    PLATFORM_CONTROLLER_RPC_KEY: undefined,
    UPGRADE_ADMIN_KEY: undefined,
    UPGRADE_LEGACY_AUTH_CONTINUITY_KEY: undefined,
  });
  const external = new CounterProcessProvider(root);
  const registry: ProviderRegistry = {
    defaultProvider: external.name,
    get: () => external,
    has: () => true,
    list: () => [external],
    register: () => {
      throw new Error('Fixed fixture');
    },
  };
  const clock: Clock = { now: () => new Date() };
  const lock = acquireRuntimeOwnerHomeLock();
  let running: Awaited<ReturnType<typeof startRuntimeOwnerFromEnvironment>> | undefined;
  const f = {
    root,
    home,
    sdkRoot,
    external,
    lock,
    start: async () => (running = await startRuntimeOwnerFromEnvironment(clock, registry, lock)),
    close: async () => {
      try {
        await running?.close();
        await external.close();
      } finally {
        lock.release();
        restore();
        await rm(root, { recursive: true, force: true });
      }
    },
  };
  contexts.push(f);
  return f;
}

/** Real HTTP, Owner-private SQLite, filesystem and cgroup parser. Only Linux
 * kernel files are represented by an owned fixture on non-Linux test hosts;
 * this does not claim native VM/container-cgroup qualification. */
async function fixture(
  options: {
    capacity?: (() => Promise<Capacity>) | null;
    missingIdentity?: boolean;
  } = {},
) {
  const home = await mkdtemp(join(tmpdir(), 'owner-capacity-http-'));
  const sdkRoot = join(home, 'sdk');
  const workspaceRoot = join(home, 'workspaces');
  const linuxRoot = join(home, 'linux');
  await Promise.all([mkdir(sdkRoot), mkdir(workspaceRoot)]);
  const put = async (path: string, value: string) => {
    const target = join(linuxRoot, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, value);
  };
  await put('proc/self/cgroup', '0::/api\n');
  await put('proc/self/mountinfo', '35 24 0:30 / /sys/fs/cgroup ro - cgroup2 cgroup rw\n');
  await put('sys/fs/cgroup/api/cpu.max', 'max 100000\n');
  await put('sys/fs/cgroup/api/memory.max', 'max\n');
  await put('sys/fs/cgroup/cpu.max', '400000 100000\n');
  await put('sys/fs/cgroup/memory.max', String(6 * 1024 ** 3));
  const clock: Clock = { now: () => new Date(1792454400000) };
  const external = new CounterProcessProvider(home);
  const providers: ProviderRegistry = {
    defaultProvider: external.name,
    get: () => external,
    has: (name) => name === external.name,
    list: () => [external],
    register: () => {
      throw new Error('Fixed fixture registry');
    },
  };
  let observations = 0;
  const server = new RuntimeOwnerServer({
    instanceId,
    ownerId,
    key,
    clock,
    registry: providers,
    journalPath: join(home, 'owner.sqlite'),
    startIdentity: options.missingIdentity ? undefined : startIdentity,
    artifactIdentity: { artifactDigest, inputFingerprint: 'capacity-fixture-input' },
    ...(options.capacity === null
      ? {}
      : {
          capacity: async () => {
            observations++;
            return options.capacity
              ? options.capacity()
              : sampleRuntimeOwnerCapacity({ sdkRoot, workspaceRoot }, linuxRoot);
          },
        }),
  });
  const requests: string[] = [];
  server.server.on('request', (request) => requests.push(request.url ?? ''));
  await server.listen(0);
  const origin = `http://127.0.0.1:${(server.server.address() as AddressInfo).port}`;
  const get = (path: string, authorized = true) =>
    fetch(origin + path, {
      headers: {
        'x-platform-instance-id': instanceId,
        'x-platform-internal-key': authorized ? key : 'not-authorized',
      },
    });
  const f = {
    server,
    external,
    requests,
    clock,
    origin,
    get,
    sdkRoot,
    workspaceRoot,
    linuxRoot,
    put,
    observations: () => observations,
    close: async () => {
      await server.close();
      await external.close();
      await rm(home, { recursive: true, force: true });
    },
  };
  contexts.push(f);
  return f;
}
afterEach(async () => {
  for (const value of contexts.splice(0)) await value.close();
});

describe('Owner capacity is a separate authenticated read-only observation [AC-UPG-001.4] [AC-UPG-007.3]', () => {
  it('creates only the cold SDK directory under the real locked factory before publishing HTTP metadata', async () => {
    const f = await coldFactoryInput();
    expect(await lstat(f.sdkRoot).catch(() => null)).toBe(null);
    const running = await f.start();
    const entry = await lstat(f.sdkRoot);
    expect(entry.isDirectory()).toBe(true);
    expect(entry.isSymbolicLink()).toBe(false);
    expect(entry.uid).toBe(process.getuid?.());
    expect(entry.mode & 0o777).toBe(0o700);
    expect(await readdir(f.sdkRoot)).toEqual([]);
    const origin = `http://127.0.0.1:${(running.server.server.address() as AddressInfo).port}`;
    const headers = { 'x-platform-internal-key': key, 'x-platform-instance-id': instanceId };
    expect((await fetch(origin + '/runtime/metadata', { headers })).status).toBe(200);
    // This Mac fixture has no installed production artifact/Linux filesystem:
    // factory Linux capacity200 remains a later Native gate, never fabricated here.
    const unavailable = await fetch(origin + '/runtime/capacity', { headers });
    expect(unavailable.status).toBe(409);
    expect(await unavailable.json()).toMatchObject({ error: { code: 'PROVIDER_UNAVAILABLE' } });
    const linux = await fixture();
    const capacity = await sampleRuntimeOwnerCapacity(
      { sdkRoot: f.sdkRoot, workspaceRoot: linux.workspaceRoot },
      linux.linuxRoot,
    );
    expect(capacity.ramMb).toBeGreaterThan(0);
    expect(await readdir(f.sdkRoot)).toEqual([]);
    expect([f.external.creates, f.external.starts, f.external.stops, f.external.destroys]).toEqual([
      0, 0, 0, 0,
    ]);
  });

  it('preserves a trusted existing SDK directory and its bytes without initializing the SDK', async () => {
    const f = await coldFactoryInput();
    await mkdir(f.sdkRoot, { mode: 0o700 });
    await writeFile(join(f.sdkRoot, 'retained-fixture'), 'retain original SDK bytes');
    const before = await lstat(f.sdkRoot);
    await f.start();
    expect((await lstat(f.sdkRoot)).ino).toBe(before.ino);
    expect(await readFile(join(f.sdkRoot, 'retained-fixture'), 'utf8')).toBe(
      'retain original SDK bytes',
    );
    expect(await readdir(f.sdkRoot)).toEqual(['retained-fixture']);
  });

  it.each([
    'symlink',
    'symlink-parent',
    'file',
    'writable-parent',
    'escaped-path',
    'lost-lock',
  ] as const)(
    'refuses cold SDK preparation with %s before Owner journal/listener or SDK initialization',
    async (failure) => {
      const f = await coldFactoryInput();
      if (failure === 'symlink') {
        const outside = join(f.root, 'outside');
        await mkdir(outside);
        await symlink(outside, f.sdkRoot);
      }
      if (failure === 'symlink-parent') {
        const outside = join(f.root, 'outside');
        await mkdir(outside);
        const parent = join(f.home, 'linked');
        await symlink(outside, parent);
        process.env.BOXLITE_HOME = join(parent, 'boxlite');
      }
      if (failure === 'file') await writeFile(f.sdkRoot, 'retained regular file');
      if (failure === 'writable-parent') {
        const parent = join(f.home, 'writable');
        await mkdir(parent, { mode: 0o777 });
        await chmod(parent, 0o777);
        process.env.BOXLITE_HOME = join(parent, 'boxlite');
      }
      if (failure === 'escaped-path') process.env.BOXLITE_HOME = join(f.root, 'escaped');
      if (failure === 'lost-lock') f.lock.release();
      await expect(f.start()).rejects.toThrow();
      expect(await lstat(join(f.home, 'runtime-owner.sqlite')).catch(() => null)).toBe(null);
      expect(await lstat(join(f.root, 'escaped')).catch(() => null)).toBe(null);
      if (failure === 'symlink') expect(await readdir(join(f.root, 'outside'))).toEqual([]);
      if (failure === 'symlink-parent') expect(await readdir(join(f.root, 'outside'))).toEqual([]);
      if (failure === 'file')
        expect(await readFile(f.sdkRoot, 'utf8')).toBe('retained regular file');
      if (failure === 'writable-parent')
        expect(await lstat(process.env.BOXLITE_HOME ?? '').catch(() => null)).toBe(null);
      expect([
        f.external.creates,
        f.external.starts,
        f.external.stops,
        f.external.destroys,
      ]).toEqual([0, 0, 0, 0]);
    },
  );
  it('rejects a foreign UID before changing a home or initializing SDK state', async () => {
    const f = await coldFactoryInput();
    if (process.getuid?.() === 0) {
      await mkdir(f.sdkRoot, { mode: 0o700 });
      await chown(f.sdkRoot, 1, 1);
      await expect(f.start()).rejects.toThrow('directory is not trusted');
      expect(await lstat(join(f.home, 'runtime-owner.sqlite')).catch(() => null)).toBe(null);
    } else {
      // Read-only foreign directory: rejection precedes chmod or creating any
      // lock/SDK child outside this fixture.
      const before = await lstat('/usr');
      expect(before.uid).not.toBe(process.getuid?.());
      process.env.RUNTIME_OWNER_HOME = '/usr';
      process.env.BOXLITE_HOME = '/usr/owner-cold-fixture-sdk-never-created';
      expect(() => acquireRuntimeOwnerHomeLock()).toThrow('directory is not trusted');
      expect((await lstat('/usr')).ctimeMs).toBe(before.ctimeMs);
    }
  });
  it('rejects a symbolic-link Owner home before chmod or writing a process lock through it', async () => {
    const f = await coldFactoryInput();
    const outside = join(f.root, 'outside');
    await mkdir(outside, { mode: 0o700 });
    const linkedHome = join(f.root, 'linked-home');
    await symlink(outside, linkedHome);
    process.env.RUNTIME_OWNER_HOME = linkedHome;
    process.env.BOXLITE_HOME = join(linkedHome, 'boxlite');
    expect(() => acquireRuntimeOwnerHomeLock()).toThrow('directory is not trusted');
    expect(await readdir(outside)).toEqual([]);
    expect((await lstat(outside)).mode & 0o777).toBe(0o700);
  });
  it('measures Owner ancestors and exact SDK/workspace filesystems without operator overrides or effects', async () => {
    const restore = useEnv({ SCHEDULER_HOST_CORES: '0.01', SCHEDULER_HOST_RAM_MB: '1' });
    try {
      const f = await fixture();
      const before = f.server.journal.continuity();
      const metadata = RuntimeOwnerMetadataSchema.parse(
        await (await f.get('/runtime/metadata')).json(),
      );
      const response = await f.get('/runtime/capacity');
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      const value = RuntimeOwnerCapacitySchema.parse(await response.json());
      const [sdk, workspace] = await Promise.all([
        filesystemStatsFor(f.sdkRoot),
        filesystemStatsFor(f.workspaceRoot),
      ]);
      if (!sdk || !workspace) throw new Error('Owned filesystem fixture is unavailable');
      expect(value).toMatchObject({
        schemaVersion: 1,
        instanceId,
        ownerId,
        startIdentity,
        artifactDigest,
        observedAt: f.clock.now().getTime(),
        capacity: {
          cores: Math.min(cpus().length, availableParallelism(), 4),
          ramMb: Math.min(Math.floor(totalmem() / 1024 ** 2), 6144),
          diskTotalBytes: Math.min(sdk.totalBytes, workspace.totalBytes),
        },
      });
      expect(value.capacity.diskAvailableBytes).toBeGreaterThan(0);
      expect(value.capacity.diskAvailableBytes).toBeLessThanOrEqual(value.capacity.diskTotalBytes);
      expect(f.server.journal.continuity()).toEqual(before);
      expect(await (await f.get('/runtime/metadata')).json()).toEqual(metadata);
      expect([
        f.external.creates,
        f.external.starts,
        f.external.stops,
        f.external.destroys,
      ]).toEqual([0, 0, 0, 0]);
      expect(f.observations()).toBe(1);
    } finally {
      restore();
    }
  });

  it('rejects unauthenticated observations before probing and does not expose capacity or credentials', async () => {
    const f = await fixture();
    const response = await f.get('/runtime/capacity', false);
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain(key);
    expect(f.observations()).toBe(0);
    expect(f.server.journal.assignments()).toEqual([]);
  });

  it.each(['controller', 'workspace', 'membership'] as const)(
    'fails closed for missing %s facts rather than reporting host capacity or walking to a parent',
    async (missing) => {
      const f = await fixture();
      if (missing === 'controller')
        await rm(join(f.linuxRoot, 'sys/fs/cgroup'), { recursive: true });
      if (missing === 'workspace') await rm(f.workspaceRoot, { recursive: true });
      if (missing === 'membership') await rm(join(f.linuxRoot, 'proc/self/cgroup'));
      const before = f.server.journal.continuity();
      const response = await f.get('/runtime/capacity');
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        error: { code: 'PROVIDER_UNAVAILABLE', retryable: true },
      });
      expect(f.server.journal.continuity()).toEqual(before);
      expect(f.external.creates).toBe(0);
    },
  );

  it.each(['cpu', 'memory'] as const)(
    'HOLDs malformed %s controller facts instead of falling back to the larger host budget',
    async (controller) => {
      const f = await fixture();
      await f.put(
        `sys/fs/cgroup/${controller === 'cpu' ? 'cpu.max' : 'memory.max'}`,
        controller === 'cpu' ? 'garbage' : 'oops',
      );
      const before = f.server.journal.continuity();
      const response = await f.get('/runtime/capacity');
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        error: { code: 'PROVIDER_UNAVAILABLE', retryable: true },
      });
      expect(f.server.journal.continuity()).toEqual(before);
      expect(f.external.creates).toBe(0);
    },
  );

  it.each(['identity', 'invalid-value', 'available-exceeds-total', 'probe-failed'] as const)(
    'returns a bounded unavailable result for %s without exposing internal errors',
    async (failure) => {
      const f = await fixture({
        missingIdentity: failure === 'identity',
        capacity:
          failure === 'probe-failed'
            ? async () => {
                throw new Error('private-fixture-path-and-secret');
              }
            : async () => ({
                cores: 4,
                ramMb: 6144,
                diskTotalBytes: 1024,
                diskAvailableBytes:
                  failure === 'invalid-value'
                    ? Infinity
                    : failure === 'available-exceeds-total'
                      ? 2048
                      : 512,
              }),
      });
      const response = await f.get('/runtime/capacity');
      const text = await response.text();
      expect(response.status).toBe(409);
      expect(JSON.parse(text)).toMatchObject({
        error: { code: 'PROVIDER_UNAVAILABLE', retryable: true },
      });
      expect(text).not.toContain('private-fixture-path-and-secret');
      expect(text).not.toContain(key);
      expect(f.server.journal.assignments()).toEqual([]);
    },
  );

  it('rejects a measurement completed after its two-second budget without blocking metadata or mutating resources', async () => {
    let release!: () => void;
    const paused = new Promise<void>((resolve) => {
      release = resolve;
    });
    const f = await fixture({
      capacity: async () => {
        await paused;
        return { cores: 4, ramMb: 6144, diskTotalBytes: 1024, diskAvailableBytes: 512 };
      },
    });
    const response = f.get('/runtime/capacity');
    try {
      await expect.poll(f.observations).toBe(1);
      expect((await f.get('/runtime/metadata')).status).toBe(200);
      await new Promise<void>((resolve) => setTimeout(resolve, 2050));
      release();
      const result = await response;
      expect(result.status).toBe(409);
      expect(await result.json()).toMatchObject({ error: { code: 'PROVIDER_UNAVAILABLE' } });
      expect(f.server.journal.assignments()).toEqual([]);
      expect([
        f.external.creates,
        f.external.starts,
        f.external.stops,
        f.external.destroys,
      ]).toEqual([0, 0, 0, 0]);
    } finally {
      release();
      await response;
    }
  });

  it('keeps old metadata and connection startup working without a capacity capability', async () => {
    const f = await fixture({ capacity: null });
    expect((await f.get('/runtime/capacity')).status).toBe(404);
    const registry = new RuntimeOwnerProviderRegistry();
    try {
      await registry.addOwner(
        { endpoint: f.origin, instanceId, key, generation: 1, clock: f.clock },
        true,
      );
      expect(registry.activeOwnerId).toBe(ownerId);
      expect(registry.defaultProvider).toBe(f.external.name);
      expect(f.requests.filter((path) => path === '/runtime/capacity')).toHaveLength(1);
      expect(f.external.creates).toBe(0);
      expect(
        RuntimeOwnerMetadataSchema.safeParse(await (await f.get('/runtime/metadata')).json())
          .success,
      ).toBe(true);
    } finally {
      registry.onModuleDestroy();
    }
  });

  it.each(['instance', 'owner', 'start', 'artifact', 'stale', 'future'] as const)(
    'rejects a real HTTP capacity response with mismatched %s evidence without resource effects',
    async (fault) => {
      const f = await fixture();
      // Only the capacity response is faulted; metadata, authentication, lease,
      // journal and the client's actual HTTP parsing remain the production path.
      const proxy = createServer((request, response) => {
        void (async () => {
          const chunks: Buffer[] = [];
          for await (const chunk of request) chunks.push(Buffer.from(chunk));
          const upstream = await fetch(f.origin + (request.url ?? '/'), {
            method: request.method,
            headers: { 'x-platform-internal-key': key, 'x-platform-instance-id': instanceId },
            body: chunks.length ? Buffer.concat(chunks) : undefined,
          });
          let text = await upstream.text();
          if (request.url === '/runtime/capacity' && upstream.status === 200) {
            const value = RuntimeOwnerCapacitySchema.parse(JSON.parse(text));
            if (fault === 'instance') value.instanceId = 'another-instance';
            if (fault === 'owner') value.ownerId = 'another-owner';
            if (fault === 'start') value.startIdentity = 'another-physical-start-identity';
            if (fault === 'artifact') value.artifactDigest = 'sha256:' + 'b'.repeat(64);
            if (fault === 'stale') value.observedAt -= 5001;
            if (fault === 'future') value.observedAt += 1;
            text = JSON.stringify(value);
          }
          response.writeHead(upstream.status, { 'content-type': 'application/json' });
          response.end(text);
        })().catch(() => response.destroy());
      });
      await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
      const connection = new RuntimeOwnerConnection({
        endpoint: `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`,
        instanceId,
        key,
        generation: 1,
        clock: f.clock,
      });
      try {
        await connection.connect();
        expect(f.observations()).toBe(0);
        const before = f.server.journal.continuity();
        await expect(
          connection.schedulingCapacity(AbortSignal.timeout(2000)),
        ).rejects.toMatchObject({
          code: 'PROVIDER_UNAVAILABLE',
        });
        expect(f.server.journal.continuity()).toEqual(before);
        expect([
          f.external.creates,
          f.external.starts,
          f.external.stops,
          f.external.destroys,
        ]).toEqual([0, 0, 0, 0]);
      } finally {
        connection.close();
        proxy.closeAllConnections();
        await new Promise<void>((resolve) => proxy.close(() => resolve()));
      }
    },
  );
});
