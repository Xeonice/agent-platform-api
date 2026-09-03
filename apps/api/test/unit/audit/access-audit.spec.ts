import { describe, it, expect } from 'vitest';
import { AUDIT_CATEGORIES, AUDIT_ACTORS } from '@platform/contracts';
import type { AuditRecordInput } from '@platform/contracts';
import {
  accessLockedRecord,
  lockedAttemptRecord,
  passcodeChangedRecord,
  unlockFailedRecord,
  unlockSucceededRecord,
} from '../../../src/platform/access-passcode/access-audit';

/**
 * 写入口 ②（13 §2.8.2）：访问口令门的五个生产者（门上的四条 + 换锁那一条）。
 *
 * ⚠️ **口令失败整个就是失败路径**——没有聚合、没有领域事件，`AuditProjector` 什么也
 * 收不到。所以这一档只可能来自 `AUDIT_RECORDER`，也只可能在这里被断言。
 */
const FAILED_3 = { consecutiveFailures: 3, maxFailures: 5, lockedForSec: 0 };
const FAILED_5 = { consecutiveFailures: 5, maxFailures: 5, lockedForSec: 300 };

/**
 * ⚠️ **函数而不是 module 级常量，这是刻意的。**
 * 写成 `const ALL = [...]` 时这些调用发生在**模块加载期**，而 Stryker 的 `perTest`
 * 是在每个用例开始前才激活变异体 ⇒ 这一批记录早就构造完了，改 `category` / `type`
 * 字面量**一个用例都不会红**。2026-09-03 的全仓基线里 `access-audit.ts` 21 个存活
 * 变异体，绝大多数是这一个写法造成的测量盲区（同文件里在 `it` 内部调用的
 * `severity` / `type` 断言全部 Killed，对照极其干净）。
 * ⇒ 断言本身没问题，但**在模块顶层构造被测对象会让变异测量看不见它**。
 */
const all = (): AuditRecordInput[] => [
  unlockSucceededRecord(),
  unlockFailedRecord(FAILED_3),
  accessLockedRecord(FAILED_5),
  lockedAttemptRecord(287),
  passcodeChangedRecord('enable'),
  passcodeChangedRecord('regenerate'),
  passcodeChangedRecord('disable'),
];

