import { statfs } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

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
  let probe = resolve(path);
  for (;;) {
    try {
      const fs = await statfs(probe);
      return Number(fs.bavail) * Number(fs.bsize);
    } catch {
      const parent = dirname(probe);
      // `dirname('/') === '/'` — the loop's only exit when nothing is statable.
      if (parent === probe) return Number.POSITIVE_INFINITY;
      probe = parent;
    }
  }
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
 * ⚠️ 祖先回溯与 {@link availableBytesFor} 共享同一段逻辑不是巧合：两份各写一遍的
 * `statfs` 就是两份会分头漂移的算术，而那段算术有两个不显眼的讲究（`bavail` 而非
 * `bfree`、目标目录可能还不存在），任何一份写错都不会有测试发现。
 */
export async function filesystemStatsFor(path: string): Promise<FilesystemStats | null> {
  let probe = resolve(path);
  for (;;) {
    try {
      const fs = await statfs(probe);
      return {
        probedPath: probe,
        totalBytes: Number(fs.blocks) * Number(fs.bsize),
        availableBytes: Number(fs.bavail) * Number(fs.bsize),
        fsTypeMagic: typeof fs.type === 'number' ? fs.type : undefined,
      };
    } catch {
      const parent = dirname(probe);
      if (parent === probe) return null;
      probe = parent;
    }
  }
}
