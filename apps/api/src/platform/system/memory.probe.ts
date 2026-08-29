import { execFile } from 'node:child_process';
import { totalmem } from 'node:os';
import { readFile } from 'node:fs/promises';

/**
 * 「**可用**内存」的读数 —— `GET /api/system/resources` 的 RAM 水位唯一来源。
 *
 * ── 它修的是什么（一次直接挡住功能的误报）────────────────────────────────────
 * 第一版写的是 `os.totalmem() - os.freemem()`。⚠️ **`os.freemem()` 返回的不是「可用
 * 内存」**，而是「**当前完全空闲**的页」：
 *   · macOS 上它把 inactive / speculative（都可回收）全算成已用 —— 实测一台真实占用约
 *     59% 的机器被报成 **98%**；
 *   · Linux 上它不含 buff/cache —— 同样偏高。
 *
 * 后果不止是难看：这个数字喂给 `level`，而前端 `overallResourceLevel` 取三档的**最大值**
 * ⇒ 整页翻成 **「🔴 资源耗尽，无法创建新 Task」**。也就是说平台在一台只用了一半内存的
 * 机器上**拒绝干活**。这是同一类「把好的东西报成坏的」里代价最大的一种 —— 前两次
 * （`localhost:5001` 假阴性、APFS reflink 误报）只是误导，这一次直接挡住功能。
 *
 * ── 两个平台各自的权威口径 ──────────────────────────────────────────────────
 * · **Linux**：`/proc/meminfo` 的 **`MemAvailable`**。内核自己算好的答案，已经把可回收
 *   部分算进去了。⚠️ **不要用 `free + buffers + cached` 那个老公式**：它在有 cgroup /
 *   透明大页的机器上会算偏，而 `MemAvailable` 就是为了取代它才加进内核的。
 * · **darwin**：`vm_stat` 的 `free + inactive + speculative`。
 *
 * ⚠️ **`Pages purgeable` 刻意不加，因为它是 active/inactive 的子集，加了就是重复计数。**
 * 这不是猜的 —— 本机实测：
 *   `free + active + inactive + speculative + throttled + wired + compressor`
 *   = 31.17 GB，而 `hw.memsize` = 32.00 GB（差 0.8 GB 是两次采样之间的漂移）。
 * 各类之和已经等于总量，purgeable（0.49 GB）再加一次必然溢出。
 *
 * ── 测不准时怎么办 ──────────────────────────────────────────────────────────
 * ⚠️ **宁可如实降级，也不要用一个测不准的数字去驱动「能不能建 Task」这种硬判定。**
 * 取不到可靠口径时返回 `unmeasurable`，调用方把 `level` 钉在 `ok` —— 与 reflink 那条
 * 三态同一个纪律：「不知道」既不是「好」也不是「坏」，但它**绝不该**变成「坏」。
 */
export interface MeasuredMemory {
  kind: 'measured';
  totalBytes: number;
  availableBytes: number;
  /** 这个数字是哪来的 —— 排查下一次同类问题时的第一个线索。 */
  source: string;
}
export interface UnmeasurableMemory {
  kind: 'unmeasurable';
  reason: string;
}
export type MemoryReading = MeasuredMemory | UnmeasurableMemory;

/**
 * `/proc/meminfo` → `{ total, available }`（**纯函数**）。
 *
 * ⚠️ `MemAvailable` 缺席（内核 < 3.14）时返回 `null`，**不退回老公式**。老公式
 * （`free + buffers + cached`）在有 cgroup / 透明大页的机器上会算偏，而这个值正驱动
 * 「资源耗尽」判定 —— 算偏的方向恰好是把机器判成更空闲，那是「多报是撒谎」的另一侧。
 *
 * 单位是 kB（内核就这么写的），换算成字节。
 */
