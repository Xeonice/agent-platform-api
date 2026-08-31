import { describe, it, expect } from 'vitest';
import {
  DEFAULT_SCHEDULING_POLICY,
  diskMbForBaseline,
  planQuota,
  snapshotOf,
  trySchedule,
} from '../../src/domain/services/resource-pool.domain-service';
import type {
  HostCapacity,
  SchedulingPolicy,
} from '../../src/domain/services/resource-pool.domain-service';

/**
 * 03 §1/§2 的资源池算术 —— **纯函数，零 IO**，所以边界可以穷举（23 §5.5）。
 *
 * 这一层测的是「算得对不对」；「有没有人真的照它拒绝」是 application 层
 * （`resource-admission.spec.ts`）的事，两者刻意分开：把它们混在一起，一条被算错的
 * 边界会被上层的 mock 遮住。
 */

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

/** 一台不受任何一维限制的机器 —— 用例只把自己关心的那一维掐小。 */
const ROOMY: HostCapacity = {
  cores: 64,
  ramMb: 262_144,
  diskTotalBytes: 4 * 1024 * GIB,
  diskAvailableBytes: 2 * 1024 * GIB,
};

/** 一份**不打折**的策略，让每条断言里的算术都是可心算的。 */
const EXACT: SchedulingPolicy = {
  safetyMargin: 0,
  cpuOvercommitRatio: 1,
  minFreeDiskBytes: 0,
};

describe('03 §1 磁盘登记的换算：baseline_size_bytes × 1.2，空项目取下限', () => {
  it('空项目（0 字节）取配置下限', () => {
    expect(diskMbForBaseline(0, 512)).toBe(512);
  });

  it('**没量过**（null）与空项目落到同一个下限 —— 但两者在类型上是两件事', () => {
    expect(diskMbForBaseline(null, 512)).toBe(512);
  });

  it('★ 大仓库真的按 ×1.2 算，不是恒取下限', () => {
    // 10 GiB 的基线 ⇒ 12 GiB = 12288 MB。若实现写成「恒取下限」，这条立刻红。
    expect(diskMbForBaseline(10 * GIB, 512)).toBe(12_288);
  });

  it('★ 系数就是 1.2，不是 1.0 也不是 2.0', () => {
    // 1000 MiB × 1.2 = 1200 MiB。改成 1.0 ⇒ 1000；改成 2.0 ⇒ 2000。
    expect(diskMbForBaseline(1000 * MIB, 512)).toBe(1200);
  });

  it('小到 ×1.2 也不足下限的基线 ⇒ 仍取下限（CHECK disk_mb_reserved > 0 的那一半）', () => {
    expect(diskMbForBaseline(3 * MIB, 512)).toBe(512);
  });

  it('下限是**参数**，不是写死的 512', () => {
    expect(diskMbForBaseline(0, 2048)).toBe(2048);
  });

  it('向上取整，不向下 —— 向下会让一个 0.4MB 的基线登记 0 MB', () => {
    expect(diskMbForBaseline(MIB, 1)).toBe(2); // 1 MiB × 1.2 = 1.2 ⇒ 2
  });
});

describe('03 §1「quota 值的来源」：CPU/内存来自镜像，磁盘来自项目基线', () => {
  it('cores / ramMb 原样取镜像的 resource_defaults', () => {
    const q = planQuota({
      imageDefaults: { cores: 2, ramMb: 4096, diskMb: 99_999 },
      baselineSizeBytes: 0,
      diskFloorMb: 512,
    });
    expect(q.cores).toBe(2);
    expect(q.ramMb).toBe(4096);
  });

  it('★ 镜像自己声明的 diskMb **不参与** —— 磁盘那一维只看项目基线', () => {
    const q = planQuota({
      imageDefaults: { cores: 1, ramMb: 512, diskMb: 99_999 },
      baselineSizeBytes: 10 * GIB,
      diskFloorMb: 512,
    });
    expect(q.diskMb).toBe(12_288);
  });
});

