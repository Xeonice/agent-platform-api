import { execFile } from 'node:child_process';
import { statfs } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * 「块计数的单位」能从 `statfs.bsize` 直接拿的上限。
 *
 * ── 为什么需要这么一条线（POSIX 的一个坑）──────────────────────────────────
 * `f_blocks` / `f_bfree` / `f_bavail` 的单位按 POSIX 是 **`f_frsize`**（基本块/片段
 * 大小），**不是 `f_bsize`**（首选 I/O 块大小）。两者在 ext4 / xfs / APFS 这些原生
 * 文件系统上**恰好相等**，所以拿 `bsize` 算了很久也一直是对的。
 *
 * ⚠️⚠️ **而 Node 的 `fs.statfs` 根本不暴露 `f_frsize`** —— 实测 v22 只有
 * `type/bsize/blocks/bfree/bavail/files/ffree` 七个字段。所以当两者不等时，
 * 光靠 statfs 是**算不出真相**的。
 *
 * ── 什么时候会不等：容器里的 bind mount ───────────────────────────────────
 * FUSE 系（virtiofs / gRPC-FUSE）把 `f_bsize` 报成一个**传输尺寸**而不是分配单元。
 * 实测（2026-09-18，两种运行时都复现）：
 *   · 容器自己的 `/`（overlayfs）        bsize=4096      ✔
 *   · bind 进来的宿主目录（OrbStack）    bsize=1048576   ⇒ 926 GB 被报成 231 TB
 *   · bind 进来的宿主目录（Docker Desktop）同上          ⇒ **虚报 256 倍**
 *
 * ⇒ 这不是某一个运行时的怪癖，**每一个 macOS 部署都中**，而 `DATA_ROOT` 恰恰就是
 * 那个 bind mount。后果不是「看板数字难看」：`availableBytesFor` 是 clone / workspace
 * 复制 / tar 解包 / 调度器容量 的预检分母，虚报 256 倍 ⇒ **所有磁盘门禁静默失效**，
 * 然后在真正写满时以 ENOSPC 收场 —— 正是这些预检存在的理由。
 *
 * ── 这条线画在 64 KiB 的依据 ──────────────────────────────────────────────
 * 真实的片段大小有物理上限：ext4 最大块 64 KiB、xfs 同、APFS 4 KiB。**没有文件系统
 * 的分配单元是 1 MiB。** 所以 `bsize > 64 KiB` 只可能是「传输尺寸」这一种含义。
 * ⛔ 别把它调大到把 1 MiB 也放进来 —— 那等于把上面那个 256 倍虚报重新放行。
 */
const MAX_PLAUSIBLE_FRAGMENT_SIZE = 65536;

/** 容量事实的两个数，单位字节。 */
interface CapacityBytes {
  totalBytes: number;
  availableBytes: number;
}

/**
 * 从 `statfs` 直接算 —— **仅当 `bsize` 确实是片段大小时**；否则 `null`（交给 df）。
 *
 * ⚠️ `bavail` 而不是 `bfree`，理由见 {@link availableBytesFor} 抬头那一段。
 * ⚠️ `Number()` 包一层：`statfs` 在不同平台上返回 bigint 或 number，混用会算错。
 */
function capacityFromStatfs(fs: {
  blocks: number | bigint;
  bavail: number | bigint;
  bsize: number | bigint;
}): CapacityBytes | null {
  const unit = Number(fs.bsize);
  if (!Number.isFinite(unit) || unit <= 0 || unit > MAX_PLAUSIBLE_FRAGMENT_SIZE) return null;
  return {
    totalBytes: Number(fs.blocks) * unit,
    availableBytes: Number(fs.bavail) * unit,
  };
}

/**
 * 问 `df` 要真相 —— 只在 `statfs.bsize` 不可用时走这条（见
 * {@link MAX_PLAUSIBLE_FRAGMENT_SIZE}）。
 *
 * **为什么是 df**：它就是 POSIX 里干这件事的工具，而且它用的正是 Node 不给我们的
 * `f_frsize`。实测同一个 bind mount 上 `df -h` 报 927G（对），而 `blocks × bsize`
 * 报 231 TB（错）—— 差的就是这一位。
 *
 * ⚠️ `-P` 不能省：它保证**每个文件系统一行**（没有它，长设备名会折行，解析就碎了）。
 * `-k` 把单位钉死成 1024 字节，免得踩到 `BLOCKSIZE` / `DF_BLOCK_SIZE` 环境变量。
 *
 * ⚠️ 正则锚在 `<数字>%` 上而不是按空格切列：文件系统名**可以含空格**
 * （OrbStack 的这一栏就叫 `mac`，而别的运行时可能更花哨），按列切会错位。
 * 容量百分比那一列的形状是唯一的，拿它当锚点最稳。
 */
async function capacityFromDf(path: string): Promise<CapacityBytes | null> {
  try {
    const { stdout } = await execFileAsync('df', ['-k', '-P', path], {
      timeout: 5000,
      windowsHide: true,
    });
    // `<fs…> <1024-blocks> <used> <available> <pct>% <mount…>`
    const m = /\s(\d+)\s+(\d+)\s+(\d+)\s+\d+%\s/.exec(stdout);
    if (m === null) return null;
    return { totalBytes: Number(m[1]) * 1024, availableBytes: Number(m[3]) * 1024 };
  } catch {
    return null;
  }
}

