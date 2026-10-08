import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SandboxFacadeAdapter } from '../../../packages/modules/sandbox/src/application/sandbox-facade.adapter';
import { harness, waitForStatus } from '../../support/sandbox-rig';

const saved = new Map<string, string | undefined>();
const keys = ['SCHEDULER_SAFETY_MARGIN', 'SCHEDULER_CPU_OVERCOMMIT', 'WORKSPACE_MIN_FREE_BYTES'];
beforeEach(() => {
  for (const key of keys) saved.set(key, process.env[key]);
  process.env.SCHEDULER_SAFETY_MARGIN = '0';
  process.env.SCHEDULER_CPU_OVERCOMMIT = '1';
  process.env.WORKSPACE_MIN_FREE_BYTES = '0';
});
afterEach(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const input = { projectId: 'prj-1', runtime: 'claude-code' };
describe('readonly default task capacity shares the actual admission rules', () => {
  it.each([
    { host: { cores: 2.5 }, expected: 2, basis: 'CPU' },
    { host: { ramMb: 1_600 }, expected: 3, basis: '内存' },
    { host: { diskTotalBytes: 1_600 * 1024 ** 2 }, expected: 3, basis: '磁盘' },
  ])('matches default creates up to the $basis bottleneck', async ({ host, expected, basis }) => {
    const h = harness({ hostCapacity: host });
    const facade = new SandboxFacadeAdapter(
      h.repo,
      h.registry,
      h.workspace,
      h.uow,
      h.service,
      h.waiting,
    );
    const initial = await facade.defaultCapacity();
    expect(initial).toMatchObject({
      remainingTasks: expected,
      registeredTasks: 0,
      maxTasks: expected,
    });
    expect(initial.basis).toContain(basis);
    expect(h.provider.calls).toEqual([]);
    expect((await h.repo.findAll()).length).toBe(0);
    expect(await h.allocations.listAll()).toEqual([]);
    expect(h.schedulerQueue.snapshot().admitted).toEqual({ create: 0, destroy: 0, reconcile: 0 });
    const ids: string[] = [];
    for (let n = 0; n < expected; n++) {
      ids.push((await h.service.create(input)).id);
      expect((await facade.defaultCapacity()).remainingTasks).toBe(expected - n - 1);
    }
    await Promise.all(ids.map((id) => waitForStatus(h.service, id, 'running')));
    await h.service.stop(ids[0]!);
    expect(await facade.defaultCapacity()).toMatchObject({
      remainingTasks: 0,
      registeredTasks: expected,
      maxTasks: expected,
    });
    await expect(h.service.create(input)).rejects.toMatchObject({ status: 429 });
    await h.service.destroy(ids[0]!);
    expect(await facade.defaultCapacity()).toMatchObject({
      remainingTasks: 1,
      registeredTasks: expected - 1,
    });
  });

  it('the resident helper reservation moves the 429 to exactly where the read-only capacity reaches zero', async () => {
    const reservation = {
      owner: 'auth-helper',
      label: '帐号登录环境',
      quota: { cores: 1, ramMb: 512, diskMb: 0 },
    };
    expect((await harness({ hostCapacity: { cores: 3 } }).service.defaultCapacity()).maxTasks).toBe(
      3,
    );
    const h = harness({ hostCapacity: { cores: 3 }, reservations: [reservation] });
    const initial = await h.service.defaultCapacity();
    expect(initial).toMatchObject({ remainingTasks: 2, registeredTasks: 0, maxTasks: 2 });
    expect(initial.basis).toContain('已为平台常驻的帐号登录环境预留 1 核 CPU、512 MB 内存');
    const ids: string[] = [];
    for (let n = 0; n < 2; n++) {
      ids.push((await h.service.create(input)).id);
      expect(await h.service.defaultCapacity()).toMatchObject({
        remainingTasks: 1 - n,
        registeredTasks: n + 1,
      });
    }
    await expect(h.service.create(input)).rejects.toMatchObject({ status: 429 });
    expect((await h.allocations.listAll()).map((row) => row.sandboxId).sort()).toEqual(
      [...ids].sort(),
    );
    await Promise.all(ids.map((id) => waitForStatus(h.service, id, 'running')));
  });

  it('separates the physical disk floor from the theoretical maximum', async () => {
    process.env.WORKSPACE_MIN_FREE_BYTES = String(1024 ** 3);
    const h = harness({ hostCapacity: { ramMb: 4_096, diskAvailableBytes: 512 * 1024 ** 2 } });
    const capacity = await h.service.defaultCapacity();
    expect(capacity).toMatchObject({ remainingTasks: 0, registeredTasks: 0, maxTasks: 8 });
    expect(capacity.basis).toContain('数据目录磁盘可用空间 512 MB，低于最低余量 1024 MB');
    await expect(h.service.create(input)).rejects.toMatchObject({ status: 429 });
    h.hostCapacity.diskAvailableBytes = 2 * 1024 ** 3;
    expect(await h.service.defaultCapacity()).toMatchObject({ remainingTasks: 8, maxTasks: 8 });
  });

  it('uses the selected default image quota and configured safety policy', async () => {
    process.env.SCHEDULER_SAFETY_MARGIN = '0.25';
    const h = harness({ hostCapacity: { ramMb: 4_096 } });
    const resolve = h.imageFacade.resolveForTask;
    h.imageFacade.resolveForTask = async (...args) => {
      const image = await resolve(...args);
      return {
        ...image,
        manifest: {
          ...image.manifest,
          resourceDefaults: { cores: 1, ramMb: 1_024, diskMb: 9_999 },
        },
      };
    };
    expect(await h.service.defaultCapacity()).toMatchObject({ remainingTasks: 3, maxTasks: 3 });
    const task = await h.service.create(input);
    expect((await h.allocations.listAll())[0]?.quota).toEqual({
      cores: 1,
      ramMb: 1_024,
      diskMb: 512,
    });
    expect((await h.service.defaultCapacity()).remainingTasks).toBe(2);
    await waitForStatus(h.service, task.id, 'running');
  });
});
