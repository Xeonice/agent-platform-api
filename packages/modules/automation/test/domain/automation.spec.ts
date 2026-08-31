import { describe, expect, it } from 'vitest';
import { asAutomationId, asProjectId } from '@platform/shared-kernel';
import { Automation } from '../../src/domain/entities/automation.entity';
import { AutomationInvariantError } from '../../src/domain/errors/automation-errors';
import {
  AutomationDegraded,
  AutomationDisabled,
  AutomationReenabled,
} from '../../src/domain/events/automation-events';

/**
 * 聚合根 `Automation` —— 25 §3.7 的 T-AUT-20..28（零 mock、零 IO）。
 *
 * ── 每组断言钉住的变异 ──────────────────────────────────────────────────────────
 *  ① `FailurePolicy.DEGRADE_AT` 3 → 4                   ⇒ T-AUT-20 红
 *  ② `FailurePolicy.DISABLE_AT` 10 → 11                 ⇒ T-AUT-22 红
 *  ③ `recordOutcome` 里 skipped/missed 的早退去掉        ⇒ T-AUT-24 红
 *  ④ `recordOutcome` 里 timeout 不计数（只认 failed）    ⇒ T-AUT-25 红
 *  ⑤ `enable()` 少清 `degraded` 或少清 `failureCount`    ⇒ T-AUT-26 红
 *  ⑥ `update()` 的 `patch.timezone ?? this.…timezone` 改成读入参兜底 ⇒ T-AUT-7 红
 *  ⑦ 禁用时把 `degraded` 一起清掉                        ⇒ T-AUT-22 后半红
 */
const at = (s: string) => new Date(s);
/**
 * 「现在」= 当地（Asia/Shanghai）2026-06-01 07:00，**刻意不等于**任何一个触发时刻。
 * 取整点会让「严格晚于」和「不早于」两种求解器给出同一个答案，那条断言就白写了。
 */
const T0 = at('2026-05-31T23:00:00Z');

function daily(overrides: Partial<Parameters<typeof Automation.create>[0]> = {}): Automation {
  return Automation.create({
    id: asAutomationId('aut-1'),
    projectId: asProjectId('prj-1'),
    name: 'nightly',
    runtimeId: 'codex',
    prompt: 'run the nightly checks',
    scheduleKind: 'daily',
    scheduleConfig: { time: '08:00' },
    timezone: 'Asia/Shanghai',
    timeoutMinutes: 120,
    artifactRetentionDays: 7,
    now: T0,
    ...overrides,
  });
}

/** `failed` n 次。 */
function failTimes(a: Automation, n: number, from = T0): void {
  for (let i = 0; i < n; i += 1) a.recordOutcome('failed', from);
}

describe('Automation —— 创建与不变量', () => {
  it('创建即算出 nextTriggerAt（当地 08:00 = 00:00Z）', () => {
    const a = daily();
    expect(a.nextTriggerAt?.toISOString()).toBe('2026-06-01T00:00:00.000Z');
    expect(a.enabled).toBe(true);
    expect(a.degraded).toBe(false);
    expect(a.failureCount).toBe(0);
    // MVP 唯一并发档
    expect(a.concurrency).toBe('skip');
  });

  it('T-AUT-27：timeout 45 分钟 → 拒；prompt 8001 字符 → 拒（I-AUT-5）', () => {
    expect(() => daily({ timeoutMinutes: 45 })).toThrow(AutomationInvariantError);
    expect(() => daily({ prompt: 'x'.repeat(8001) })).toThrow(AutomationInvariantError);
    // 边界：8000 恰好放行，四档都放行
    expect(() => daily({ prompt: 'x'.repeat(8000) })).not.toThrow();
    for (const m of [30, 60, 120, 240]) {
      expect(() => daily({ timeoutMinutes: m })).not.toThrow();
    }
  });

  it('artifactRetentionDays 只有 3/7/30；webhook 必须 http/https（I-AUT-6）', () => {
    expect(() => daily({ artifactRetentionDays: 14 })).toThrow(AutomationInvariantError);
    expect(() => daily({ webhookUrl: 'ftp://example.com/hook' })).toThrow(AutomationInvariantError);
    expect(() => daily({ webhookUrl: 'not a url' })).toThrow(AutomationInvariantError);
    expect(() => daily({ webhookUrl: 'https://example.com/hook' })).not.toThrow();
  });
});

