import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { linuxResourceCapacity } from '../../../packages/modules/sandbox/src/infrastructure/scheduler/linux-cgroup-capacity';
import { harness, waitForStatus } from '../../support/sandbox-rig';

const roots: string[] = [];
const envKeys = ['SCHEDULER_SAFETY_MARGIN', 'SCHEDULER_CPU_OVERCOMMIT', 'WORKSPACE_MIN_FREE_BYTES'];
const saved = new Map<string, string | undefined>();
beforeEach(() => {
  for (const key of envKeys) saved.set(key, process.env[key]);
  process.env.SCHEDULER_SAFETY_MARGIN = '0';
  process.env.SCHEDULER_CPU_OVERCOMMIT = '1';
  process.env.WORKSPACE_MIN_FREE_BYTES = '0';
});
afterEach(async () => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const host = { cores: 64, ramMb: 262144 };
const v2 = '35 24 0:30 / /sys/fs/cgroup ro,nosuid,nodev,noexec - cgroup2 cgroup rw\n';
async function put(root: string, path: string, value: string) {
  const target = resolve(root, `.${path}`);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, value);
}
async function fixture(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), 'api-cgroup-capacity-'));
  roots.push(root);
  for (const [path, value] of Object.entries(files)) await put(root, path, value);
  return root;
}
function unified(files: Record<string, string>) {
  return fixture({ '/proc/self/cgroup': '0::/\n', '/proc/self/mountinfo': v2, ...files });
}