export function parseMemInfo(text: string): { totalBytes: number; availableBytes: number } | null {
  const kb = (key: string): number | null => {
    const m = new RegExp(`^${key}:\\s+(\\d+)\\s*kB`, 'm').exec(text);
    return m === null ? null : Number(m[1]) * 1024;
  };
  const totalBytes = kb('MemTotal');
  const availableBytes = kb('MemAvailable');
  if (totalBytes === null || availableBytes === null) return null;
  return { totalBytes, availableBytes };
}

/**
 * `vm_stat` → 可用字节（**纯函数**）。
 *
 * 页大小从表头那句 `(page size of 16384 bytes)` 里取 —— ⚠️ **不要写死 4096**：
 * Apple Silicon 上是 16384，写死会让这个数字差整整 4 倍。
 */
export function parseVmStat(text: string): { availableBytes: number } | null {
  const pageSize = /page size of (\d+) bytes/.exec(text);
  if (pageSize === null) return null;
  const bytes = Number(pageSize[1]);
  const pages = (label: string): number | null => {
    const m = new RegExp(`^${label}:\\s+(\\d+)\\.?\\s*$`, 'm').exec(text);
    return m === null ? null : Number(m[1]);
  };
  const free = pages('Pages free');
  const inactive = pages('Pages inactive');
  const speculative = pages('Pages speculative');
  // 三项缺任何一项都说明输出格式变了 —— 那时候「少算一项」会静默地把机器判得更满，
  // 也就是又一次把好机器报成坏的。宁可 unmeasurable。
  if (free === null || inactive === null || speculative === null) return null;
  return { availableBytes: (free + inactive + speculative) * bytes };
}

/** 平台 → 用哪条路。抽出来是为了让「哪个平台走哪条」本身可以被断言（跨平台读数最容易「本机绿、CI 没人验」）。 */
export function memoryStrategy(os: string): 'proc-meminfo' | 'vm-stat' | 'none' {
  if (os === 'linux') return 'proc-meminfo';
  if (os === 'darwin') return 'vm-stat';
  return 'none';
}

/** 依赖注入用的两个读取器 —— 让 `readMemory` 在测试里不碰真实系统。 */
export interface MemorySources {
  readProcMeminfo(): Promise<string>;
  runVmStat(): Promise<string>;
  totalBytes(): number;
}

export const systemMemorySources: MemorySources = {
  readProcMeminfo: () => readFile('/proc/meminfo', 'utf8'),
  runVmStat: () =>
    new Promise((resolve, reject) => {
      execFile('vm_stat', [], { timeout: 3000 }, (error, stdout) =>
        error ? reject(error) : resolve(stdout),
      );
    }),
  // `os.totalmem()` 是可信的（它就是物理内存总量）—— 不可信的只有 `freemem()`。
  totalBytes: () => totalmem(),
};

export async function readMemory(os: string, src: MemorySources): Promise<MemoryReading> {
  const strategy = memoryStrategy(os);
  if (strategy === 'none') {
    return { kind: 'unmeasurable', reason: `${os}: 没有可靠的「可用内存」口径` };
  }
  try {
    if (strategy === 'proc-meminfo') {
      const parsed = parseMemInfo(await src.readProcMeminfo());
      if (parsed === null) {
        return {
          kind: 'unmeasurable',
          reason:
            '/proc/meminfo 里没有 MemAvailable（内核 < 3.14）—— 不退回 free+buffers+cached 那个会算偏的老公式',
        };
      }
      return { kind: 'measured', ...parsed, source: '/proc/meminfo MemAvailable' };
    }
    const parsed = parseVmStat(await src.runVmStat());
    if (parsed === null) return { kind: 'unmeasurable', reason: 'vm_stat 输出无法解析' };
    return {
      kind: 'measured',
      totalBytes: src.totalBytes(),
      availableBytes: parsed.availableBytes,
      source: 'vm_stat free+inactive+speculative',
    };
  } catch (e) {
    return { kind: 'unmeasurable', reason: `${strategy} 读取失败：${(e as Error).message}` };
  }
}

/** DI token —— 让 e2e / 单测能塞一份确定的读数（跨平台读数最容易「本机绿、CI 没人验」）。 */
export const MEMORY_SOURCES = Symbol('MemorySources');