describe('03 §1 资源池快照：used = 全部未释放登记之和', () => {
  it('三维分别累加', () => {
    const pool = snapshotOf(
      [
        { cores: 1, ramMb: 512, diskMb: 1024 },
        { cores: 0.5, ramMb: 256, diskMb: 2048 },
      ],
      ROOMY,
      EXACT,
    );
    expect(pool.usedCores).toBe(1.5);
    expect(pool.usedRamMb).toBe(768);
    expect(pool.usedDiskMb).toBe(3072);
  });

  it('★ 安全余量默认 15%，内存与磁盘都只乘它（两者都不超配）', () => {
    const pool = snapshotOf(
      [],
      { ...ROOMY, ramMb: 1000, diskTotalBytes: 1000 * MIB },
      {
        ...DEFAULT_SCHEDULING_POLICY,
      },
    );
    expect(pool.totalRamMb).toBe(850);
    expect(pool.totalDiskMb).toBe(850);
  });

  it('★ CPU **允许**超配，而且超配比乘在余量之后（03 §1 超配策略）', () => {
    const pool = snapshotOf([], { ...ROOMY, cores: 8 }, { ...DEFAULT_SCHEDULING_POLICY });
    // 8 × 0.85 × 1.5 = 10.2 —— 若谁把 CPU 也当成「不超配」，这里会是 6.8。
    expect(pool.totalCores).toBeCloseTo(10.2, 6);
  });

  it('磁盘量不到（null）⇒ 这一维不设限，而不是 0', () => {
    const pool = snapshotOf([], { ...ROOMY, diskTotalBytes: null }, EXACT);
    expect(pool.totalDiskMb).toBe(Infinity);
  });
});

describe('03 §2 First-Fit 判定：账本闸 + 物理闸', () => {
  const pool = (used: { cores?: number; ramMb?: number; diskMb?: number }, host = ROOMY) =>
    snapshotOf(
      [{ cores: used.cores ?? 0, ramMb: used.ramMb ?? 0, diskMb: used.diskMb ?? 0 }].filter(
        (q) => q.cores > 0 || q.ramMb > 0 || q.diskMb > 0,
      ),
      host,
      EXACT,
    );

  it('空池子放行', () => {
    expect(trySchedule({ cores: 1, ramMb: 512, diskMb: 512 }, pool({}), 100 * GIB, EXACT)).toEqual({
      ok: true,
    });
  });

  it('★ 边界是 `>`，不是 `>=` —— 刚好填满必须放行', () => {
    const host: HostCapacity = { ...ROOMY, ramMb: 1024 };
    const p = pool({ ramMb: 512 }, host);
    expect(trySchedule({ cores: 1, ramMb: 512, diskMb: 1 }, p, 100 * GIB, EXACT).ok).toBe(true);
    // 多一个字节就不行
    expect(trySchedule({ cores: 1, ramMb: 513, diskMb: 1 }, p, 100 * GIB, EXACT).ok).toBe(false);
  });

  it('CPU 那一维会拒，并说清是 CPU', () => {
    const v = trySchedule(
      { cores: 4, ramMb: 1, diskMb: 1 },
      pool({ cores: 62 }, { ...ROOMY, cores: 64 }),
      100 * GIB,
      EXACT,
    );
    expect(v.ok).toBe(false);
    expect(v.ok === false && v.reason).toMatch(/CPU/);
  });

  it('内存那一维会拒，并说清是内存', () => {
    const v = trySchedule(
      { cores: 1, ramMb: 4096, diskMb: 1 },
      pool({ ramMb: 900 }, { ...ROOMY, ramMb: 1024 }),
      100 * GIB,
      EXACT,
    );
    expect(v.ok).toBe(false);
    expect(v.ok === false && v.reason).toMatch(/memory/);
  });

  it('★ 磁盘那一维会拒 —— 它是本平台的真实瓶颈（审计 P1-9），不是可选的一维', () => {
    const v = trySchedule(
      { cores: 1, ramMb: 1, diskMb: 4096 },
      pool({ diskMb: 900 }, { ...ROOMY, diskTotalBytes: 1024 * MIB }),
      100 * GIB,
      EXACT,
    );
    expect(v.ok).toBe(false);
    expect(v.ok === false && v.reason).toMatch(/disk/);
  });

  it('★ 物理闸独立于账本闸：账本空空如也，但盘上真的没地方了 ⇒ 照样拒', () => {
    const v = trySchedule({ cores: 1, ramMb: 1, diskMb: 1 }, pool({}), 10 * MIB, {
      ...EXACT,
      minFreeDiskBytes: GIB,
    });
    expect(v.ok).toBe(false);
    expect(v.ok === false && v.reason).toMatch(/WORKSPACE_MIN_FREE_BYTES/);
  });

  it('物理可用量量不到（null）⇒ 物理闸不拦（量不出来的预检不该拒绝一个本来能成功的操作）', () => {
    expect(
      trySchedule({ cores: 1, ramMb: 1, diskMb: 1 }, pool({}), null, {
        ...EXACT,
        minFreeDiskBytes: GIB,
      }).ok,
    ).toBe(true);
  });
});
