import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  chmodSync,
} from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import type { Clock } from '@platform/shared-kernel';
import type { ProviderRegistry } from '@platform/contracts';
import { AioSandboxProvider } from '../providers/aio/aio-sandbox.provider';
import { BoxliteSandboxProvider } from '../providers/boxlite/boxlite-sandbox.provider';
import { createDockerClient } from '../providers/docker/docker-client';
import { SandboxProviderRegistry } from '../registry/provider-registry';
import { RuntimeOwnerServer } from './owner-server';
import { ownerArtifactIdentity } from './artifact-identity';
import { RuntimeOwnerProviderRegistry } from './owner-client';

/** Exclusive process lock complements the SDK home lock, including AIO owners. */
export class RuntimeOwnerHomeLock {
  private readonly nonce = randomBytes(20).toString('hex');
  constructor(
    private readonly path: string,
    instanceId: string,
    ownerId: string,
  ) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const acquire = (): void => {
      const fd = openSync(path, 'wx', 0o600);
      try {
        writeFileSync(
          fd,
          JSON.stringify({ pid: process.pid, nonce: this.nonce, instanceId, ownerId }),
        );
      } finally {
        closeSync(fd);
      }
    };
    try {
      acquire();
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error;
      const old = JSON.parse(readFileSync(path, 'utf8')) as {
        pid?: unknown;
        instanceId?: unknown;
        ownerId?: unknown;
      };
      if (
        !Number.isSafeInteger(old.pid) ||
        old.instanceId !== instanceId ||
        old.ownerId !== ownerId
      )
        throw new Error('RuntimeOwner home has an unconfirmed process lock');
      try {
        process.kill(old.pid as number, 0);
        throw new Error('RuntimeOwner home is already owned by a live process');
      } catch (probe) {
        if (!(probe instanceof Error) || !('code' in probe) || probe.code !== 'ESRCH') throw probe;
      }
      unlinkSync(path);
      acquire();
    }
  }
  release(): void {
    if (!existsSync(this.path)) return;
    const current = JSON.parse(readFileSync(this.path, 'utf8')) as { nonce?: unknown };
    if (current.nonce === this.nonce) unlinkSync(this.path);
  }
}

export async function createRuntimeOwnerProviderRegistry(
  clock: Clock,
): Promise<RuntimeOwnerProviderRegistry> {
  const registry = new RuntimeOwnerProviderRegistry();
  const instanceId = process.env.PLATFORM_INSTANCE_ID?.trim();
  const key = process.env.PLATFORM_COORDINATOR_RPC_KEY;
  const endpoint = process.env.RUNTIME_OWNER_RPC_URL;
  const generation = Number(process.env.COORDINATOR_GENERATION ?? '1');
  if (!instanceId || !key || !endpoint)
    throw new Error('Coordinator RuntimeOwner authority is not configured');
  const deferClaim = process.env.PLATFORM_PROCESS_ROLE === 'coordinator-prepared';
  const bindingPath = process.env.PLATFORM_RUNTIME_OWNER_BINDING_PATH;
  if (bindingPath) {
    const { lstat, readFile } = await import('node:fs/promises');
    const stat = await lstat(bindingPath);
    if (
      !isAbsolute(bindingPath) ||
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      (stat.mode & 0o022) !== 0
    )
      throw new Error('UNTRUSTED_OWNER_BINDING');
    const binding = JSON.parse(await readFile(bindingPath, 'utf8')) as {
      instanceId?: string;
      activeOwnerId?: string;
      owners?: { ownerId: string; endpoint: string }[];
    };
    if (
      binding.instanceId !== instanceId ||
      !Array.isArray(binding.owners) ||
      !binding.owners.length ||
      !binding.owners.some((owner) => owner.ownerId === binding.activeOwnerId)
    )
      throw new Error('INVALID_OWNER_BINDING');
    for (const owner of binding.owners) {
      await registry.addOwner(
        { endpoint: owner.endpoint, instanceId, key, generation, clock, deferClaim },
        false,
      );
      if (
        !registry
          .installedRoutes()
          .some((route) => route.ownerId === owner.ownerId && route.endpoint === owner.endpoint)
      )
        throw new Error('OWNER_BINDING_IDENTITY_MISMATCH');
    }
    registry.activateOwner(binding.activeOwnerId!);
    return registry;
  }
  await registry.addOwner({ endpoint, instanceId, key, generation, clock, deferClaim }, true);
  const routes = process.env.RUNTIME_OWNER_ROUTES;
  if (routes) {
    const extra = JSON.parse(routes) as unknown;
    if (!Array.isArray(extra))
      throw new Error('RUNTIME_OWNER_ROUTES must be an installed owner route list');
    for (const route of extra) {
      if (
        route === null ||
        typeof route !== 'object' ||
        typeof (route as { endpoint?: unknown }).endpoint !== 'string'
      )
        throw new Error('Invalid installed owner route');
      const endpoint = (route as { endpoint: string }).endpoint;
      await registry.addOwner({ endpoint, instanceId, key, generation, clock, deferClaim });
    }
  }
  return registry;
}

