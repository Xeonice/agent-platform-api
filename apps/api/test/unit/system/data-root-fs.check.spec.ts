import { describe, it, expect } from 'vitest';
import {
  reflinkOutcome,
  reflinkStrategy,
} from '../../../src/platform/system/diagnostics/checks/data-root-fs.check';

const ctx = { root: '/data', fsLabel: 'apfs', os: 'darwin' };

/**
 * `DATA_ROOT` 文件系统那一项的**说法**（第 ⑦ 项）。
 *
 * ⚠️ 本组的起因是一次误报（2026-08-28 实测，macOS/APFS）：这一项报
 * 「未知（magic 0x1a），不支持 reflink —— 每个 Task 工作区会实占一份完整副本」+
 * 「建议换 Btrfs/XFS」。两处都错：`0x1a` 是拿 **Linux 的 statfs 魔数表**去查 macOS 的
 * `f_type`（那是 vfs 类型序号，不是魔数），而 `COPYFILE_FICLONE_FORCE` 在 darwin 上恒
 * `ENOSYS` —— libuv 的 FICLONE 分支**只有 Linux 有**，那句 ENOSYS 说的是「这个平台的
 * copyFile 不实现 reflink」，不是「这个文件系统不支持克隆」（APFS 是支持 clonefile 的）。
 *
 * ⚠️ 三个分支**必须都测到，且不能依赖跑测试的机器是什么平台** —— CI 是 Linux、
 * 开发机是 macOS，只测「当前平台那一条」等于两边各测一半。所以这里测的是纯映射函数。
 */
describe('reflinkOutcome —— 三态各说各的话', () => {
  it('supported ⇒ ✅', () => {
    const r = reflinkOutcome({ kind: 'supported' }, ctx);
    expect(r.status).toBe('ok');
    expect(r.hint).toBeUndefined();
  });

  it('unsupported ⇒ ⚠️ + 换文件系统的建议（这条建议在 Linux 上是对的）', () => {
    const r = reflinkOutcome({ kind: 'unsupported', reason: 'EOPNOTSUPP' }, ctx);
    expect(r.status).toBe('warn');
    expect(r.summary).toContain('不支持 reflink');
    expect(r.hint).toContain('Btrfs');
    // 原因要带出来 —— 「为什么不支持」是排障的下一个问题。
    expect(r.summary).toContain('EOPNOTSUPP');
  });

  it('⛔ unknown ⇒ **ℹ️ 而不是 ⚠️**，且**一个字都不提换文件系统**', () => {
    const r = reflinkOutcome({ kind: 'unknown', reason: 'darwin: 不走 reflink 分支' }, ctx);
    // ⚠️ 「问不出来」既不是「支持」也不是「不支持」。渲染成 ⚠️ 会让人以为必须换文件系统，
    //    而在 macOS 上那是一件既做不到、也不需要做的事。
    expect(r.status).toBe('info');
    expect(r.hint).toBeUndefined();
    expect(r.summary).not.toContain('Btrfs');
    expect(r.summary).not.toContain('XFS');
    // 必须说清「为什么这里谈不上 CoW」，否则 ℹ️ 就是一句没有信息的话。
    expect(r.summary).toContain('不走 reflink 分支');
    expect(r.summary).toContain('不是可修的故障');
  });

  it('⛔ unknown 不许说「不支持」—— 那正是被修掉的那句错误结论', () => {
    const r = reflinkOutcome({ kind: 'unknown', reason: 'ENOSYS' }, ctx);
    expect(r.summary).not.toContain('不支持 reflink');
  });

  it('三态的 status 两两不同（合并任意两态都会在这里红）', () => {
    const s = (['supported', 'unsupported', 'unknown'] as const).map(
      (kind) => reflinkOutcome({ kind, reason: 'x' } as never, ctx).status,
    );
    expect(new Set(s).size).toBe(3);
  });
});

describe('reflinkStrategy —— 探不探由平台决定', () => {
  it('Linux 才探（那是唯一会用 cp --reflink=auto 的平台）', () => {
    expect(reflinkStrategy('linux').kind).toBe('probe');
  });

  it('⛔ 非 Linux 一律不探，且 reason 要说得出**为什么**', () => {
    // ⚠️ 这条是补一次**变异存活**：删掉短路后所有用例照旧全绿 —— 在 macOS 上兜一圈
    //    （cp 不认 --reflink → FICLONE_FORCE → ENOSYS）会落到同一个 unknown。
    //    结论碰巧一样，但 reason 从「不走 reflink 分支」退化成一个读者无从解释的 ENOSYS。
    for (const os of ['darwin', 'win32', 'freebsd']) {
      const s = reflinkStrategy(os);
      expect(s.kind).toBe('not-applicable');
      expect(s.kind === 'not-applicable' && s.reason).toContain('不走 reflink 分支');
      expect(s.kind === 'not-applicable' && s.reason).toContain(os);
    }
  });
});
