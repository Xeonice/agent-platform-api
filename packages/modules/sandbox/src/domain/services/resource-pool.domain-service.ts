import type { ResourceQuota } from '../value-objects/resource-quota.vo';

/**
 * 03 §1 的 `ResourcePoolSnapshot`，逐字段对齐。
 *
 * `total*` 已经**扣掉安全余量、算进超配比**——它是「还能发多少」，不是「这台机器有多少」。
 * 原始的宿主容量在 {@link HostCapacity} 里，两者刻意不是同一个类型：判定只该看前者，
 * 而展示（P21-5 水位）只该看后者。
 */
export interface ResourcePoolSnapshot {
  totalCores: number;
  totalRamMb: number;
  /** 磁盘进调度（审计 P1-9）：它才是本平台的真实瓶颈。 */
  totalDiskMb: number;
  usedCores: number;
  usedRamMb: number;
  usedDiskMb: number;
}

/** 一次 `statfs` + `os` 探测到的宿主事实（03 §1「启动时探测宿主机资源」）。 */
export interface HostCapacity {
  cores: number;
  ramMb: number;
  /** `statfs(DATA_ROOT).blocks × bsize`。**量不到 ⇒ `null`**，不是 0（少报是降级，多报是撒谎）。 */
  diskTotalBytes: number | null;
  /** `bavail × bsize`（非特权可用），同上。 */
  diskAvailableBytes: number | null;
}

/** 03 §2 `SchedulingStrategy.trySchedule` 的返回。 */
export type SchedulingVerdict = { ok: true } | { ok: false; reason: string };

/** 03 §1「超配策略」+「安全余量」的三个旋钮。 */
export interface SchedulingPolicy {
  /** 默认 0.15 —— 留给宿主 OS 与平台自身进程。 */
  safetyMargin: number;
  /** CPU **允许**超配（AI CLI 多为突发负载）。默认 1.5。 */
  cpuOvercommitRatio: number;
  /**
   * 物理可用空间的绝对下限（字节）。与 `WORKSPACE_MIN_FREE_BYTES` 是**同一个**旋钮
   * ——见 {@link trySchedule} ② 的注释。
   */
  minFreeDiskBytes: number;
}

export const DEFAULT_SCHEDULING_POLICY: SchedulingPolicy = {
  safetyMargin: 0.15,
  cpuOvercommitRatio: 1.5,
  minFreeDiskBytes: 1024 * 1024 * 1024,
};

const MIB = 1024 * 1024;

/**
 * 03 §1 磁盘登记的换算：`projects.baseline_size_bytes × 1.2`（空项目取配置下限）。
 *
 * ⚠️ **下限是全局下限，不只是「空项目」那一格。** 文档写的是「空项目取配置下限」，
 * 而按 `×1.2` 直算，一个 3 MB 的仓库会登记 4 MB —— 那不是这条规则要表达的意思：
 * 工作区里最终躺着的不只是基线（git 对象、依赖、构建产物、agent 写下的东西），而
 * `disk_mb_reserved > 0` 的 CHECK 也不接受向下取整成 0 的算法。取 `max(下限, ×1.2)`
 * 之后「空项目」那一格自然成立，且小仓库不会拿到一个假装精确的数。
 */
export function diskMbForBaseline(baselineSizeBytes: number | null, floorMb: number): number {
  const bytes = baselineSizeBytes ?? 0;
  return Math.max(floorMb, Math.ceil((bytes * 1.2) / MIB));
}

/**
 * 03 §1「quota 值的来源」：**用户不输入任何资源参数**，以镜像的 `resource_defaults`
 * 为基础，磁盘那一维由项目基线体积决定（上面那条）。
 *
 * ⚠️ 镜像 manifest 的 `resourceDefaults.diskMb` **刻意不参与**：那是「这张镜像自己要多大」
 * 的声明，而这里要登记的是「这一发 Task 的工作区会吃掉多少」——一个来自镜像、一个来自
 * 项目，混成一个数之后哪一边变了都说不清是谁的锅。
 */
export function planQuota(input: {
  imageDefaults: ResourceQuota;
  baselineSizeBytes: number | null;
  diskFloorMb: number;
}): ResourceQuota {
  return {
    cores: input.imageDefaults.cores,
    ramMb: input.imageDefaults.ramMb,
    diskMb: diskMbForBaseline(input.baselineSizeBytes, input.diskFloorMb),
  };
}

