import { Inject, Injectable } from '@nestjs/common';
import { filesystemStatsFor } from '@platform/shared-kernel';
import { SANDBOX_PROVIDER_REGISTRY } from '@platform/contracts';
import type { ProviderRegistry } from '@platform/contracts';
import { env } from '../../../config/env';
import { humanBytes, type DiagnoseCheck, type DiagnoseCheckResult } from './check.types';
import { presetImageSizeText, substrateOf } from './substrate';

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
 * 5GB —— 而 aio 档的预制镜像一张就 13GB。百分比回答「趋势」，绝对值回答「现在还能不能
 * 干活」，两个问题都要答。
 */
export const DISK_MIN_FREE_BYTES = 20 * 1024 ** 3;

/**
 * 诊断项：**磁盘余量**（P1-9：磁盘是本平台真实的瓶颈）。
 *
 * ⚠️ 量的是 **数据目录所在的文件系统**，不是根分区。平台真正会写满的是那一个：
 * 工作区副本、镜像缓存、审计库、运行日志全在数据目录下。挑错了盘的诊断会在数据盘满的
 * 时候报告「磁盘充足」。
 *
 * ── ⛔ 两句互斥的档位假设不许同屏（2026-09-11 修）───────────────────────────
 * 上一版无条件给 `docker image prune`，紧接着又无条件提「boxlite 的 rootfs 缓存实测
 * 可达 31GB」—— 一台机器只可能是其中一档，两句话必有一句在对它撒谎，而 `docker` 那句
 * 还会把一台根本没有 docker 的 mac 推向去装 docker（与 `substrate.ts` 记的是同一个坑）。
 * ⇒ 清理建议按**当前默认档**分岔。
 *
 * ⚠️ **体积按档说**：boxlite 压缩后 0.3GB、aio 13GB，差 40 倍（见 `presetImageSizeText`）。
 */
@Injectable()
export class DiskSpaceCheck implements DiagnoseCheck {
  readonly id = 'disk-space' as const;
  readonly label = '磁盘余量';

  constructor(@Inject(SANDBOX_PROVIDER_REGISTRY) private readonly providers: ProviderRegistry) {}

  async run(): Promise<DiagnoseCheckResult> {
    const root = env.dataRoot;
    const tier = this.providers.defaultProvider;
    const stats = await filesystemStatsFor(root);
    if (stats === null) {
      // 「量不到」是它自己的一种结论。假装 0 或假装充足都是撒谎，而这台机器上
      // 磁盘预检（`availableBytesFor`）此刻也同样量不到 —— 那才是要说的事。
      return {
        status: 'warn',
        headline: '量不到磁盘容量',
        detailText: `读不到数据目录（DATA_ROOT）${root} 所在文件系统的容量 —— 磁盘预检在这台机器上无法生效。`,
        nextStep: '确认数据目录指向一个存在且可读的路径。',
        command: `ls -ld ${root}`,
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
      tier,
    };
    const line =
      `${stats.probedPath}：已用 ${humanBytes(used)} / ${humanBytes(stats.totalBytes)}` +
      `（${percent.toFixed(0)}%），可用 ${humanBytes(stats.availableBytes)}。`;

    if (percent >= DISK_CRITICAL_PERCENT) {
      return {
        status: 'fail',
        headline: `磁盘已用超 ${String(DISK_CRITICAL_PERCENT)}%，挡住新任务`,
        detailText: line,
        nextStep: cleanupNextStep(tier),
        ...cleanupCommandOf(tier),
        detail,
      };
    }
    if (percent >= DISK_WARN_PERCENT || stats.availableBytes < DISK_MIN_FREE_BYTES) {
      const tooLittleFree = stats.availableBytes < DISK_MIN_FREE_BYTES;
      return {
        status: 'warn',
        headline: tooLittleFree ? '磁盘可用空间偏少' : '磁盘吃紧，建议清理',
        detailText: tooLittleFree ? `${line}${firstImageWarning(tier)}` : line,
        nextStep: cleanupNextStep(tier),
        ...cleanupCommandOf(tier),
        detail,
      };
    }
    return { status: 'ok', headline: '磁盘余量充足', detailText: line, detail };
  }
}

/**
 * 「首张预制镜像可能拉不下来」这句**只在体积真的可能不够时才说**，且体积按档取。
 *
 * ⛔ 上一版无条件写「预制镜像一张约 13GB」。boxlite 档只有 0.3GB —— 在一台还剩 5GB 的
 * mac 上，那句话把「够用」说成了「拉不下来」。
 */
function firstImageWarning(tier: string): string {
  const size = presetImageSizeText(tier);
  if (size === null) return '';
  return `这台机器的沙箱环境用的预制镜像${size}，留意首个任务下载时的余量。`;
}

/**
 * 清理建议 —— **按当前默认档分岔**，⛔ 不许把两档的假设写在同一句里。
 */
function cleanupNextStep(tier: string): string {
  const common = '先清保留卷（系统状态页「保留卷占用」）或删掉已完成任务的工作区。';
  const substrate = substrateOf(tier);
  if (substrate === 'container') {
    return `${common}这台机器的沙箱环境跑在容器里，还可以回收不用的镜像层。`;
  }
  if (substrate === 'micro-vm') {
    // ⛔ 不提 docker：这一档的宿主上通常根本没有 docker。
    return `${common}这台机器的沙箱环境把镜像下载到本机缓存里，长期不用的那些可以整体删掉。`;
  }
  return common;
}

/**
 * 容器档才给得出的那条命令 —— ⛔ 其余档位一个字都不提 docker。
 *
 * 返回的是一个**可展开的片段**而不是 `string | undefined`，这样调用点不必写
 * `...(x === undefined ? {} : { command: x })`（`exactOptionalPropertyTypes` 下那句话
 * 每次都要重写一遍）。
 */
export function cleanupCommandOf(tier: string): { command?: string } {
  return substrateOf(tier) === 'container' ? { command: 'docker image prune' } : {};
}
