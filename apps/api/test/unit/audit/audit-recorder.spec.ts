import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Clock } from '@platform/shared-kernel';
import type { AuditRecordInput } from '@platform/contracts';
import { DbAuditRecorder } from '../../../src/platform/audit/audit-recorder.impl';
import type { AuditRepository } from '../../../src/platform/audit/audit.repository';

/**
 * `record()` **永不抛** —— 全设计里最关键的那条契约，此前没有任何直接测试。
 *
 * ── 为什么这条必须被单独钉住 ────────────────────────────────────────────────────
 * `audit-recorder.port.ts` 的调用纪律 1 明确对调用方说「**不要**给它加 try/catch，
 * 那会让人以为它可能抛」，于是 `AuditProjector`、`ProvisionSandboxWorkflow`、
 * `RuntimeInstallOrchestrator` 全都**信任**这条契约、故意不做防御性包裹。也就是说
 * `audit-recorder.impl.ts` 里那个 catch 是「一次 CHECK 违反 / 一次磁盘满」与「打断
 * 用户正在做的业务」之间**唯一**的闸门（P21-5 §10.5：审计写入永不阻断业务）。
 *
 * 而在这个文件之前，全仓没有一条断言构造过会抛的 repo。日后有人重构删掉那个
 * try/catch，**现有测试一条都不会红** —— 直到生产上第一次磁盘满，一次审计写把一次
 * provision 掀翻。
 *
 * ── 实际验证过的变异 ────────────────────────────────────────────────────────────
 *   ① 删掉 `record()` 的 try/catch（裸 `this.repo.insert(...)`）⇒ 下面前两条红
 *      （"永不抛"与"projector 那种调用形态不受影响"）。
 *   ② 把 catch 改成静默（删掉 `this.logger.error(...)`）⇒ 第三条红。吞掉**且**不吭声
 *      等于把「审计流是空的」和「什么都没发生」混成一件事 —— 所以两半都要钉。
 */
const AT = new Date('2026-08-27T10:00:00.000Z');
const clock: Clock = { now: () => AT };

/** 一条最小合法输入；本文件关心的全在 repo 那一侧。 */
const INPUT: AuditRecordInput = {
  category: 'sandbox',
  type: 'sandbox.provision.stage',
  actor: 'scheduler',
  summary: 'provision 阶段「creating」完成',
};

/**
 * `insert()` 一定抛的假 repo。
 *
 * ⚠️ 抛的是 `SqliteError` 那一类**真实会发生**的东西的替身：CHECK 违反、`SQLITE_FULL`
 * （磁盘满）、表被并发裁剪锁住。它们的共同点是——**不是调用方能预料的参数问题**，
 * 而是写这一侧自己的故障。
 */
function throwingRepo(message: string): AuditRepository {
  const repo = {
    insert(): void {
      throw new Error(message);
    },
  };
  return repo as AuditRepository;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('DbAuditRecorder.record() —— 吞掉自己的异常，永不阻断业务', () => {
  it('repo.insert 抛出时 record() 不抛', () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const recorder = new DbAuditRecorder(
      throwingRepo('SQLITE_FULL: database or disk is full'),
      clock,
    );

    expect(() => recorder.record(INPUT)).not.toThrow();
  });

  /**
   * 调用方的真实形态：projector 在一个 batch 里逐条 `record()`，中间那条炸了，
   * 后面的还得继续 —— 而且**整个 batch 之外的业务**（已经提交的那次事务）不能被牵连。
   */
  it('连着写、每条都抛，调用方依然一条 try/catch 都不需要', () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const recorder = new DbAuditRecorder(throwingRepo('CHECK constraint failed: severity'), clock);

    expect(() => {
      for (const type of ['a', 'b', 'c']) recorder.record({ ...INPUT, type });
    }).not.toThrow();
  });

  /**
   * ⚠️ 吞掉 ≠ 静默。写不进去而没人知道，等于把「审计流是空的」和「什么都没发生」
   * 混成一件事 —— 面板上看不出区别，而这两件事的处置完全相反。
   */
  it('吞掉的同时留下一条 Logger.error，带上是哪一类事件与原因', () => {
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const recorder = new DbAuditRecorder(
      throwingRepo('SQLITE_FULL: database or disk is full'),
      clock,
    );

    recorder.record(INPUT);

    expect(error).toHaveBeenCalledTimes(1);
    const line = String(error.mock.calls[0]?.[0]);
    // 「哪一类事件」——没有它，日志里只剩一句「写失败了」，排查无从下手。
    expect(line).toContain('sandbox/sandbox.provision.stage');
    // 「为什么」——原始 message 必须留住，磁盘满和 CHECK 违反的处置完全不同。
    expect(line).toContain('SQLITE_FULL');
  });
});
