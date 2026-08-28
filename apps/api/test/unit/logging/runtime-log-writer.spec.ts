import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeLogWriter } from '../../../src/platform/logging/runtime-log-writer';

/**
 * shared/11 §1.2.1「技术预研:轮转自己写,但有一个必踩的坑」的回归网。
 *
 * 这里的每条断言都**实际改坏被测代码验证过会红**(「它红过吗」,25 §1):
 *
 * | 变异 | 结果 |
 * |---|---|
 * | A. `enqueue` 轮转分支里的 `pending.push(line)` 改成丢弃 | ① 红(`expected 17 to be 800`) |
 * | A2. `flushPending` 改成 `buffered.slice(1)`(只丢一行,不截尾) | ① 红(`保留窗口内出现空洞:747 → 749`)—— 空洞判据本身也验过会响 |
 * | B. 轮转改成直接 `renameSync` 不 `end()`(文档里那个实测坑) | ② 红(`runtime.log 消失了`)、③ 红 |
 * | C2. `keepRotated` 从 `maxFiles - 1` 改成 `maxFiles + 1` | ③ 红 |
 * | D. `openStream` 里的 `chmodSync` 去掉、建文件时给 0o666 | ④ 红(`expected 420 to be 384`) |
 * | E. `openStream` 里 stream 的 `'error'` handler 去掉 | ⑦ 红(`Uncaught Exception: ENOENT`) |
 *
 * ⚠️ 两次「变异无效」,都记在这里:
 * - **②最初写成同步 burst,B 变异照样绿。** 原因见下面 ② 里的长注释:
 *   `createWriteStream` 的 fd 是异步开的,同步 burst 里 rename 时**没有 inode 可跟随**。
 *   现已加 `waitForBytes` 等到真落盘,B 才复现。
 * - **「`shiftFiles` 里删最旧那份的 `unlinkSync` 去掉」这条变异是等价变异,不是漏网**:
 *   POSIX 的 `rename` 本来就覆盖目标,`.1 → .2` 自然顶掉旧的 `.2`。真正能证伪上限的
 *   变异是 C2(改 `keepRotated` 本身)。
 */

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'runtime-log-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** 定宽行号 —— 每行字节数一致,轮转点才可预测。 */
const line = (n: number): string => `line-${String(n).padStart(6, '0')}`;

/** 按时间序(旧→新)把保留下来的行读出来。 */
function retainedLines(writer: RuntimeLogWriter): string[] {
  return writer
    .existingPaths()
    .flatMap((p) => readFileSync(p, 'utf8').split('\n'))
    .filter((l) => l.length > 0);
}

