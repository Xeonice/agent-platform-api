import { lstat, readFile, realpath, stat } from 'node:fs/promises';
import { availableParallelism, cpus, totalmem } from 'node:os';
import { dirname, isAbsolute, posix, resolve } from 'node:path';
import { filesystemStatsFor } from '@platform/shared-kernel';
import {
  RuntimeOwnerCapacitySchema,
  SandboxProviderError,
  SandboxProviderErrorCode,
  type RuntimeOwnerCapacity,
} from '@platform/contracts';
import { linuxResourceCapacity } from '../scheduler/linux-cgroup-capacity';

type Capacity = RuntimeOwnerCapacity['capacity'];
const MIB = 1024 * 1024;

/** No SDK initialization, business DB, operator overrides or background work.
 * linuxRoot is the filesystem seam used by isolated cgroup fixtures; production
 * always reads this process's /proc/self and visible cgroup ancestors under '/'. */
export async function sampleRuntimeOwnerCapacity(
  roots: { sdkRoot: string; workspaceRoot: string },
  linuxRoot = '/',
): Promise<Capacity> {
  try {
    const before = await cgroupIdentity(linuxRoot);
    await requireResourceControllers(before, linuxRoot);
    const [resources, sdk, workspace] = await Promise.all([
      linuxResourceCapacity(
        {
          cores: Math.min(cpus().length, availableParallelism()),
          ramMb: Math.floor(totalmem() / MIB),
        },
        {},
        linuxRoot,
      ),
      exactFilesystem(roots.sdkRoot),
      exactFilesystem(roots.workspaceRoot),
    ]);
    const after = await cgroupIdentity(linuxRoot);
    if (before.membership !== after.membership || before.mounts !== after.mounts)
      throw new Error('Owner resource identity changed during observation');
    return RuntimeOwnerCapacitySchema.shape.capacity.parse({
      ...resources,
      diskTotalBytes: Math.min(sdk.totalBytes, workspace.totalBytes),
      diskAvailableBytes: Math.min(sdk.availableBytes, workspace.availableBytes),
    });
  } catch {
    throw unavailable();
  }
}

function unavailable(): SandboxProviderError {
  return new SandboxProviderError(
    SandboxProviderErrorCode.PROVIDER_UNAVAILABLE,
    'RuntimeOwner capacity could not be confirmed',
    undefined,
    true,
  );
}

async function exactFilesystem(path: string) {
  if (!isAbsolute(path) || path.length > 4096) throw new Error('Invalid capacity root');
  const before = await lstat(path, { bigint: true });
  if (!before.isDirectory() || before.isSymbolicLink()) throw new Error('Capacity root missing');
  const canonical = await realpath(path);
  const value = await filesystemStatsFor(canonical);
  const after = await stat(path, { bigint: true });
  if (
    value?.probedPath !== canonical ||
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    !after.isDirectory() ||
    !Number.isSafeInteger(value.totalBytes) ||
    value.totalBytes < 0 ||
    !Number.isSafeInteger(value.availableBytes) ||
    value.availableBytes < 0 ||
    value.availableBytes > value.totalBytes
  )
    throw new Error('Capacity filesystem is unconfirmed');
  return value;
}

async function cgroupIdentity(root: string) {
  if (!isAbsolute(root)) throw new Error('Invalid Linux capacity root');
  const [membership, mounts] = await Promise.all([
    readFile(resolve(root, './proc/self/cgroup'), 'utf8'),
    readFile(resolve(root, './proc/self/mountinfo'), 'utf8'),
  ]);
  if (!membership.trim() || membership.length > 65536 || !mounts.trim() || mounts.length > 1048576)
    throw new Error('Linux cgroup identity is unconfirmed');
  return { membership, mounts };
}

/** The shared probe tolerates missing cgroup files for legacy local mode. This
 * remote admission boundary must instead prove both controllers were observed. */
async function requireResourceControllers(
  identity: { membership: string; mounts: string },
  root: string,
): Promise<void> {
  const groups = identity.membership
    .trim()
    .split('\n')
    .map((line) => {
      const match = /^\d+:([^:]*):(\/.*)$/.exec(line);
      if (!match) throw new Error('Invalid cgroup membership');
      return { controllers: match[1].split(','), path: validPath(match[2]) };
    });
  let cpu = false;
  let memory = false;
  for (const line of identity.mounts.trim().split('\n')) {
    const parts = line.split(' - ');
    const fields = parts.at(0)?.split(' ');
    const details = parts.at(1)?.split(' ');
    if (!fields || !details || !['cgroup', 'cgroup2'].includes(details[0])) continue;
    if (fields.length < 6 || details.length < 3) throw new Error('Invalid cgroup mount');
    const mountRoot = decodePath(fields[3]);
    const point = decodePath(fields[4]);
    const unified = details[0] === 'cgroup2';
    const controllers = details[2].split(',');
    const group = groups.find((item) =>
      unified
        ? item.controllers.join('') === ''
        : item.controllers.some((v) => controllers.includes(v)),
    );
    if (!group) continue;
    const prefix = mountRoot === '/' ? '/' : `${mountRoot}/`;
    const current =
      group.path === '/' || group.path === mountRoot
        ? point
        : posix.join(
            point,
            group.path.startsWith(prefix) ? group.path.slice(prefix.length) : group.path.slice(1),
          );
    for (let path = current; ; path = dirname(path)) {
      if (unified || controllers.includes('cpu'))
        cpu =
          (await present(resolve(root, `.${path}`, unified ? 'cpu.max' : 'cpu.cfs_quota_us'))) ||
          cpu;
      if (unified || controllers.includes('memory'))
        memory =
          (await present(
            resolve(root, `.${path}`, unified ? 'memory.max' : 'memory.limit_in_bytes'),
          )) || memory;
      if (path === point) break;
      if (path === '/' || (point !== '/' && !path.startsWith(`${point}/`)))
        throw new Error('Cgroup path left its visible mount');
    }
  }
  if (!cpu || !memory) throw new Error('Owner cgroup controllers are unconfirmed');
}

async function present(path: string): Promise<boolean> {
  try {
    const value = await readFile(path, 'utf8');
    if (!value.trim() || value.length > 1024) throw new Error('Invalid cgroup controller');
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}

function validPath(value: string): string {
  if (!value.startsWith('/') || value.split('/').includes('..') || value.includes('\0'))
    throw new Error('Invalid cgroup path');
  return value;
}
function decodePath(value: string): string {
  return validPath(
    value.replace(/\\([0-7]{3})/g, (_match, octal: string) =>
      String.fromCharCode(parseInt(octal, 8)),
    ),
  );
}
