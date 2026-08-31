import { cpus, totalmem } from 'node:os';
import { resolve } from 'node:path';
import { Injectable } from '@nestjs/common';
import { filesystemStatsFor } from '@platform/shared-kernel';
import type { HostCapacityProbe } from '../../domain/ports/host-capacity.port';
import type { HostCapacity } from '../../domain/services/resource-pool.domain-service';

const MIB = 1024 * 1024;

/**
 * 03 §1「启动时探测宿主机资源：`os.cpus().length` / `os.totalmem()`」+「探测：
 * `statfs(DATA_ROOT)` 取总量与已用」。
 *
 * ⚠️ **`os.cpus()` / `os.totalmem()` 在容器里会撒谎，所以三个显式覆盖是必需品而不是
 * 装饰。** 平台自己就是以 docker-compose 形态部署的（`docker-compose.yml`），而在容器
 * 内这两个 API 报的是**宿主**的核数与内存，不是 cgroup 给这个容器的限额 —— 一个被限到
 * 2 核 4GB 的 api 容器会以为自己有 64 核 512GB，然后按那个数发配额。
 * `SCHEDULER_HOST_CORES` / `SCHEDULER_HOST_RAM_MB` / `SCHEDULER_HOST_DISK_MB` 让部署方
 * 把真实限额说出来；不填就退回探测（单机裸装时探测是对的）。
 *
 * ⚠️ **每次问都真的重新量，不缓存。** 缓存一次开机时的读数，在容器里 `DATA_ROOT` 换了
 * 卷、或宿主上别的程序吃掉了半块盘之后，调度就会照着一个几小时前的世界发号施令 ——
 * 而 `statfs` + `os` 是微秒级的，省这一次没有任何收益。
 *
 * ⚠️ **量不到磁盘时给 `null` 而不是 0。** `null` 在 `snapshotOf` 里变成「这一维不设限」，
 * 0 会变成「一个字节都没有、什么都别想建」。少报是降级，多报是撒谎；这一处两个方向都
 * 有代价，而「因为量不出来所以谁都建不了」是明显更坏的那个（`availableBytesFor` 用的
 * 是同一条纪律）。
 */
@Injectable()
export class OsHostCapacityProbe implements HostCapacityProbe {
  async capacity(): Promise<HostCapacity> {
    const stats = await filesystemStatsFor(dataRoot());
    const diskOverrideMb = positive(process.env.SCHEDULER_HOST_DISK_MB);
    return {
      cores: positive(process.env.SCHEDULER_HOST_CORES) ?? cpus().length,
      ramMb: positive(process.env.SCHEDULER_HOST_RAM_MB) ?? Math.floor(totalmem() / MIB),
      diskTotalBytes:
        diskOverrideMb !== undefined
          ? diskOverrideMb * MIB
          : stats === null
            ? null
            : stats.totalBytes,
      // ⚠️ **可用空间刻意不跟着覆盖走。** 它是物理闸的输入（「盘上真的还剩多少」），
      // 而那件事没有任何声明能代替 —— 声明总量是「你能发多少配额」的策略，声明可用量
      // 就是直接对着 `statfs` 撒谎。
      diskAvailableBytes: stats === null ? null : stats.availableBytes,
    };
  }
}

function dataRoot(): string {
  return process.env.DATA_ROOT ?? resolve(process.cwd(), 'data');
}

function positive(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}