/** 等到 stream 真的把 fd 开好并落盘 —— 见 ② 里的长注释。 */
async function waitForBytes(path: string, atLeast: number): Promise<void> {
  const deadline = Date.now() + 2000;
  for (;;) {
    if (existsSync(path) && statSync(path).size >= atLeast) return;
    if (Date.now() > deadline) throw new Error(`${path} 迟迟没有落盘到 ${atLeast} 字节`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

function seqOf(lines: string[]): number[] {
  return lines.map((l) => {
    const m = /^line-(\d{6})$/.exec(l);
    expect(m, `不是一条完整的行: ${JSON.stringify(l)}`).not.toBeNull();
    return Number(m![1]);
  });
}

describe('RuntimeLogWriter —— 按大小轮转', () => {
  it('① 轮转窗口内零丢行:保留窗口里的行号连续、无中间空洞', async () => {
    // ⚠️ 判据是**无中间空洞**,不是「总行数 == 写入行数」——
    // 保留份数上限本来就会把最老的整份淘汰掉,拿总数去比对是一条永远红的假断言。
    const total = 800;
    const writer = new RuntimeLogWriter({ dir, maxBytes: 200, maxFiles: 5 });

    // 同步紧凑循环 = 最狠的轮转窗口压力:第一次 end() 之后剩下的几百行全部落在
    // `pending` 里,重放途中还会再次触发轮转。
    for (let i = 1; i <= total; i++) writer.write(line(i));

    await writer.whenIdle();
    await writer.close();

    const seq = seqOf(retainedLines(writer));
    expect(seq.length).toBeGreaterThan(0);
    for (let i = 1; i < seq.length; i++) {
      expect(seq[i], `保留窗口内出现空洞:${seq[i - 1]} → ${seq[i]}`).toBe(seq[i - 1]! + 1);
    }
    // 末行必须完整且是最后写进去的那一行(尾巴被吃掉同样是丢行)。
    expect(seq[seq.length - 1]).toBe(total);
  });

  it('② 轮转后 runtime.log 是一个新 inode,新写落进它(不跟着旧 inode 进 .1)', async () => {
    // ⛔ 文档实测的静默失败:renameSync 之后旧 stream 跟随 inode,
    //    runtime.log.1 = "BEFORE-1\nBEFORE-2\nAFTER-RENAME"、runtime.log 不存在。
    const writer = new RuntimeLogWriter({ dir, maxBytes: 40, maxFiles: 5 });
    writer.write('BEFORE-1');
    writer.write('BEFORE-2');
    writer.write('BEFORE-3');
    writer.write('BEFORE-4');

    // ⚠️⚠️ 这一等**不是**凑合:`createWriteStream` 的 fd 是异步打开的。
    // 一整个同步 burst 里 fd 还没开,rename 走的是「路径上没有任何人持有的文件」,
    // 流随后自己新建一份 runtime.log —— **坑根本不会复现**。
    // 本条断言最初就是这么写的:把实现改成「直接 renameSync 不 end()」后它照样绿
    //(变异无效)。等到真的落盘、真的有 inode 可跟随,变异才会红。
    await waitForBytes(writer.currentPath, 36);
    const inodeBefore = statSync(writer.currentPath).ino;

    writer.write('AFTER-RENAME');
    await writer.whenIdle();
    await writer.close();

    expect(existsSync(writer.currentPath), 'runtime.log 消失了 —— 就是那个坑').toBe(true);
    expect(readFileSync(writer.currentPath, 'utf8')).toContain('AFTER-RENAME');
    expect(readFileSync(writer.rotatedPath(1), 'utf8')).not.toContain('AFTER-RENAME');
    // 旧 inode 必须留在 .1 上;runtime.log 必须是新的一份,否则外部 tail -f 断掉。
    expect(statSync(writer.rotatedPath(1)).ino).toBe(inodeBefore);
    expect(statSync(writer.currentPath).ino).not.toBe(inodeBefore);
  });

  it('③ 保留份数上限生效:超出的 .N 被删', async () => {
    const writer = new RuntimeLogWriter({ dir, maxBytes: 100, maxFiles: 3 });
    for (let i = 1; i <= 400; i++) writer.write(line(i));
    await writer.whenIdle();
    await writer.close();

    expect(writer.existingPaths().length).toBe(3);
    expect(existsSync(writer.rotatedPath(3))).toBe(false);
  });

  it('④ 文件权限 0600、目录 0700(同 .master.key / platform.db)', async () => {
    const writer = new RuntimeLogWriter({ dir, maxBytes: 60, maxFiles: 3 });
    for (let i = 1; i <= 40; i++) writer.write(line(i));
    await writer.whenIdle();
    await writer.close();

    for (const p of writer.existingPaths()) {
      expect(statSync(p).mode & 0o777, `${p} 权限不是 0600`).toBe(0o600);
    }
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it('⑤ 重启后续写同一份,不覆盖已有内容(size 从磁盘读回)', async () => {
    const first = new RuntimeLogWriter({ dir, maxBytes: 10_000, maxFiles: 3 });
    first.write(line(1));
    await first.close();

    const second = new RuntimeLogWriter({ dir, maxBytes: 10_000, maxFiles: 3 });
    second.write(line(2));
    await second.close();

    expect(seqOf(retainedLines(second))).toEqual([1, 2]);
  });

  it('⑦ 落盘出错时降级,**不把进程带走** —— 日志是观察设施', async () => {
    // ⚠️ 这条是真踩出来的:写 logging.module.spec.ts 时 tmp 目录先于 stream 的异步
    // fd 打开被删掉,`createWriteStream` 抛了一个**没人接的 'error' 事件**,
    // vitest 报 "Uncaught Exception: ENOENT"。生产上等价的场景是磁盘满 / 目录被
    // 运维删掉 / 权限被改 —— 那时应当停止落盘并往 stderr 说一句,而不是让整台平台退出。
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      const writer = new RuntimeLogWriter({ dir, maxBytes: 1000, maxFiles: 3 });
      // 抢在异步 fd 打开之前把目录端掉。
      rmSync(dir, { recursive: true, force: true });
      expect(() => writer.write('after the disk went away')).not.toThrow();
      await new Promise((r) => setTimeout(r, 100));
      expect(stderr.mock.calls.map((c) => String(c[0])).join('')).toContain(
        'file logging disabled',
      );
      await writer.close();
    } finally {
      stderr.mockRestore();
    }
  });

  it('⑥ 单行超过 maxBytes 时照写不丢(先轮转一次,不死循环)', async () => {
    const writer = new RuntimeLogWriter({ dir, maxBytes: 20, maxFiles: 3 });
    writer.write('short');
    const huge = 'x'.repeat(200);
    writer.write(huge);
    await writer.whenIdle();
    await writer.close();

    const all = writer.existingPaths().map((p) => readFileSync(p, 'utf8'));
    expect(all.join('')).toContain(huge);
  });
});
