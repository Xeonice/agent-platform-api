import { Injectable } from '@nestjs/common';
import { filesystemStatsFor } from '@platform/shared-kernel';
import { env } from '../../../config/env';
import { humanBytes, type DiagnoseCheck, type DiagnoseCheckResult } from './check.types';

/**
 * 磁盘水位阈值（P21-5 §5 状态矩阵）：<75% ✅ / 75–90% ⚠️ / ≥90% 🔴。
 * 与 `GET /api/system/resources` 共用同一组数 —— 两处各写一份就是两条会分头漂移的产品规则。
 */
export const DISK_WARN_PERCENT = 75;
export const DISK_CRITICAL_PERCENT = 90;

/**
 * 「够不够建下一个 Task」的绝对下限。
 *
 * ⚠️ 只看百分比不够：一块 4TB 盘用到 74% 还剩 1TB（宽裕），一块 20GB 盘用到 74% 只剩
 * 5GB —— 而预制镜像一张就 13GB（P21-8 §2 Step 4 实测）。百分比回答「趋势」，绝对值
 * 回答「现在还能不能干活」，两个问题都要答。
 */
export const DISK_MIN_FREE_BYTES = 20 * 1024 ** 3;

/**
 * 诊断第 ③ 项：**磁盘余量**（P1-9：磁盘是本平台真实的瓶颈）。
 *
 * ⚠️ 量的是 **`DATA_ROOT` 所在的文件系统**，不是根分区。平台真正会写满的是那一个：
 * 工作区副本、镜像 rootfs 缓存、审计库、运行日志全在 `DATA_ROOT` 下。挑错了盘的诊断
 * 会在数据盘满的时候报告「磁盘充足」。
 */
@Injectable()
export class DiskSpaceCheck implements DiagnoseCheck {
  readonly id = 'disk-space' as const;
  readonly label = '磁盘余量（DATA_ROOT）';

  async run(): Promise<DiagnoseCheckResult> {
    const root = env.dataRoot;
    const stats = await filesystemStatsFor(root);
    if (stats === null) {
      // 「量不到」是它自己的一种结论。假装 0 或假装充足都是撒谎，而这台机器上
      // 磁盘预检（`availableBytesFor`）此刻也同样量不到 —— 那才是要说的事。
      return {
        status: 'warn',
        summary: `量不到 ${root} 所在文件系统的容量 —— 磁盘预检在这台机器上无法生效`,
        hint: `确认 DATA_ROOT 指向一个存在且可读的路径：ls -ld ${root}`,
        detail: { dataRoot: root },
      };
    }
    const used = stats.totalBytes - stats.availableBytes;
    const percent = stats.totalBytes === 0 ? 0 : (used / stats.totalBytes) * 100;
    const detail = {
      dataRoot: root,
      probedPath: stats.probedPath,
      totalBytes: stats.totalBytes,
      availableBytes: stats.availableBytes,
      usedPercent: Number(percent.toFixed(1)),
    };
    const line =
      `${stats.probedPath}：已用 ${humanBytes(used)} / ${humanBytes(stats.totalBytes)}` +
      `（${percent.toFixed(0)}%），可用 ${humanBytes(stats.availableBytes)}`;

    if (percent >= DISK_CRITICAL_PERCENT) {
      return {
        status: 'fail',
        summary: `磁盘已用超 ${String(DISK_CRITICAL_PERCENT)}% —— ${line}`,
        hint: '清理保留卷（系统状态页 🎁 保留卷占用）或删除已完成的 Task 工作区；镜像层用 docker image prune 回收',
        detail,
      };
    }
    if (percent >= DISK_WARN_PERCENT || stats.availableBytes < DISK_MIN_FREE_BYTES) {
      return {
        status: 'warn',
        summary:
          stats.availableBytes < DISK_MIN_FREE_BYTES && percent < DISK_WARN_PERCENT
            ? `可用空间不足 ${humanBytes(DISK_MIN_FREE_BYTES)} —— ${line}；预制镜像一张约 13GB，首个 Task 可能拉不下来`
            : `磁盘已用超 ${String(DISK_WARN_PERCENT)}%，建议清理 —— ${line}`,
        hint: '清理保留卷（系统状态页 🎁 保留卷占用）；boxlite 的 rootfs 缓存实测可达 31GB，长期不用可整体删除',
        detail,
      };
    }
    return { status: 'ok', summary: `磁盘余量充足 —— ${line}`, detail };
  }
}
