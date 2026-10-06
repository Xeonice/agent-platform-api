import { readFile, stat } from 'node:fs/promises';
import { dirname, join, posix, resolve } from 'node:path';

interface CpuMemoryCapacity {
  cores: number;
  ramMb: number;
}

interface CgroupMount {
  root: string;
  point: string;
  version: 1 | 2;
  controllers: string[];
}

/** Visible cgroup ancestors can only restrict a descendant's resource budget. */
export async function linuxResourceCapacity(
  host: CpuMemoryCapacity,
  overrides: Partial<CpuMemoryCapacity> = {},
  filesystemRoot = '/',
): Promise<CpuMemoryCapacity> {
  const file = (absolute: string) => resolve(filesystemRoot, `.${absolute}`);
  const membership = await optionalText(file('/proc/self/cgroup'));
  const mountInfo = await optionalText(file('/proc/self/mountinfo'));
  let cores = Math.min(host.cores, overrides.cores ?? Infinity);
  let ramMb = Math.min(host.ramMb, overrides.ramMb ?? Infinity);
  if (membership === null || mountInfo === null) return { cores, ramMb };

  const groups = membership
    .trim()
    .split('\n')
    .map((line) => {
      const match = /^\d+:([^:]*):(\/.*)$/.exec(line);
      if (!match || !validPath(match[2]!)) throw invalidLimit();
      return { controllers: match[1]!.split(',').filter(Boolean), path: match[2]! };
    });
  for (const mount of cgroupMounts(mountInfo)) {
    const group = groups.find((candidate) =>
      mount.version === 2
        ? candidate.controllers.length === 0
        : candidate.controllers.some((controller) => mount.controllers.includes(controller)),
    );
    if (!group) continue;
    const current = mountedGroupPath(group.path, mount);
    if (!(await stat(file(current))).isDirectory()) throw invalidLimit();
    for (const directory of ancestors(current, mount.point)) {
      if (mount.version === 2 || mount.controllers.includes('cpu')) {
        const quota =
          mount.version === 2
            ? await cpuMax(file(join(directory, 'cpu.max')))
            : await cpuV1(file(directory));
        if (quota !== undefined) cores = Math.min(cores, quota);
      }
      if (mount.version === 2 || mount.controllers.includes('cpuset')) {
        const effective =
          (await optionalText(file(join(directory, 'cpuset.cpus.effective')))) ??
          (await optionalText(file(join(directory, 'cpuset.effective_cpus'))));
        const raw = effective ?? (await optionalText(file(join(directory, 'cpuset.cpus'))));
        if (effective !== null || raw?.trim()) {
          cores = Math.min(cores, raw?.trim() ? cpuSetSize(raw.trim()) : 0);
        }
      }
      if (mount.version === 2 || mount.controllers.includes('memory')) {
        const raw = await optionalText(
          file(join(directory, mount.version === 2 ? 'memory.max' : 'memory.limit_in_bytes')),
        );
        if (raw !== null && !(mount.version === 2 && raw.trim() === 'max')) {
          ramMb = Math.min(ramMb, Number(unsigned(raw.trim()) / BigInt(1024 ** 2)));
        }
      }
    }
  }
  return { cores, ramMb };
}

async function optionalText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw new Error('Unable to read Linux cgroup resource limits');
  }
}

function validPath(path: string): boolean {
  return path.startsWith('/') && !path.split('/').includes('..') && !path.includes('\0');
}

function decodeMountPath(path: string): string {
  const decoded = path.replace(/\\([0-7]{3})/g, (_match, octal: string) =>
    String.fromCharCode(parseInt(octal, 8)),
  );
  if (!validPath(decoded)) throw invalidLimit();
  return decoded;
}

function cgroupMounts(text: string): CgroupMount[] {
  const mounts: CgroupMount[] = [];
  for (const line of text.trim().split('\n')) {
    const parts = line.split(' - ');
    const fields = parts[0]?.split(' ');
    const details = parts[1]?.split(' ');
    if (!fields || !details || !['cgroup', 'cgroup2'].includes(details[0]!)) continue;
    if (fields.length < 6 || details.length < 3) throw invalidLimit();
    mounts.push({
      root: decodeMountPath(fields[3]!),
      point: decodeMountPath(fields[4]!),
      version: details[0] === 'cgroup2' ? 2 : 1,
      controllers: details[2]!.split(','),
    });
  }
  return mounts;
}

function mountedGroupPath(group: string, mount: CgroupMount): string {
  // A private cgroup namespace exposes its own group as '/' even when the mount
  // root names the original host group. Bare-host paths are relative to that root.
  if (group === '/' || group === mount.root) return mount.point;
  const prefix = mount.root === '/' ? '/' : `${mount.root}/`;
  return posix.join(
    mount.point,
    group.startsWith(prefix) ? group.slice(prefix.length) : group.slice(1),
  );
}

function ancestors(current: string, boundary: string): string[] {
  const paths: string[] = [];
  for (let path = current; ; path = dirname(path)) {
    paths.push(path);
    if (path === boundary) return paths;
    if (path === '/' || (boundary !== '/' && !path.startsWith(`${boundary}/`)))
      throw invalidLimit();
  }
}

async function cpuMax(path: string): Promise<number | undefined> {
  const raw = await optionalText(path);
  if (raw === null) return undefined;
  const fields = raw.trim().split(/\s+/);
  if (fields.length !== 2) throw invalidLimit();
  const period = positive(fields[1]!);
  return fields[0] === 'max' ? undefined : positive(fields[0]!) / period;
}

async function cpuV1(directory: string): Promise<number | undefined> {
  const [quota, period] = await Promise.all([
    optionalText(join(directory, 'cpu.cfs_quota_us')),
    optionalText(join(directory, 'cpu.cfs_period_us')),
  ]);
  if (quota === null && period === null) return undefined;
  if (quota === null || period === null) throw invalidLimit();
  const duration = positive(period.trim());
  return quota.trim() === '-1' ? undefined : positive(quota.trim()) / duration;
}

function cpuSetSize(raw: string): number {
  const ranges = raw.split(',').map((entry) => {
    const match = /^(\d+)(?:-(\d+))?$/.exec(entry);
    if (!match) throw invalidLimit();
    const start = Number(unsigned(match[1]!));
    const end = Number(unsigned(match[2] ?? match[1]!));
    if (!Number.isSafeInteger(end) || start > end) throw invalidLimit();
    return { start, end };
  });
  ranges.sort((a, b) => a.start - b.start);
  let last = -1;
  let count = 0;
  for (const { start, end } of ranges) {
    count += Math.max(0, end - Math.max(start, last + 1) + 1);
    last = Math.max(last, end);
  }
  return count;
}

function unsigned(raw: string): bigint {
  if (!/^\d+$/.test(raw)) throw invalidLimit();
  return BigInt(raw);
}

function positive(raw: string): number {
  const value = Number(unsigned(raw));
  if (!Number.isSafeInteger(value) || value <= 0) throw invalidLimit();
  return value;
}

function invalidLimit(): Error {
  return new Error('Invalid Linux cgroup resource limit');
}
