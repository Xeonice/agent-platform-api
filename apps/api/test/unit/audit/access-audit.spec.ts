import { describe, it, expect } from 'vitest';
import { AUDIT_CATEGORIES, AUDIT_ACTORS } from '@platform/contracts';
import {
  accessLockedRecord,
  lockedAttemptRecord,
  unlockFailedRecord,
  unlockSucceededRecord,
} from '../../../src/platform/access-passcode/access-audit';

/**
 * 写入口 ②（13 §2.8.2）：访问口令门的四条审计行。
 *
 * ⚠️ **口令失败整个就是失败路径**——没有聚合、没有领域事件，`AuditProjector` 什么也
 * 收不到。所以这一档只可能来自 `AUDIT_RECORDER`，也只可能在这里被断言。
 */
const FAILED_3 = { consecutiveFailures: 3, maxFailures: 5, lockedForSec: 0 };
const FAILED_5 = { consecutiveFailures: 5, maxFailures: 5, lockedForSec: 300 };

const ALL = [
  unlockSucceededRecord(),
  unlockFailedRecord(FAILED_3),
  accessLockedRecord(FAILED_5),
  lockedAttemptRecord(287),
];

describe('访问口令门的审计行（category: system）', () => {
  it('四条都落在 system 档 —— 这是该档的第一批生产者', () => {
    // `system` 在 `AUDIT_CATEGORIES` 里躺了很久，一个生产者都没有。
    expect(AUDIT_CATEGORIES).toContain('system');
    for (const r of ALL) expect(r.category).toBe('system');
  });

  it('四件事各有自己的 type，且 actor 在 AUDIT_ACTORS 里', () => {
    expect(ALL.map((r) => r.type)).toEqual([
      'system.access.unlocked',
      'system.access.unlock_failed',
      'system.access.locked',
      'system.access.locked_attempt',
    ]);
    // 清单外的 actor 会让前端 `ACTOR_LABELS` 在中文界面上漏出英文标识符。
    for (const r of ALL) expect(AUDIT_ACTORS).toContain(r.actor);
  });

  it('「门被锁上了」是 error 级，扫 severity 时看得见', () => {
    // 运维筛「仅告警」（warn ∪ error）时，「门被锁过」必须是扫得到的那一档，
    // 而不是要展开某一条 warn 的 detail 才看得见。
    expect(accessLockedRecord(FAILED_5).severity).toBe('error');
    expect(unlockFailedRecord(FAILED_3).severity).toBe('warn');
    expect(lockedAttemptRecord(287).severity).toBe('warn');
    // 成功那一条是 info：它是那串失败记录的收尾，不该在告警筛选里刷屏。
    expect(unlockSucceededRecord().severity).toBeUndefined();
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
    expect(r.detail).toEqual({ lockedForSec: 287 });
    expect(r.errorCode).toBe('PASSCODE_LOCKED');
  });

  it('⛔ 口令本身与它的任何投影都进不来：这几个函数根本不接受口令参数', () => {
    // 纪律在**签名**上成立，而不是靠下一个改这里的人记得删：长度直接把爆破空间从
    // 58^16 砍到 58^n，hash 让离线爆破变成本地算力问题，前缀两者兼得。
    for (const fn of [unlockSucceededRecord, unlockFailedRecord, accessLockedRecord]) {
      // 只有 `PasscodeFailureOutcome`（两个计数 + 锁定秒数）或零参数。
      expect(fn.length).toBeLessThanOrEqual(1);
    }
    // detail 的键名是白名单，多一个 `passcodeLength` / `passcodePrefix` 就红。
    const keys = ALL.flatMap((r) => Object.keys(r.detail ?? {}));
    expect(new Set(keys)).toEqual(new Set(['consecutiveFailures', 'maxFailures', 'lockedForSec']));
    // summary 里也不许出现任何指向口令内容的词。
    for (const r of ALL) {
      expect(r.summary).not.toMatch(/长度|前缀|后缀|hash|开头|结尾/i);
    }
  });
});
