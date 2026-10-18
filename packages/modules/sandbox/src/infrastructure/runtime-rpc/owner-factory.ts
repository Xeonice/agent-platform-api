import { isRecord } from '@platform/shared-kernel';
import { ownerRecord } from './wire-codec';
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
import { RuntimeOwnerServer } from './owner-server';
import { ownerArtifactIdentity } from './artifact-identity';
import { RuntimeOwnerProviderRegistry } from './owner-client';

/** Exclusive process lock complements the SDK home lock, including AIO owners. */
export class RuntimeOwnerHomeLock {
  private readonly nonce = randomBytes(20).toString('hex');
  constructor(
    private readonly path: string,
    private readonly instanceId: string,
    private readonly ownerId: string,
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
      const old = ownerRecord(JSON.parse(readFileSync(path, 'utf8')) as unknown);
      if (
        typeof old.pid !== 'number' ||
        !Number.isSafeInteger(old.pid) ||
        old.pid <= 0 ||
        old.instanceId !== instanceId ||
        old.ownerId !== ownerId
      )
        throw new Error('RuntimeOwner home has an unconfirmed process lock');
      try {
        process.kill(old.pid, 0);
        throw new Error('RuntimeOwner home is already owned by a live process');
      } catch (probe) {
        if (!(probe instanceof Error) || !('code' in probe) || probe.code !== 'ESRCH') throw probe;
      }
      unlinkSync(path);
      acquire();
    }
  }
  assertHeld(): void {
    const current = ownerRecord(JSON.parse(readFileSync(this.path, 'utf8')) as unknown);
    const home = process.env.RUNTIME_OWNER_HOME;
    if (
      !home ||
      this.path !== resolve(home, 'owner-process.lock') ||
      current.pid !== process.pid ||
      current.nonce !== this.nonce ||
      current.instanceId !== this.instanceId ||
      current.ownerId !== this.ownerId ||
      current.instanceId !== process.env.PLATFORM_INSTANCE_ID?.trim() ||
      current.ownerId !== process.env.RUNTIME_OWNER_ID?.trim()
    )
      throw new Error('RuntimeOwner home lock is not authoritative');
  }
  release(): void {
    if (!existsSync(this.path)) return;
    const current = ownerRecord(JSON.parse(readFileSync(this.path, 'utf8')) as unknown);
    if (current.nonce === this.nonce) unlinkSync(this.path);
  }
}

/** The lock precedes DI: a second process must not construct a plugin SDK or run
 * its registration hook while the original Owner still owns the private home. */
export function acquireRuntimeOwnerHomeLock(): RuntimeOwnerHomeLock {
  const { home, instanceId, ownerId } = assertRuntimeOwnerEnvironment();
  mkdirSync(home, { recursive: true, mode: 0o700 });
  chmodSync(home, 0o700);
  return new RuntimeOwnerHomeLock(resolve(home, 'owner-process.lock'), instanceId, ownerId);
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
    const binding = ownerRecord(JSON.parse(await readFile(bindingPath, 'utf8')) as unknown);
    if (
      binding.instanceId !== instanceId ||
      typeof binding.activeOwnerId !== 'string' ||
      !Array.isArray(binding.owners) ||
      !binding.owners.length ||
      !binding.owners.some(
        (owner: unknown) => isRecord(owner) && owner.ownerId === binding.activeOwnerId,
      )
    )
      throw new Error('INVALID_OWNER_BINDING');
    for (const value of binding.owners) {
      const owner = ownerRecord(value);
      if (typeof owner.ownerId !== 'string' || typeof owner.endpoint !== 'string')
        throw new Error('INVALID_OWNER_BINDING');
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
    registry.activateOwner(binding.activeOwnerId);
    return registry;
  }
  await registry.addOwner({ endpoint, instanceId, key, generation, clock, deferClaim }, true);
  const routes = process.env.RUNTIME_OWNER_ROUTES;
  if (routes) {
    const extra = JSON.parse(routes) as unknown;
    if (!Array.isArray(extra))
      throw new Error('RUNTIME_OWNER_ROUTES must be an installed owner route list');
    for (const route of extra) {
      if (!isRecord(route) || typeof route.endpoint !== 'string')
        throw new Error('Invalid installed owner route');
      const endpoint = route.endpoint;
      await registry.addOwner({ endpoint, instanceId, key, generation, clock, deferClaim });
    }
  }
  return registry;
}

/** Run before constructing an installation's DI context: even a provider's
 * constructor must not run under a Coordinator or business-database identity. */
export function assertRuntimeOwnerEnvironment(): {
  instanceId: string;
  ownerId: string;
  key: string;
  home: string;
} {
  if (process.env.PLATFORM_PROCESS_ROLE !== 'runtime-owner')
    throw new Error('Only RuntimeOwner may instantiate SDK providers');
  for (const key of [
    'DATABASE_URL',
    'DATA_ROOT',
    'PLATFORM_CONTROL_RPC_KEY',
    'PLATFORM_CONTROLLER_RPC_KEY',
    'UPGRADE_ADMIN_KEY',
    'UPGRADE_LEGACY_AUTH_CONTINUITY_KEY',
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
    key.length < 32 ||
    !home ||
    !sdkHome ||
    !isAbsolute(home) ||
    !isAbsolute(sdkHome) ||
    !resolve(sdkHome).startsWith(resolve(home) + '/')
  ) {
    throw new Error('RuntimeOwner requires an explicit instance, owner id and private SDK home');
  }
  return { instanceId, ownerId, key, home };
}

export async function startRuntimeOwnerFromEnvironment(
  clock: Clock,
  registry: ProviderRegistry,
  lock: RuntimeOwnerHomeLock,
): Promise<{ server: RuntimeOwnerServer; close(): Promise<void> }> {
  const { instanceId, ownerId, key, home } = assertRuntimeOwnerEnvironment();
  lock.assertHeld();
  let server: RuntimeOwnerServer | undefined;
  try {
    server = new RuntimeOwnerServer({
      instanceId,
      ownerId,
      key,
      clock,
      artifactIdentity: await ownerArtifactIdentity(),
      startIdentity: process.env.PLATFORM_PROCESS_START_IDENTITY,
      privateDatabaseIsolation: true,
      journalPath: resolve(home, 'runtime-owner.sqlite'),
      registry,
    });
    await server.listen(Number(process.env.RUNTIME_OWNER_PORT ?? '3231'));
  } catch (error) {
    await server?.close();
    throw error;
  }
  return {
    server,
    close: () => server.close(),
  };
}
