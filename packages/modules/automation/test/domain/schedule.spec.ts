import { afterEach, describe, expect, it } from 'vitest';
import { Schedule } from '../../src/domain/value-objects/schedule.vo';
import { AutomationInvariantError } from '../../src/domain/errors/automation-errors';

/**
 * `Schedule.nextOccurrence` —— 25 §3.7 的 T-AUT-1..8（零 mock、零 IO、零时钟）。
 *
 * ── 每组断言钉住的变异 ──────────────────────────────────────────────────────────
 *  ① `nextOccurrence` 的「严格晚于」改成「不早于」        ⇒ T-AUT-2 红
 *  ② `wallClockToUtc` 的两趟校正砍成一趟                  ⇒ DST 那两条红
 *  ③ `nextAtLocalTime` 的「墙钟坐标 +86400000」改成「真实时刻 +24h」⇒ T-AUT-4 红
 *  ④ `partsIn` 的 `timeZone` 换成读系统时区              ⇒ T-AUT-6 红
 *  ⑤ `isIanaTimeZone` 换成正则「像不像 Area/City」        ⇒ T-AUT-8 的 `Asia/NotACity` 红
 */
const iso = (d: Date) => d.toISOString();

/** 拿一个绝对时刻当「现在」。测试自己造 `Date` 是允许的（eslint 对 test 放行）。 */
const at = (s: string) => new Date(s);