describe('container CPU/RAM limits constrain actual admission rather than host totals', () => {
  it('preserves fractional CPU and hard RAM ceilings despite oversized operator overrides', async () => {
    const root = await unified({
      '/sys/fs/cgroup/cpu.max': '250000 100000\n',
      '/sys/fs/cgroup/memory.max': String(4 * 1024 ** 3),
      '/sys/fs/cgroup/memory.current': String(512 * 1024 ** 2),
      '/sys/fs/cgroup/cpuset.cpus.effective': '0-15\n',
    });
    expect(await linuxResourceCapacity(host, { cores: 32, ramMb: 65536 }, root)).toEqual({
      cores: 2.5,
      ramMb: 4096,
    });
    expect(await linuxResourceCapacity(host, { cores: 1, ramMb: 1024 }, root)).toEqual({
      cores: 1,
      ramMb: 1024,
    });
  });

  it('feeds the measured fractional quota into real SQLite resource allocation without admitting a third VM', async () => {
    const root = await unified({
      '/sys/fs/cgroup/cpu.max': '250000 100000',
      '/sys/fs/cgroup/memory.max': String(4 * 1024 ** 3),
    });
    const h = harness({ hostCapacity: await linuxResourceCapacity(host, {}, root) });
    expect(await h.service.defaultCapacity()).toMatchObject({ maxTasks: 2, remainingTasks: 2 });
    const tasks = await Promise.all([
      h.service.create({ projectId: 'prj-1', runtime: 'claude-code' }),
      h.service.create({ projectId: 'prj-1', runtime: 'claude-code' }),
    ]);
    await Promise.all(tasks.map((task) => waitForStatus(h.service, task.id, 'running')));
    await h.service.stop(tasks[0]!.id);
    expect(await h.service.defaultCapacity()).toMatchObject({
      remainingTasks: 0,
      registeredTasks: 2,
    });
    await expect(
      h.service.create({ projectId: 'prj-1', runtime: 'claude-code' }),
    ).rejects.toMatchObject({ status: 429 });
    expect((await h.allocations.listAll()).length).toBe(2);
  });

  it('applies stricter visible ancestors through a remapped cgroup filesystem root', async () => {
    const root = await fixture({
      '/proc/self/cgroup': '0::/tenant/api\n',
      '/proc/self/mountinfo': '35 24 0:30 /tenant /sys/fs/cgroup ro - cgroup2 cgroup rw\n',
      '/sys/fs/cgroup/api/cpu.max': 'max 100000',
      '/sys/fs/cgroup/api/memory.max': String(6 * 1024 ** 3),
      '/sys/fs/cgroup/cpu.max': '150000 100000',
      '/sys/fs/cgroup/memory.max': String(2 * 1024 ** 3),
    });
    expect(await linuxResourceCapacity(host, {}, root)).toEqual({ cores: 1.5, ramMb: 2048 });
  });

  it('recognizes separate v1 CPU, memory and cpuset controller mounts', async () => {
    const root = await fixture({
      '/proc/self/cgroup':
        '2:cpu,cpuacct:/docker/owned\n3:memory:/docker/owned\n4:cpuset:/docker/owned\n',
      '/proc/self/mountinfo': [
        '35 24 0:30 /docker/owned /sys/fs/cgroup/cpu ro - cgroup cgroup rw,cpu,cpuacct',
        '36 24 0:31 /docker/owned /sys/fs/cgroup/memory ro - cgroup cgroup rw,memory',
        '37 24 0:32 /docker/owned /sys/fs/cgroup/cpuset ro - cgroup cgroup rw,cpuset',
      ].join('\n'),
      '/sys/fs/cgroup/cpu/cpu.cfs_quota_us': '150000',
      '/sys/fs/cgroup/cpu/cpu.cfs_period_us': '100000',
      '/sys/fs/cgroup/memory/memory.limit_in_bytes': String(3 * 1024 ** 3),
      '/sys/fs/cgroup/cpuset/cpuset.effective_cpus': '2-3',
    });
    expect(await linuxResourceCapacity(host, {}, root)).toEqual({ cores: 1.5, ramMb: 3072 });
    await put(root, '/sys/fs/cgroup/cpu/cpu.cfs_quota_us', '-1');
    await put(root, '/sys/fs/cgroup/memory/memory.limit_in_bytes', '9223372036854771712');
    expect(await linuxResourceCapacity(host, {}, root)).toEqual({ cores: 2, ramMb: host.ramMb });
  });

  it('does not round affinity or effective cpuset above the CPUs actually usable', async () => {
    const root = await unified({
      '/sys/fs/cgroup/cpu.max': 'max 100000',
      '/sys/fs/cgroup/memory.max': 'max',
      '/sys/fs/cgroup/cpuset.cpus.effective': '1-2,2-4,6',
    });
    expect(await linuxResourceCapacity(host, {}, root)).toEqual({ cores: 5, ramMb: host.ramMb });
    expect(await linuxResourceCapacity({ ...host, cores: 1 }, { cores: 32 }, root)).toEqual({
      cores: 1,
      ramMb: host.ramMb,
    });
    await put(root, '/sys/fs/cgroup/cpuset.cpus.effective', '');
    expect((await linuxResourceCapacity(host, {}, root)).cores).toBe(0);
  });

  it('re-reads tightened CPU/RAM limits and refuses new admission after the change', async () => {
    const root = await unified({
      '/sys/fs/cgroup/cpu.max': '400000 100000',
      '/sys/fs/cgroup/memory.max': String(4 * 1024 ** 3),
    });
    const h = harness({ hostCapacity: await linuxResourceCapacity(host, {}, root) });
    expect((await h.service.defaultCapacity()).maxTasks).toBe(4);
    await put(root, '/sys/fs/cgroup/cpu.max', '50000 100000');
    await put(root, '/sys/fs/cgroup/memory.max', String(256 * 1024 ** 2));
    Object.assign(h.hostCapacity, await linuxResourceCapacity(host, {}, root));
    expect(await h.service.defaultCapacity()).toMatchObject({ remainingTasks: 0, maxTasks: 0 });
    await expect(
      h.service.create({ projectId: 'prj-1', runtime: 'claude-code' }),
    ).rejects.toMatchObject({ status: 429 });
    expect(await h.allocations.listAll()).toEqual([]);
  });

  it('uses physical ceilings when the host has no cgroup filesystem', async () => {
    const root = await fixture({});
    expect(await linuxResourceCapacity(host, { cores: 9999, ramMb: 999999 }, root)).toEqual(host);
  });

  it.each(['bogus 100000', '100000 0', '100000', '-1 100000'])(
    'rejects malformed cpu.max %s instead of granting host capacity',
    async (quota) => {
      const root = await unified({ '/sys/fs/cgroup/cpu.max': quota });
      await expect(linuxResourceCapacity(host, {}, root)).rejects.toThrow(
        'Invalid Linux cgroup resource limit',
      );
    },
  );

  it('rejects an unreadable enabled-controller file instead of silently falling back', async () => {
    const root = await unified({ '/sys/fs/cgroup/memory.max': 'max' });
    await mkdir(join(root, 'sys/fs/cgroup/cpu.max'));
    await expect(linuxResourceCapacity(host, {}, root)).rejects.toThrow(
      'Unable to read Linux cgroup resource limits',
    );
  });
});