export function createLocalRuntimeOwnerRegistry(clock: Clock): ProviderRegistry {
  return new SandboxProviderRegistry(
    new AioSandboxProvider(createDockerClient(), undefined, clock),
    new BoxliteSandboxProvider(clock),
  );
}

export async function startRuntimeOwnerFromEnvironment(
  clock: Clock,
): Promise<{ server: RuntimeOwnerServer; close(): Promise<void> }> {
  if (process.env.PLATFORM_PROCESS_ROLE !== 'runtime-owner')
    throw new Error('Only RuntimeOwner may instantiate SDK providers');
  for (const key of [
    'DATABASE_URL',
    'DATA_ROOT',
    'PLATFORM_CONTROL_RPC_KEY',
    'PLATFORM_CONTROLLER_RPC_KEY',
    'UPGRADE_ADMIN_KEY',
  ])
    if (Object.hasOwn(process.env, key))
      throw new Error('RuntimeOwner may not receive business database or controller authority');
  const instanceId = process.env.PLATFORM_INSTANCE_ID?.trim();
  const ownerId = process.env.RUNTIME_OWNER_ID?.trim();
  const key = process.env.PLATFORM_COORDINATOR_RPC_KEY;
  const home = process.env.RUNTIME_OWNER_HOME;
  const sdkHome = process.env.BOXLITE_HOME;
  if (
    !instanceId ||
    !ownerId ||
    !key ||
    !home ||
    !sdkHome ||
    !isAbsolute(home) ||
    !isAbsolute(sdkHome) ||
    !resolve(sdkHome).startsWith(resolve(home) + '/')
  ) {
    throw new Error('RuntimeOwner requires an explicit instance, owner id and private SDK home');
  }
  mkdirSync(home, { recursive: true, mode: 0o700 });
  chmodSync(home, 0o700);
  const lock = new RuntimeOwnerHomeLock(resolve(home, 'owner-process.lock'), instanceId, ownerId);
  const server = new RuntimeOwnerServer({
    instanceId,
    ownerId,
    key,
    clock,
    artifactIdentity: await ownerArtifactIdentity(),
    startIdentity: process.env.PLATFORM_PROCESS_START_IDENTITY,
    privateDatabaseIsolation: true,
    journalPath: resolve(home, 'runtime-owner.sqlite'),
    registry: createLocalRuntimeOwnerRegistry(clock),
  });
  try {
    await server.listen(Number(process.env.RUNTIME_OWNER_PORT ?? '3231'));
  } catch (error) {
    lock.release();
    throw error;
  }
  return {
    server,
    close: async () => {
      await server.close();
      lock.release();
    },
  };
}