/**
 * 03 §1/§2 的资源池快照 —— **纯函数**，零 IO（23 §5.5）。
 *
 * `used*` 是**全部未释放登记之和**，不是「实际观测到的占用」。这是账本口径，也是
 * 唯一能在「实例还没建出来」的那一刻回答「还剩多少」的口径 —— 而那一刻正是 TOCTOU
 * 发生的地方。
 */
export function snapshotOf(
  activeQuotas: readonly ResourceQuota[],
  host: HostCapacity,
  policy: SchedulingPolicy,
): ResourcePoolSnapshot {
  const usable = 1 - policy.safetyMargin;
  return {
    totalCores: host.cores * usable * policy.cpuOvercommitRatio,
    // 内存不超配（防 OOM）、磁盘不超配（超配等于必然写满）——两者都只乘 usable。
    totalRamMb: Math.floor(host.ramMb * usable),
    totalDiskMb:
      host.diskTotalBytes === null ? Infinity : Math.floor((host.diskTotalBytes / MIB) * usable),
    usedCores: activeQuotas.reduce((s, q) => s + q.cores, 0),
    usedRamMb: activeQuotas.reduce((s, q) => s + q.ramMb, 0),
    usedDiskMb: activeQuotas.reduce((s, q) => s + q.diskMb, 0),
  };
}

/**
 * First-Fit（03 §2 默认策略）—— **纯函数**，可穷举单测。
 *
 * 两道闸，各挡各的，**都要**：
 *
 *   ① **账本闸**（`pool`）：`已登记 + 本次 ≤ 池子上限`。它挡的是**并发超分配** ——
 *      N 个同时到达的请求各自已经把自己那份写进账本，所以第 N+1 个看见的是真的余量，
 *      而不是 N 个人同时看见的那个「还很空」。这是消除 TOCTOU 的那一半。
 *
 *   ② **物理闸**（`hostAvailableDiskBytes`）：盘上真的还剩这么多吗。它挡的是**账本
 *      看不见的占用** —— 别的程序、日志、保留卷（§7.7 明确不回资源池）。账本闸对这些
 *      一无所知：一个 90% 被别人写满的盘，账本仍然显示「一条登记都没有，随便发」。
 *
 * ⚠️ ② 用的就是 `WORKSPACE_MIN_FREE_BYTES` 那个下限，**这不是巧合而是有意复用**：
 * 工作区复制前本来就有这条预检（`FsWorkspacePreparer.assertDiskSpace`），但它跑在
 * `preparing-workspace`，也就是 N 个 Task 早已一起通过之后。把同一个判据搬到互斥区里
 * 提前一次，才是 03 §1「必须进调度而不是只在准备阶段做一次预检」那句话的意思。
 * 后面那一次**不删** —— 它覆盖的是「登记之后、复制之前，别人把盘写满了」。
 */
export function trySchedule(
  request: ResourceQuota,
  pool: ResourcePoolSnapshot,
  hostAvailableDiskBytes: number | null,
  policy: SchedulingPolicy,
): SchedulingVerdict {
  if (pool.usedCores + request.cores > pool.totalCores) {
    return {
      ok: false,
      reason:
        `no CPU capacity: ${fmt(pool.usedCores)} of ${fmt(pool.totalCores)} cores are already ` +
        `reserved and this task needs ${fmt(request.cores)}`,
    };
  }
  if (pool.usedRamMb + request.ramMb > pool.totalRamMb) {
    return {
      ok: false,
      reason:
        `no memory capacity: ${fmt(pool.usedRamMb)}MB of ${fmt(pool.totalRamMb)}MB are already ` +
        `reserved and this task needs ${fmt(request.ramMb)}MB (memory is never overcommitted)`,
    };
  }
  if (pool.usedDiskMb + request.diskMb > pool.totalDiskMb) {
    return {
      ok: false,
      reason:
        `no disk capacity: ${fmt(pool.usedDiskMb)}MB of ${fmt(pool.totalDiskMb)}MB are already ` +
        `reserved and this task needs ${fmt(request.diskMb)}MB (disk is never overcommitted — ` +
        'overcommitting it means filling the disk for certain)',
    };
  }
  if (hostAvailableDiskBytes !== null && hostAvailableDiskBytes < policy.minFreeDiskBytes) {
    return {
      ok: false,
      reason:
        `the data volume has only ${String(hostAvailableDiskBytes)} bytes free, below the ` +
        `${String(policy.minFreeDiskBytes)} floor (WORKSPACE_MIN_FREE_BYTES) — the ledger has ` +
        'room but the filesystem does not',
    };
  }
  return { ok: true };
}

/** Trim float noise out of a message (`1.0499999999999998 cores` helps nobody). */
function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}
