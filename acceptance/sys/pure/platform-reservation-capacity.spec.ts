import { describe, expect, it } from 'vitest';
import {
  capacityOf,
  snapshotOf,
  trySchedule,
} from '../../../packages/modules/sandbox/src/domain/services/resource-pool.domain-service';
import type {
  HostCapacity,
  PoolReservation,
  SchedulingPolicy,
} from '../../../packages/modules/sandbox/src/domain/services/resource-pool.domain-service';

// Production parameters: API container cgroup 6 CPU / 14 GiB, default safety margin,
// SCHEDULER_CPU_OVERCOMMIT=1 (Dockerfile.api), default image 2 CPU / 2048 MiB, empty project.
const GIB = 1024 ** 3;
const host: HostCapacity = {
  cores: 6,
  ramMb: 14_336,
  diskTotalBytes: 200 * GIB,
  diskAvailableBytes: 150 * GIB,
};
const policy: SchedulingPolicy = {
  safetyMargin: 0.15,
  cpuOvercommitRatio: 1,
  minFreeDiskBytes: GIB,
};
const task = { cores: 2, ramMb: 2_048, diskMb: 512 };
const helper: PoolReservation[] = [
  { label: '帐号登录环境', quota: { cores: 1, ramMb: 512, diskMb: 0 } },
];

function capacity(quota: typeof task, active: (typeof task)[], reserved: PoolReservation[]) {
  const pool = snapshotOf(active, host, policy, reserved);
  return {
    pool,
    ...capacityOf(quota, pool, host.diskAvailableBytes, policy, active.length, reserved),
  };
}

describe('the resident auth helper is reserved out of the scheduling pool, not the ledger', () => {
  it('shrinks the CPU and memory pool by exactly the reservation and leaves disk alone', () => {
    const without = snapshotOf([], host, policy);
    const withHelper = snapshotOf([], host, policy, helper);
    expect(without.totalCores).toBeCloseTo(5.1, 10);
    expect(withHelper.totalCores).toBeCloseTo(4.1, 10);
    expect([without.totalRamMb, withHelper.totalRamMb]).toEqual([12_185, 11_673]);
    expect(withHelper.totalDiskMb).toBe(without.totalDiskMb);
    expect(withHelper).toMatchObject({ usedCores: 0, usedRamMb: 0, usedDiskMb: 0 });
  });

  it('keeps the production default admission unchanged: two tasks at most, one left beside a stopped one', () => {
    expect(capacity(task, [], []).maxTasks).toBe(2);
    expect(capacity(task, [], helper)).toMatchObject({ maxTasks: 2, remainingTasks: 2 });
    expect(capacity(task, [task], [])).toMatchObject({ remainingTasks: 1, registeredTasks: 1 });
    expect(capacity(task, [task], helper)).toMatchObject({ remainingTasks: 1, registeredTasks: 1 });
    const full = capacity(task, [task, task], helper);
    expect(full).toMatchObject({ remainingTasks: 0, registeredTasks: 2 });
    expect(full.pool.totalCores - full.pool.usedCores).toBeCloseTo(0.1, 10);
    expect(trySchedule(task, full.pool, host.diskAvailableBytes, policy)).toMatchObject({
      ok: false,
      reason: expect.stringContaining('no CPU capacity: 4 of 4.10 cores'),
    });
  });

  it.each([
    [{ cores: 2.5, ramMb: 2_048, diskMb: 512 }, 2, 1],
    [{ cores: 1, ramMb: 1_024, diskMb: 512 }, 5, 4],
  ])(
    'quota %j loses exactly the slot the reservation occupies (%i -> %i)',
    (quota, before, after) => {
      expect(capacity(quota, [], []).maxTasks).toBe(before);
      expect(capacity(quota, [], helper).maxTasks).toBe(after);
    },
  );

  it('a reservation larger than the pool clamps it to zero instead of going negative', () => {
    const huge: PoolReservation[] = [
      { label: '帐号登录环境', quota: { cores: 64, ramMb: 65_536, diskMb: 0 } },
    ];
    const result = capacity(task, [], huge);
    expect(result.pool).toMatchObject({ totalCores: 0, totalRamMb: 0 });
    expect(result).toMatchObject({ maxTasks: 0, remainingTasks: 0 });
  });

  it('states the reservation in the capacity basis only when there is one', () => {
    expect(capacity(task, [], helper).basis).toContain(
      '已为平台常驻的帐号登录环境预留 1 核 CPU、512 MB 内存',
    );
    expect(capacity(task, [], []).basis).not.toContain('预留');
  });
});
