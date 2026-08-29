import { describe, it, expect } from 'vitest';
import {
  memoryStrategy,
  parseMemInfo,
  parseVmStat,
  readMemory,
  type MemorySources,
} from '../../../src/platform/system/memory.probe';
import { ramGauge } from '../../../src/platform/system/system-resources.service';

/**
 * RAM 水位（`GET /api/system/resources`）。
 *
 * ⚠️ 起因是一次**直接挡住功能**的误报：`os.totalmem() - os.freemem()` 把一台真实占用 59%
 * 的机器报成 **96.3% / critical**，而前端 `overallResourceLevel` 取三档最大值 ⇒ 整页翻成
 * 「🔴 资源耗尽，无法创建新 Task」。`os.freemem()` 返回的是「**当前完全空闲**的页」，
 * 不是「可用内存」——macOS 上把 inactive/speculative 全算成已用，Linux 上不含 buff/cache。
 *
 * ⚠️ **两个平台的分支都必须在两种机器上都验得到**，所以解析全部走纯函数 + 固定样本：
 * CI 是 Linux、开发机是 macOS，只测「当前平台那一条」等于两边各测一半 —— 上一轮
 * `reflinkStrategy` 的变异存活就是这么来的。
 */

// 真实 Linux /proc/meminfo 片段（MemFree 很小、MemAvailable 很大 —— 正是本次的病灶形态）
const MEMINFO = `MemTotal:       32770100 kB
MemFree:          812344 kB
MemAvailable:   21403992 kB
Buffers:          204800 kB
Cached:         18234880 kB
SwapCached:            0 kB
Active:          9876544 kB
Inactive:       12345678 kB
`;

// 无 MemAvailable 的老内核（< 3.14）
const MEMINFO_OLD = `MemTotal:       32770100 kB
MemFree:          812344 kB
Buffers:          204800 kB
Cached:         18234880 kB
`;