describe('Automation —— 连续失败：先降频、再禁用（03 §8.4）', () => {
  it('T-AUT-20：failed ×1,2 → degraded=false；第 3 次 → degraded=true（I-AUT-2）', () => {
    const a = daily();
    failTimes(a, 2);
    expect(a.failureCount).toBe(2);
    expect(a.degraded).toBe(false);
    expect(a.pullEvents()).toHaveLength(0);

    a.recordOutcome('failed', T0);
    expect(a.failureCount).toBe(3);
    expect(a.degraded).toBe(true);
    expect(a.enabled).toBe(true); // 降频 ≠ 禁用
    expect(a.pullEvents().filter((e) => e instanceof AutomationDegraded)).toHaveLength(1);
  });

  it('T-AUT-21：降频态下 nextTriggerAt 按每日一次算，**schedule 字段未被改写**（I-AUT-3）', () => {
    const weekly = daily({ scheduleKind: 'weekly', scheduleConfig: { days: [1], time: '08:00' } });
    // 原调度：只有周一。2026-06-01 就是周一，当地 08:00 = 00:00Z
    expect(weekly.nextTriggerAt?.toISOString()).toBe('2026-06-01T00:00:00.000Z');

    failTimes(weekly, 3, at('2026-06-01T01:00:00Z'));
    expect(weekly.degraded).toBe(true);
    // 降频后：每日一次，仍是当地 08:00 ⇒ 次日 00:00Z
    expect(weekly.nextTriggerAt?.toISOString()).toBe('2026-06-02T00:00:00.000Z');
    // ★ 原 schedule 一个字都没改
    expect(weekly.schedule.kind).toBe('weekly');
    expect(weekly.schedule.config).toEqual({ days: [1], time: '08:00' });
  });

  it('T-AUT-22：降频后再失败 7 次（累计 10）→ enabled=false，**degraded 仍 true**', () => {
    const a = daily();
    failTimes(a, 9);
    expect(a.enabled).toBe(true);
    expect(a.degraded).toBe(true);

    a.recordOutcome('failed', T0);
    expect(a.failureCount).toBe(10);
    expect(a.enabled).toBe(false);
    // ★ I-AUT-2 括号里那半句：禁用时 degraded 保持 true
    expect(a.degraded).toBe(true);
    expect(a.nextTriggerAt).toBeNull();
    expect(a.pullEvents().filter((e) => e instanceof AutomationDisabled)).toHaveLength(1);
  });

  it('T-AUT-23：降频态下成功一次 → failureCount=0、degraded=false、恢复原调度', () => {
    const weekly = daily({ scheduleKind: 'weekly', scheduleConfig: { days: [1], time: '08:00' } });
    failTimes(weekly, 3, at('2026-06-01T01:00:00Z'));
    expect(weekly.nextTriggerAt?.toISOString()).toBe('2026-06-02T00:00:00.000Z');

    weekly.recordOutcome('success', at('2026-06-01T02:00:00Z'));
    expect(weekly.failureCount).toBe(0);
    expect(weekly.degraded).toBe(false);
    // 恢复原调度：下一个周一（6/8）当地 08:00 = 6/8 00:00Z
    expect(weekly.nextTriggerAt?.toISOString()).toBe('2026-06-08T00:00:00.000Z');
  });

  it('T-AUT-24：skipped 与 missed **不改变** failureCount（I-AUT-1）', () => {
    const a = daily();
    failTimes(a, 2);
    const before = a.nextTriggerAt?.toISOString();

    a.recordOutcome('skipped', T0);
    a.recordOutcome('missed', T0);
    a.recordOutcome('skipped', T0);

    expect(a.failureCount).toBe(2);
    expect(a.degraded).toBe(false);
    // 连 nextTriggerAt 都不该被它们动
    expect(a.nextTriggerAt?.toISOString()).toBe(before);
  });

  it('T-AUT-25：timeout **与 failed 同权**计入连续失败（P20 §9.9）', () => {
    const a = daily();
    a.recordOutcome('timeout', T0);
    a.recordOutcome('timeout', T0);
    a.recordOutcome('timeout', T0);
    expect(a.failureCount).toBe(3);
    expect(a.degraded).toBe(true);
  });

  it('T-AUT-26：enable() 清零 failureCount 与 degraded（I-AUT-4）', () => {
    const a = daily();
    failTimes(a, 10);
    expect(a.enabled).toBe(false);

    a.enable(at('2026-06-05T00:00:00Z'));
    expect(a.enabled).toBe(true);
    expect(a.degraded).toBe(false);
    expect(a.failureCount).toBe(0);
    expect(a.nextTriggerAt?.toISOString()).toBe('2026-06-06T00:00:00.000Z');
    expect(a.pullEvents().filter((e) => e instanceof AutomationReenabled)).toHaveLength(1);
  });

  it('disable() 把 nextTriggerAt 置空，规则不再进调度器的扫描面', () => {
    const a = daily();
    a.disable(at('2026-06-01T05:00:00Z'));
    expect(a.enabled).toBe(false);
    expect(a.nextTriggerAt).toBeNull();
  });
});