describe('Schedule —— 下一次触发时刻（只读规则自己的 timezone）', () => {
  const originalTz = process.env.TZ;
  afterEach(() => {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  it('T-AUT-1：daily 08:00 Asia/Shanghai —— 07:59 → 今天 08:00；08:01 → 明天 08:00', () => {
    const s = Schedule.create('daily', { time: '08:00' }, 'Asia/Shanghai');
    // 07:59 本地 = 23:59Z 前一天
    expect(iso(s.nextOccurrence(at('2026-03-09T23:59:00Z')))).toBe('2026-03-10T00:00:00.000Z');
    // 08:01 本地 = 00:01Z 当天
    expect(iso(s.nextOccurrence(at('2026-03-10T00:01:00Z')))).toBe('2026-03-11T00:00:00.000Z');
  });

  it('T-AUT-2：hourly minute=0，整点被问到 → 下一个整点（**不返回当前时刻**）', () => {
    const s = Schedule.create('hourly', { minute: 0 }, 'Asia/Shanghai');
    // 这一条防的是「先推进后执行」被一个「不早于」的求解器架空：返回当前时刻 ⇒
    // `next_trigger_at` 推进后仍 <= now ⇒ 下一轮扫描立刻再触发一次，一分钟一发。
    expect(iso(s.nextOccurrence(at('2026-03-10T10:00:00Z')))).toBe('2026-03-10T11:00:00.000Z');
    expect(iso(s.nextOccurrence(at('2026-03-10T10:00:00.001Z')))).toBe('2026-03-10T11:00:00.000Z');
  });

  it('hourly minute=30：10:29 → 10:30；10:31 → 11:30', () => {
    const s = Schedule.create('hourly', { minute: 30 }, 'UTC');
    expect(iso(s.nextOccurrence(at('2026-03-10T10:29:00Z')))).toBe('2026-03-10T10:30:00.000Z');
    expect(iso(s.nextOccurrence(at('2026-03-10T10:31:00Z')))).toBe('2026-03-10T11:30:00.000Z');
  });

  it('T-AUT-3：weekly [一,三,五] 08:00 —— 周三 09:00 → 本周五；周五 09:00 → 下周一', () => {
    const s = Schedule.create('weekly', { days: [1, 3, 5], time: '08:00' }, 'UTC');
    // 2026-03-11 是周三
    expect(iso(s.nextOccurrence(at('2026-03-11T09:00:00Z')))).toBe('2026-03-13T08:00:00.000Z');
    // 2026-03-13 是周五
    expect(iso(s.nextOccurrence(at('2026-03-13T09:00:00Z')))).toBe('2026-03-16T08:00:00.000Z');
  });

  it('T-AUT-4：**夏令时** daily 08:00 America/New_York —— 跨切换日仍是当地 08:00', () => {
    const s = Schedule.create('daily', { time: '08:00' }, 'America/New_York');
    // 2026-03-08 02:00 本地是美东春季跳表日（三月第二个周日）。
    // 切换**之前**：EST(UTC-5) ⇒ 3/7 的 08:00 本地 = 13:00Z
    expect(iso(s.nextOccurrence(at('2026-03-06T14:00:00Z')))).toBe('2026-03-07T13:00:00.000Z');
    // 切换**当天及之后**：EDT(UTC-4) ⇒ 08:00 本地 = 12:00Z。
    // ★ 同一条规则、同一个「当地 08:00」，UTC 时刻差了整整一小时 —— 这就是墙钟语义。
    expect(iso(s.nextOccurrence(at('2026-03-07T14:00:00Z')))).toBe('2026-03-08T12:00:00.000Z');
    expect(iso(s.nextOccurrence(at('2026-03-08T14:00:00Z')))).toBe('2026-03-09T12:00:00.000Z');
    // 秋季回拨：2026-11-01 02:00 本地回到 EST ⇒ 当天 08:00 本地 = 13:00Z
    expect(iso(s.nextOccurrence(at('2026-10-31T14:00:00Z')))).toBe('2026-11-01T13:00:00.000Z');
  });

  it('DST 空洞：daily 02:30 America/New_York 在春季跳表日不会抛，也不会漏掉那一天', () => {
    const s = Schedule.create('daily', { time: '02:30' }, 'America/New_York');
    const next = s.nextOccurrence(at('2026-03-08T00:00:00Z'));
    // 当地 02:30 那一分钟不存在（01:59:59 EST 直接跳到 03:00:00 EDT）。两趟校正稳定
    // 落到跳变**之后**的等价时刻 —— 06:30Z 就是 02:30 EDT。不抛、不漏掉这一天。
    expect(next.getTime()).toBeGreaterThan(at('2026-03-08T00:00:00Z').getTime());
    expect(iso(next)).toBe('2026-03-08T06:30:00.000Z');
  });

  it('T-AUT-5：月末 / 年末跨越', () => {
    const daily = Schedule.create('daily', { time: '23:30' }, 'UTC');
    expect(iso(daily.nextOccurrence(at('2026-01-31T23:31:00Z')))).toBe('2026-02-01T23:30:00.000Z');
    expect(iso(daily.nextOccurrence(at('2026-12-31T23:31:00Z')))).toBe('2027-01-01T23:30:00.000Z');
    // 闰年 2028-02-29
    expect(iso(daily.nextOccurrence(at('2028-02-28T23:31:00Z')))).toBe('2028-02-29T23:30:00.000Z');
  });

  it('★ T-AUT-6：把进程 TZ 改成别的时区，结果**完全不变**（I-AUT-9 的证明）', () => {
    const s = Schedule.create('daily', { time: '03:00' }, 'Asia/Shanghai');
    const after = at('2026-06-01T00:00:00Z');

    process.env.TZ = 'UTC';
    const underUtc = iso(s.nextOccurrence(after));
    process.env.TZ = 'America/New_York';
    const underNy = iso(s.nextOccurrence(after));
    process.env.TZ = 'Pacific/Kiritimati';
    const underKiritimati = iso(s.nextOccurrence(after));

    // 当地 03:00 = 前一天 19:00Z（UTC+8）
    expect(underUtc).toBe('2026-06-01T19:00:00.000Z');
    expect(underNy).toBe(underUtc);
    expect(underKiritimati).toBe(underUtc);
  });

  it('T-AUT-8：timezone 为空 / 非 IANA 名 → 构造拒绝', () => {
    expect(() => Schedule.create('daily', { time: '08:00' }, '')).toThrow(AutomationInvariantError);
    expect(() => Schedule.create('daily', { time: '08:00' }, '   ')).toThrow(
      AutomationInvariantError,
    );
    // 固定偏移拼法：表达不了夏令时，必须拒
    expect(() => Schedule.create('daily', { time: '08:00' }, 'UTC+8')).toThrow(
      AutomationInvariantError,
    );
    // ★ 形状完全合格但**不存在**的时区 —— 这一条是「用正则判 IANA」这个变异的死穴
    expect(() => Schedule.create('daily', { time: '08:00' }, 'Asia/NotACity')).toThrow(
      AutomationInvariantError,
    );
    // 真的存在的两个（含只有一个词的 UTC）要放行
    expect(() => Schedule.create('daily', { time: '08:00' }, 'UTC')).not.toThrow();
    expect(() => Schedule.create('daily', { time: '08:00' }, 'Europe/Berlin')).not.toThrow();
  });

  it('config 形状校验：daily 缺 time / weekly 缺 days / hourly minute 越界 → 拒', () => {
    expect(() => Schedule.create('daily', {}, 'UTC')).toThrow(AutomationInvariantError);
    expect(() => Schedule.create('daily', { time: '25:00' }, 'UTC')).toThrow(
      AutomationInvariantError,
    );
    expect(() => Schedule.create('weekly', { time: '08:00', days: [] }, 'UTC')).toThrow(
      AutomationInvariantError,
    );
    expect(() => Schedule.create('weekly', { time: '08:00', days: [7] }, 'UTC')).toThrow(
      AutomationInvariantError,
    );
    expect(() => Schedule.create('hourly', { minute: 60 }, 'UTC')).toThrow(
      AutomationInvariantError,
    );
  });

  it('降频（每日一次）沿用原规则的时刻，weekly 的星期限制被解除', () => {
    const weekly = Schedule.create('weekly', { days: [1], time: '08:00' }, 'UTC');
    // 2026-03-11 是周三：原调度要等到下周一，降频后当天 08:00 已过 ⇒ 明天 08:00
    expect(iso(weekly.nextDailyOccurrence(at('2026-03-11T09:00:00Z')))).toBe(
      '2026-03-12T08:00:00.000Z',
    );
    // 原 config 一个字都没改
    expect(weekly.config).toEqual({ days: [1], time: '08:00' });
    expect(weekly.kind).toBe('weekly');
  });

  it('降频（每日一次）对 hourly 规则取当天第一个小时的同一分钟', () => {
    const hourly = Schedule.create('hourly', { minute: 15 }, 'UTC');
    expect(iso(hourly.nextDailyOccurrence(at('2026-03-11T09:00:00Z')))).toBe(
      '2026-03-12T00:15:00.000Z',
    );
  });
});
