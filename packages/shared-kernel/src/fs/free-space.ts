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