// 真实 macOS (Apple Silicon, 16K 页) vm_stat 片段
const VMSTAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                    43280.
Pages active:                                 820588.
Pages inactive:                               803419.
Pages speculative:                             20576.
Pages throttled:                                   0.
Pages wired down:                             181171.
Pages purgeable:                               32933.
File-backed pages:                            568911.
Pages occupied by compressor:                 174005.
`;

describe('parseMemInfo（Linux）', () => {
  it('⛔ 取的是 MemAvailable，不是 MemFree —— 这就是本次的病灶', () => {
    const r = parseMemInfo(MEMINFO)!;
    expect(r.availableBytes).toBe(21403992 * 1024);
    // MemFree 只有 0.77 GB，用它会把这台机器报成 97.5% 已用。
    expect(r.availableBytes).not.toBe(812344 * 1024);
    expect(r.totalBytes).toBe(32770100 * 1024);
    // 换算成水位：真实约 34.7% 已用，而 MemFree 口径会得出 97.5%。
    const used = (r.totalBytes - r.availableBytes) / r.totalBytes;
    expect(used * 100).toBeCloseTo(34.7, 0);
  });

  it('⛔ 没有 MemAvailable 时返回 null，**不退回 free+buffers+cached 那个老公式**', () => {
    // 老公式在有 cgroup / 透明大页的机器上会算偏，而算偏的方向是把机器判得更空闲
    // ——「多报是撒谎」的另一侧。MemAvailable 就是为了取代它才进内核的。
    expect(parseMemInfo(MEMINFO_OLD)).toBeNull();
  });

  it('垃圾输入回 null', () => {
    expect(parseMemInfo('')).toBeNull();
    expect(parseMemInfo('MemTotal: 100 kB')).toBeNull();
  });
});

describe('parseVmStat（macOS）', () => {
  it('free + inactive + speculative，页大小从表头取', () => {
    const r = parseVmStat(VMSTAT)!;
    expect(r.availableBytes).toBe((43280 + 803419 + 20576) * 16384);
  });

  it('⛔ **不加 purgeable** —— 它是 active/inactive 的子集，加了就是重复计数', () => {
    // 实证：free+active+inactive+speculative+throttled+wired+compressor 已经等于
    // hw.memsize，purgeable 再加一次必然溢出。
    const r = parseVmStat(VMSTAT)!;
    expect(r.availableBytes).not.toBe((43280 + 803419 + 20576 + 32933) * 16384);
  });

  it('⛔ 页大小不许写死 4096 —— Apple Silicon 是 16384，写死会差整整 4 倍', () => {
    const small = VMSTAT.replace('page size of 16384 bytes', 'page size of 4096 bytes');
    expect(parseVmStat(small)!.availableBytes).toBe((43280 + 803419 + 20576) * 4096);
  });

  it('少任何一类就回 null —— 少算一项会静默地把机器判得更满', () => {
    expect(parseVmStat(VMSTAT.replace(/^Pages inactive.*$/m, ''))).toBeNull();
    expect(parseVmStat(VMSTAT.replace(/^Pages speculative.*$/m, ''))).toBeNull();
    expect(parseVmStat('no header')).toBeNull();
  });
});

describe('memoryStrategy —— 哪个平台走哪条', () => {
  it('linux → /proc/meminfo，darwin → vm_stat，其余 → 没有可靠口径', () => {
    expect(memoryStrategy('linux')).toBe('proc-meminfo');
    expect(memoryStrategy('darwin')).toBe('vm-stat');
    expect(memoryStrategy('win32')).toBe('none');
    expect(memoryStrategy('freebsd')).toBe('none');
  });
});

function sources(over: Partial<MemorySources> = {}): MemorySources {
  return {
    readProcMeminfo: () => Promise.resolve(MEMINFO),
    runVmStat: () => Promise.resolve(VMSTAT),
    totalBytes: () => 34359738368,
    ...over,
  };
}

describe('readMemory —— 两条分支在任何一台机器上都跑得到', () => {
  it('linux 读 /proc/meminfo', async () => {
    const r = await readMemory('linux', sources());
    expect(r).toMatchObject({ kind: 'measured', availableBytes: 21403992 * 1024 });
    expect(r.kind === 'measured' && r.source).toContain('MemAvailable');
  });

  it('darwin 读 vm_stat', async () => {
    const r = await readMemory('darwin', sources());
    expect(r).toMatchObject({
      kind: 'measured',
      availableBytes: (43280 + 803419 + 20576) * 16384,
      totalBytes: 34359738368,
    });
  });

  it('不支持的平台 / 读取失败 / 解析失败 ⇒ unmeasurable（而不是猜一个数）', async () => {
    expect(await readMemory('win32', sources())).toMatchObject({ kind: 'unmeasurable' });
    expect(
      await readMemory('darwin', sources({ runVmStat: () => Promise.reject(new Error('ENOENT')) })),
    ).toMatchObject({ kind: 'unmeasurable' });
    expect(
      await readMemory('linux', sources({ readProcMeminfo: () => Promise.resolve(MEMINFO_OLD) })),
    ).toMatchObject({ kind: 'unmeasurable' });
  });
});

describe('ramGauge —— 判定链的最后一环', () => {
  const fallback = { totalBytes: 100, freeBytes: 2 }; // freemem 口径 = 98% 已用

  it('measured ⇒ 按可用内存算档', () => {
    const g = ramGauge(
      { kind: 'measured', totalBytes: 100, availableBytes: 41, source: 'x' },
      fallback,
    );
    expect(g.usedPercent).toBe(59);
    expect(g.level).toBe('ok');
  });

  it('measured 且真的紧张 ⇒ warn / critical 照常出', () => {
    expect(
      ramGauge({ kind: 'measured', totalBytes: 100, availableBytes: 15, source: 'x' }, fallback)
        .level,
    ).toBe('warn');
    expect(
      ramGauge({ kind: 'measured', totalBytes: 100, availableBytes: 2, source: 'x' }, fallback)
        .level,
    ).toBe('critical');
  });

  it('⛔ unmeasurable ⇒ level 钉在 ok，**绝不 critical**（否则平台在好机器上拒绝干活）', () => {
    const g = ramGauge({ kind: 'unmeasurable', reason: 'win32' }, fallback);
    // freemem 口径算出来是 98%，若照它判档就是 critical ⇒ 前端说「资源耗尽，无法创建新 Task」。
    expect(g.usedPercent).toBe(98);
    expect(g.level).toBe('ok');
  });
});