describe('访问口令门的审计行（category: system）', () => {
  it('全部落在 system 档 —— 这是该档的第一批生产者', () => {
    // `system` 在 `AUDIT_CATEGORIES` 里躺了很久，一个生产者都没有。
    expect(AUDIT_CATEGORIES).toContain('system');
    for (const r of all()) expect(r.category).toBe('system');
  });

  it('每件事各有自己的 type，且 actor 在 AUDIT_ACTORS 里', () => {
    // ⚠️ 逐字锁死：`type` 是面板筛选与 11 §3.1 排障口径的**主键**，写错一个字母
    // 「昨晚有人在试口令吗」就永远筛不出来，而且不会有任何东西报错。
    expect(all().map((r) => r.type)).toEqual([
      'system.access.unlocked',
      'system.access.unlock_failed',
      'system.access.locked',
      'system.access.locked_attempt',
      'system.access.passcode_changed',
      'system.access.passcode_changed',
      'system.access.passcode_changed',
    ]);
    // 清单外的 actor 会让前端 `ACTOR_LABELS` 在中文界面上漏出英文标识符。
    for (const r of all()) expect(r.actor).toBe('user');
    for (const r of all()) expect(AUDIT_ACTORS).toContain(r.actor);
  });

  it('outcome 把「成功」与「失败」分开 —— 面板按它上色，也按它筛', () => {
    // 此前一条都没断言过：三条失败记录里任何一条把 `outcome` 写成 `'ok'`，
    // 一次爆破就会混在正常操作里，而 severity 只回答「有多响」，不回答「成没成」。
    expect(unlockSucceededRecord().outcome).toBe('ok');
    expect(unlockFailedRecord(FAILED_3).outcome).toBe('failed');
    expect(accessLockedRecord(FAILED_5).outcome).toBe('failed');
    expect(lockedAttemptRecord(287).outcome).toBe('failed');
    // 换锁本身是一次成功的管理操作，不是失败。
    for (const a of ['enable', 'regenerate', 'disable'] as const) {
      expect(passcodeChangedRecord(a).outcome).toBe('ok');
    }
  });

  it('「门被锁上了」是 error 级，扫 severity 时看得见', () => {
    // 运维筛「仅告警」（warn ∪ error）时，「门被锁过」必须是扫得到的那一档，
    // 而不是要展开某一条 warn 的 detail 才看得见。
    expect(accessLockedRecord(FAILED_5).severity).toBe('error');
    expect(unlockFailedRecord(FAILED_3).severity).toBe('warn');
    expect(lockedAttemptRecord(287).severity).toBe('warn');
    // 成功那一条是 info：它是那串失败记录的收尾，不该在告警筛选里刷屏。
    expect(unlockSucceededRecord().severity).toBeUndefined();
    // 而成功那一条的 summary 要说得出「解锁了」——它是那串失败记录的收尾。
    expect(unlockSucceededRecord().summary).toBe('访问口令校验通过，已解锁');
  });

  it('「门被锁上了」写得出锁了多久 —— 否则看不出这次锁定的窗口', () => {
    const r = accessLockedRecord(FAILED_5);
    expect(r.summary).toBe('访问口令连续错误 5 次，已锁定 300 秒');
    expect(r.detail).toEqual({ consecutiveFailures: 5, lockedForSec: 300 });
    expect(r.errorCode).toBe('PASSCODE_LOCKED');
    // 码不拼进 summary 散文（`AuditRecordInput.errorCode` 的纪律）。
    expect(r.summary).not.toContain('PASSCODE_LOCKED');
  });

  it('失败那一条写得出「连续第几次」—— 这是唯一回答得了「试了多少次」的数', () => {
    // 单机私有化部署没有用户身份可记（11 §3.1 没有用户系统），IP 在 NAT 后面也几乎
    // 不携带信息。能答的两问是「什么时候」（audit_events.at）与「试了多少次」。
    const r = unlockFailedRecord(FAILED_3);
    expect(r.summary).toBe('访问口令错误（连续第 3 次，满 5 次锁定）');
    expect(r.detail).toEqual({ consecutiveFailures: 3, maxFailures: 5 });
    expect(r.errorCode).toBe('PASSCODE_INVALID');
    // 码不拼进 summary 散文（`AuditRecordInput.errorCode` 的纪律）。
    expect(r.summary).not.toContain('PASSCODE_INVALID');
  });

  it('锁定期内再试是单独一条 —— 这些尝试压根不进 limiter 的计数', () => {
    // controller 在查锁定时就抛了，`recordFailure` 不会被调用 ⇒ 不记就彻底没有，
    // 而「被锁之后还在敲」正是「有人在爆破」最硬的信号。
    const r = lockedAttemptRecord(287);
    expect(r.type).toBe('system.access.locked_attempt');
    expect(r.summary).toBe('锁定期内再次提交访问口令，剩余 287 秒');
    expect(r.detail).toEqual({ lockedForSec: 287 });
    expect(r.errorCode).toBe('PASSCODE_LOCKED');
  });

  /**
   * ⭐ `passcodeChangedRecord` 此前**一个单测都没有**（全仓变异基线里它整段 NoCoverage）。
   * 而按文件自己的注释，它比上面四条更该有：那四条记的是「有人在门上试」，
   * 这一条记的是「门锁本身被换掉了」——包括 `disable` 那次，也就是平台从此对任何人
   * 敞开的那一刻。没有它，事后唯一的痕迹是 `system_settings` 里一个会被覆盖、
   * `disable` 时还会被清成 NULL 的时间戳。
   */
  describe('门锁本身被换掉（PUT /api/system/access-passcode）', () => {
    it('⭐ 只有 disable 是 error 级 —— 运维筛「仅告警」要扫得到「防护被关了」', () => {
      expect(passcodeChangedRecord('disable').severity).toBe('error');
      // 而「防护被开了」不该跟着一起刷进告警筛选。
      expect(passcodeChangedRecord('enable').severity).toBe('info');
      expect(passcodeChangedRecord('regenerate').severity).toBe('info');
    });

    it('三个动作各说各的话，且 detail 带得出是哪一个', () => {
      expect(passcodeChangedRecord('enable').summary).toBe(
        '已启用访问口令（新口令仅在本次响应中回显一次）',
      );
      expect(passcodeChangedRecord('regenerate').summary).toBe(
        '已重新生成访问口令，旧口令即刻失效（已通过的会话不受影响）',
      );
      // ⭐ 这一句是全文件最要紧的一行文案：它是「平台从此对任何人敞开」的唯一记录。
      expect(passcodeChangedRecord('disable').summary).toBe(
        '已关闭访问口令，此后任何人可访问本实例',
      );
      for (const a of ['enable', 'regenerate', 'disable'] as const) {
        expect(passcodeChangedRecord(a).detail).toEqual({ action: a });
      }
    });
  });

  it('⛔ 口令本身与它的任何投影都进不来：这几个函数根本不接受口令参数', () => {
    // 纪律在**签名**上成立，而不是靠下一个改这里的人记得删：长度直接把爆破空间从
    // 58^16 砍到 58^n，hash 让离线爆破变成本地算力问题，前缀两者兼得。
    for (const fn of [
      unlockSucceededRecord,
      unlockFailedRecord,
      accessLockedRecord,
      lockedAttemptRecord,
      passcodeChangedRecord,
    ]) {
      // 只有 `PasscodeFailureOutcome`（两个计数 + 锁定秒数）或零参数。
      expect(fn.length).toBeLessThanOrEqual(1);
    }
    // detail 的键名是白名单，多一个 `passcodeLength` / `passcodePrefix` 就红。
    const keys = all().flatMap((r) => Object.keys(r.detail ?? {}));
    expect(new Set(keys)).toEqual(
      new Set(['consecutiveFailures', 'maxFailures', 'lockedForSec', 'action']),
    );
    // summary 里也不许出现任何指向口令内容的词。
    for (const r of all()) {
      expect(r.summary).not.toMatch(/长度|前缀|后缀|hash|开头|结尾/i);
    }
  });
});