/**
 * Bytes an unprivileged process may still write under `path`.
 *
 * ★ 2026-08 从 `project/…/baseline-dir.manager.ts` 提到 shared-kernel。两个磁盘预检
 * （clone 前、workspace 复制前，03 §7.2★ / §7.6）分属 project 与 sandbox 两个模块，
 * 不能互相 import；各写一份 statfs 就是两份会分头漂移的算术，而这段算术有两个不显眼
 * 的讲究，任何一份写错都不会有测试发现。
 *
 * ⚠️ **`bavail` 而不是 `bfree`，这一位是有代价的。** `bfree` 是"空闲块"，`bavail` 是
 * "非特权用户可用的空闲块"——差值是文件系统给 root 留的保留块（ext4 默认 5%）。平台
 * 进程不是 root，用 `bfree` 会把那 5% 算成自己能用的：一个 200 GiB 的盘上是 10 GiB 的
 * 虚账，预检放行，然后 clone 在写到最后时 ENOSPC。挑 `bfree` 不会有任何测试变红——除非
 * 有一条专门盯着这一位的。
 *
 * ⚠️ **祖先回溯不是兜底分支，是常规路径。** 预检跑在目标目录**被创建之前**（这正是
 * "预"的含义），所以 `statfs(dest)` 几乎总是 ENOENT。真正要量的是"这个路径将来会落在
 * 哪个文件系统上"，答案在最近的一个已存在的祖先上。把这段当成 edge case 删掉，预检就
 * 变成永远返回 `Infinity` 的空操作——**而且是静默的**：它只会放行，永不误报。
 *
 * ⚠️ **量不到就返回 `Infinity`（= 不拦）。** 一个量不出来的预检不该拒绝一个本来能成功的
 * 操作。真正的"盘满"由事后的 ENOSPC 分类兜底（`error.classifier.ts` /
 * `classifyWorkspacePrepareError`），那条路一直在。
 */
export async function availableBytesFor(path: string): Promise<number> {
  const stats = await filesystemStatsFor(path);
  // `null` = 量不到（祖先全 ENOENT，或 bsize 不可信且 df 也答不上来）⇒ 不拦，见抬头。
  return stats === null ? Number.POSITIVE_INFINITY : stats.availableBytes;
}

/** 一个路径所在文件系统的容量事实。`total === null` ⇒ **量不到**，不是 0。 */
export interface FilesystemStats {
  /** 真正被 `statfs` 量到的那个已存在的祖先路径 —— 报给用户时要说清量的是哪儿。 */
  probedPath: string;
  totalBytes: number;
  /** 非特权可用（`bavail`），与 {@link availableBytesFor} 同一位。 */
  availableBytes: number;
  /** Linux 的 `statfs.type` 魔数；其它平台可能是 0/undefined。 */
  fsTypeMagic?: number;
}

/**
 * 与 {@link availableBytesFor} 同一次祖先回溯，但把**总容量**也带出来 —— 水位需要分母。
 *
 * ⚠️ **量不到时返回 `null`，不返回 `{total: 0}`。** 0 会让水位算成 `used/0`，UI 上是
 * `NaN%` 或 `Infinity%`；而「这台机器我量不出来」是一个诚实且可渲染的状态。
 * 少报是降级，多报是撒谎 —— 这里连报都不报。
 *
 * ⚠️ **{@link availableBytesFor} 现在直接委托给本函数**（2026-09-18 起）。此前两者各写
 * 一遍祖先回溯 + 算术，是「两份会分头漂移」的典型形状 —— 而那段算术的讲究已经从两个
 * 涨到三个（`bavail` 而非 `bfree`、目标目录可能还不存在、`bsize` 未必是片段大小），
 * 任何一份写漏都不会有测试发现。⛔ 别再把它拆回两份实现。
 */
export async function filesystemStatsFor(path: string): Promise<FilesystemStats | null> {
  let probe = resolve(path);
  for (;;) {
    try {
      const fs = await statfs(probe);
      // 先试 statfs 自己（原生文件系统上这一条永远成立，零额外开销、行为与历史一致）；
      // `bsize` 不是片段大小时才去问 df（见 MAX_PLAUSIBLE_FRAGMENT_SIZE）。
      const capacity = capacityFromStatfs(fs) ?? (await capacityFromDf(probe));
      // ⚠️⚠️ **两条都答不上来时回 `null`，⛔ 不要退回 `blocks × bsize`。**
      //   那个值不是「精度差一点」，是**已知虚报 256 倍**，而它的下游是 clone /
      //   workspace 复制 / 调度器容量的预检分母 —— 报一个已知错的大数，等于把这些门
      //   全部静默打开。与本文件一贯的口径一致：少报是降级，多报是撒谎，这里连报都不报。
      if (capacity === null) return null;
      return {
        probedPath: probe,
        totalBytes: capacity.totalBytes,
        availableBytes: capacity.availableBytes,
        fsTypeMagic: typeof fs.type === 'number' ? fs.type : undefined,
      };
    } catch {
      const parent = dirname(probe);
      if (parent === probe) return null;
      probe = parent;
    }
  }
}
