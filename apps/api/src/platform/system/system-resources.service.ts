import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { cpus, freemem, loadavg, platform, totalmem } from 'node:os';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { inArray, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { DATABASE, filesystemStatsFor, fromEpochMs } from '@platform/shared-kernel';
import { sandboxes } from '@platform/sandbox';
import type { ResourceLevel, SystemResourcesDto } from '@platform/contracts';
import { env } from '../config/env';
import { MEMORY_SOURCES, readMemory, type MemoryReading, type MemorySources } from './memory.probe';
import { DISK_CRITICAL_PERCENT, DISK_WARN_PERCENT } from './diagnostics/checks/disk-space.check';

type Db = BetterSQLite3Database<Record<string, never>>;

/** CPU/RAM 三态（P21-5 §5）：<80% ✅ / 80–95% ⚠️ / ≥95% 🔴。 */
const COMPUTE_WARN_PERCENT = 80;
const COMPUTE_CRITICAL_PERCENT = 95;
/** 保留卷占 DATA_ROOT 总容量 ≥80% 触发治理横幅（P21-5 §5）。 */
const RETAINED_WARN_PERCENT = 80;
/** 调度时扣掉的系统保留比例（P21-8 §7）。 */
const RESERVED_PERCENT = 15;
/** 成果卷保留 30 天（P21-5 §6 倒计时）。 */
const RETENTION_DAYS = 30;

/**
 * 「活跃 Task」的状态集合 —— P21-5 §3 那句「当前活跃 Task: 5」数的就是它们。
 *
 * ⚠️ `pending` / `scheduling` 也算：它们已经占着调度队列的位置，用户在列表里也看得到
 * 它们。数漏了会让「还能再发几个 Task」这个页面要回答的问题得到一个偏乐观的答案。
 * 终态（`stopped` / `failed` / `destroyed`）与正在拆的（`destroying`）不算。
 */
const ACTIVE_STATUSES = [
  'pending',
  'scheduling',
  'preparing-workspace',
  'creating',
  'starting',
  'running',
  'idle',
  'stopping',
] as const;

/** 工作区状态文件（`FsWorkspacePreparer` 写的）；内容为 `kept` 即「保留卷」。 */
const WORKSPACE_STATE_FILE = '.platform-workspace-state';
/** 遍历上限 —— 一次 30s 轮询不该把事件循环耗在 `stat` 上。超了就如实标 `truncated`。 */
const RETAINED_SCAN_MAX_ENTRIES = 20_000;

/**
 * `GET /api/system/resources` —— 资源池水位（P21-5 §3，审计 P1-9）。
 *
 * ⚠️ **磁盘是本平台真实的瓶颈**，不是凑数的第三条水位。实测量级：预制镜像约 13GB、
 * boxlite 的 rootfs 缓存 31GB、每个 Task 还有一份工作区副本（P21-8 §2 Step 4）。
 * CPU/RAM 到顶的表现是「新 Task 排队」，磁盘到顶的表现是 **clone 写到最后 ENOSPC**、
 * 镜像拉一半失败 —— 后者既更常见也更难自我解释。
 *
 * ⚠️ **三态判定在服务端算好再下发**，前端不重算。阈值是产品规则（P21-5 §5），
 * 抄到第二个地方就会有第二套阈值 —— 而两套阈值不一致时，页面上的颜色与横幅会互相打脸。
 */
@Injectable()
export class SystemResourcesService {
  private readonly logger = new Logger('SystemResources');

  constructor(
    @Inject(DATABASE) private readonly db: Db,
    /**
     * 内存读取器。⚠️ 端口化不是仪式：这是**跨平台读数**，而 CI 是 Linux、开发机是 macOS
     * —— 直接调系统调用意味着两条分支各只有一半机器验得到，另一半永远没人跑。
     */
    @Inject(MEMORY_SOURCES) private readonly memorySources: MemorySources,
  ) {}

  /** RAM 水位。测量走端口，**判定走纯函数** —— 见 `ramGauge`。 */
  private async readRam(): Promise<SystemResourcesDto['ram']> {
    const reading = await readMemory(platform(), this.memorySources);
    if (reading.kind === 'unmeasurable') {
      this.logger.warn(
        `无法测量可用内存（${reading.reason}）—— usedPercent 退化为 os.freemem() 口径（已知偏高），` +
          'level 已钉在 ok，不据此判定「资源耗尽」',
      );
    }
    return ramGauge(reading, { totalBytes: totalmem(), freeBytes: freemem() });
  }

  async snapshot(): Promise<SystemResourcesDto> {
    const cores = Math.max(cpus().length, 1);
    const load = loadavg()[0] ?? 0;
    const cpuPercent = (load / cores) * 100;

    const ram = await this.readRam();

    const disk = await filesystemStatsFor(env.dataRoot);
    const diskTotal = disk?.totalBytes ?? 0;
    const diskAvailable = disk?.availableBytes ?? 0;
    const diskUsed = Math.max(diskTotal - diskAvailable, 0);
    const diskPercent = diskTotal === 0 ? 0 : (diskUsed / diskTotal) * 100;

    const retained = await this.scanRetainedVolumes();
    const retainedPercent = diskTotal === 0 ? 0 : (retained.totalBytes / diskTotal) * 100;

    return {
      cpu: {
        cores,
        loadAvg1m: round(load, 2),
        usedPercent: round(cpuPercent, 1),
        level: computeLevel(cpuPercent),
      },
      ram,
      disk: {
        path: disk?.probedPath ?? env.dataRoot,
        totalBytes: diskTotal,
        usedBytes: diskUsed,
        availableBytes: diskAvailable,
        usedPercent: round(diskPercent, 1),
        level: diskLevel(diskPercent),
        reservedPercent: RESERVED_PERCENT,
      },
      retainedVolumes: {
        count: retained.count,
        totalBytes: retained.totalBytes,
        percentOfDisk: round(retainedPercent, 1),
        level: retainedPercent >= RETAINED_WARN_PERCENT ? 'warn' : 'ok',
        ...(retained.oldestKeptAt === null
          ? {}
          : {
              oldestExpiresAt: fromEpochMs(
                retained.oldestKeptAt.getTime() + RETENTION_DAYS * 86_400_000,
              ).toISOString(),
            }),
        truncated: retained.truncated,
      },
      activeTasks: this.countActiveTasks(),
    };
  }

  private countActiveTasks(): number {
    const rows = this.db
      .select({ n: sql<number>`count(*)` })
      .from(sandboxes)
      .where(inArray(sandboxes.status, [...ACTIVE_STATUSES]))
      .all();
    return Number(rows[0]?.n ?? 0);
  }

  /**
   * 保留卷统计。
   *
   * ⚠️ **「保留卷」是有定义的，不是「workspaces 下的所有目录」**：`FsWorkspacePreparer`
   * 在 `cleanup({keep:true})` 时把状态文件写成 `kept`。还在跑的 Task 的工作区是
   * `ready`，把它们算进「30 天后会被清理的成果」是两重错误 —— 数字虚高，而且会让用户
   * 以为清理动作会波及正在跑的任务。
   *
   * ⚠️ **`blocks * 512` 而不是 `size`**：稀疏文件与 reflink 共享的块上，`size` 会把
   * 「逻辑大小」当成占用 —— 而这一项存在的理由正是回答「删了能腾出多少」。CoW 加速开着
   * 的时候两者能差一个量级。
   *
   * ⚠️ **截断要如实报**（`truncated`）。少报是降级，多报是撒谎：说「45GB」而实际扫了
   * 一半，用户清完发现没腾出预期的空间，此后不会再信这个数字。
   */
  private async scanRetainedVolumes(): Promise<{
    count: number;
    totalBytes: number;
    oldestKeptAt: Date | null;
    truncated: boolean;
  }> {
    const root = join(env.dataRoot, 'workspaces');
    let entries: string[];
    try {
      entries = await readdir(root);
    } catch {
      // 目录还不存在（全新部署）⇒ 一份保留卷都没有。这不是错误。
      return { count: 0, totalBytes: 0, oldestKeptAt: null, truncated: false };
    }
    let count = 0;
    let totalBytes = 0;
    let oldest: Date | null = null;
    let budget = RETAINED_SCAN_MAX_ENTRIES;
    let truncated = false;
    for (const name of entries) {
      const dir = join(root, name);
      const stateFile = join(dir, WORKSPACE_STATE_FILE);
      let state: string;
      try {
        state = (await readFile(stateFile, 'utf8')).trim();
      } catch {
        continue;
      }
      if (state !== 'kept') continue;
      count += 1;
      try {
        const st = await stat(stateFile);
        if (oldest === null || st.mtime < oldest) oldest = st.mtime;
      } catch {
        /* 拿不到保留时刻不影响体积统计 */
      }
      const sized = await dirDiskUsage(dir, budget);
      totalBytes += sized.bytes;
      budget -= sized.visited;
      if (sized.truncated || budget <= 0) {
        truncated = true;
        break;
      }
    }
    return { count, totalBytes, oldestKeptAt: oldest, truncated };
  }
}

/** 递归实占字节。`budget` 是**共享**预算 —— 一个巨大的工作区不该把其余的挤掉统计机会。 */
async function dirDiskUsage(
  dir: string,
  budget: number,
): Promise<{ bytes: number; visited: number; truncated: boolean }> {
  let bytes = 0;
  let visited = 0;
  const stack = [dir];
  while (stack.length > 0) {
    if (visited >= budget) return { bytes, visited, truncated: true };
    const current = stack.pop()!;
    let items;
    try {
      items = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const item of items) {
      visited += 1;
      const full = join(current, item.name);
      if (item.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!item.isFile()) continue;
      try {
        const st = await stat(full);
        bytes += st.blocks * 512;
      } catch {
        /* 文件在遍历途中消失是正常的 */
      }
    }
  }
  return { bytes, visited, truncated: false };
}

function computeLevel(percent: number): ResourceLevel {
  if (percent >= COMPUTE_CRITICAL_PERCENT) return 'critical';
  if (percent >= COMPUTE_WARN_PERCENT) return 'warn';
  return 'ok';
}

function diskLevel(percent: number): ResourceLevel {
  if (percent >= DISK_CRITICAL_PERCENT) return 'critical';
  if (percent >= DISK_WARN_PERCENT) return 'warn';
  return 'ok';
}

function round(v: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

/**
 * 读数 → RAM 水位（**纯函数**，三个分支零 IO 可穷举）。
 *
 * ⚠️ 抽出来的理由与 `reflinkOutcome` 一模一样，而且更硬：这是**跨平台读数**，CI 是 Linux、
 * 开发机是 macOS —— 把判定留在 `readRam` 里，就意味着「测不准该怎么办」这条分支
 * **在两边都没有人跑**。上一轮已经在 `reflinkStrategy` 上吃过一次「变异存活」。
 *
 * ⛔ **测不准时 `level` 钉在 `ok`。** 这个 `level` 经前端 `overallResourceLevel`（取三档
 * 最大值）直接决定页面说不说「资源耗尽，无法创建新 Task」—— 让一个测不准的读数把机器
 * 判成耗尽，代价是平台在一台好机器上**拒绝干活**。`usedPercent` 仍给出 `os.freemem()`
 * 口径的数字（那是唯一还剩的），但它**已知偏高**，所以不拿它判档。
 */
export function ramGauge(
  reading: MemoryReading,
  fallback: { totalBytes: number; freeBytes: number },
): SystemResourcesDto['ram'] {
  if (reading.kind === 'measured') {
    const used = Math.max(reading.totalBytes - reading.availableBytes, 0);
    const percent = reading.totalBytes === 0 ? 0 : (used / reading.totalBytes) * 100;
    return {
      totalBytes: reading.totalBytes,
      usedBytes: used,
      usedPercent: round(percent, 1),
      level: computeLevel(percent),
    };
  }
  const used = Math.max(fallback.totalBytes - fallback.freeBytes, 0);
  return {
    totalBytes: fallback.totalBytes,
    usedBytes: used,
    usedPercent: round(fallback.totalBytes === 0 ? 0 : (used / fallback.totalBytes) * 100, 1),
    level: 'ok',
  };
}