describe('Automation.update —— I-AUT-9：时区不可被隐式改写', () => {
  it('★ T-AUT-7：只改 prompt ⇒ timezone 原样保留、nextTriggerAt **未漂移**', () => {
    const a = daily();
    const before = a.nextTriggerAt?.toISOString();

    a.update({ prompt: 'a different instruction' }, at('2026-06-01T06:00:00Z'));

    expect(a.prompt).toBe('a different instruction');
    expect(a.schedule.timezone).toBe('Asia/Shanghai');
    // ★ 触发时刻一毫秒都没动
    expect(a.nextTriggerAt?.toISOString()).toBe(before);
  });

  it('★ T-AUT-7 后半：显式传新 timezone 才变，且触发时刻随之重算', () => {
    const a = daily();
    a.update({ timezone: 'America/New_York' }, at('2026-06-01T06:00:00Z'));

    expect(a.schedule.timezone).toBe('America/New_York');
    // 当地 08:00 EDT = 12:00Z
    expect(a.nextTriggerAt?.toISOString()).toBe('2026-06-01T12:00:00.000Z');
  });

  it('改 scheduleConfig（不传 timezone）⇒ 用**原来那个**时区重算，不回退到别的', () => {
    const a = daily();
    a.update({ scheduleConfig: { time: '20:00' } }, at('2026-06-01T06:00:00Z'));
    expect(a.schedule.timezone).toBe('Asia/Shanghai');
    // 当地 20:00 = 12:00Z
    expect(a.nextTriggerAt?.toISOString()).toBe('2026-06-01T12:00:00.000Z');
  });

  it('update 也守 I-AUT-5：非法 timeout / 超长 prompt 被拒，聚合状态不被改一半', () => {
    const a = daily();
    expect(() => a.update({ timeoutMinutes: 45 }, T0)).toThrow(AutomationInvariantError);
    expect(a.timeoutMinutes).toBe(120);
    expect(() => a.update({ prompt: 'x'.repeat(8001) }, T0)).toThrow(AutomationInvariantError);
    expect(a.prompt).toBe('run the nightly checks');
  });

  it('webhookUrl 传空串 = 清空（I-AUT-6：为空就不发）', () => {
    const a = daily({ webhookUrl: 'https://example.com/hook', triggerOn: 'all' });
    expect(a.webhook?.triggerOn).toBe('all');
    a.update({ webhookUrl: '' }, T0);
    expect(a.webhook).toBeNull();
  });

  it('只改 triggerOn（webhook 已存在）⇒ URL 保留', () => {
    const a = daily({ webhookUrl: 'https://example.com/hook' });
    a.update({ triggerOn: 'success' }, T0);
    expect(a.webhook?.url).toBe('https://example.com/hook');
    expect(a.webhook?.triggerOn).toBe('success');
  });
});

describe('Automation.advanceTrigger —— I-AUT-8 的聚合那一半', () => {
  it('推进到严格晚于 now 的下一个时刻', () => {
    const a = daily();
    // 到点了：nextTriggerAt = 2026-06-01T00:00:00Z，now 就是那一刻
    a.advanceTrigger(at('2026-06-01T00:00:00Z'));
    expect(a.nextTriggerAt?.toISOString()).toBe('2026-06-02T00:00:00.000Z');
  });

  it('迟到 90 分钟被推进时，也只推进到下一个**未来**时刻（不补跑）', () => {
    const a = daily();
    a.advanceTrigger(at('2026-06-01T01:30:00Z'));
    expect(a.nextTriggerAt?.toISOString()).toBe('2026-06-02T00:00:00.000Z');
  });
});
