import { fromEpochMs } from '@platform/shared-kernel';
import { AutomationInvariantError } from '../errors/automation-errors';

/**
 * ⚠️ 这两个类型在 domain 里**重新声明**，不从 `@platform/contracts` import —— domain
 * 层按 01 §3 的分层规则不许依赖 contracts（eslint `boundaries/element-types` 会拦）。
 * 与 `retained-volume.entity.ts` 里 `RetainedVolumeSource` 的做法一致。取值口径见
 * 13 §2.7.1 的 CHECK。
 */
export type ScheduleKind = 'hourly' | 'daily' | 'weekly';

export interface ScheduleConfig {
  /** `hourly`：每小时的第几分钟（0–59）。 */
  minute?: number;
  /** `daily` / `weekly`：`HH:mm` 本地墙钟。 */
  time?: string;
  /** `weekly`：0(周日)–6(周六)，可多选。 */
  days?: number[];
}

/** 求解上限。日/周两档一次跨越最多用到 8 次迭代，`hourly` 最多 25 次；72 是安全裕量。 */
const MAX_STEPS = 72;

const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * `Schedule`（23 §11.3 三个值对象里最重的一个）。
 *
 * ★ **时区快照语义（I-AUT-9 / 03 §8.1）——本文件存在的全部理由。**
 * `nextOccurrence()` **只读 `this.timezone`**：不读服务器系统时区、不读 `TZ` 环境变量、
 * 不读请求方时区。这是它「纯函数」性质的一部分 —— 同一个 `(schedule, after)` 在任何
 * 机器上、任何 `TZ` 下必须得到**同一个**结果（25 T-AUT-6 就是拿 `TZ` 改成
 * `America/New_York` 之后重算来证明这一条的）。
 *
 * ⚠️ **求值语义是「本地墙钟」，不是「固定 UTC 偏移」。** 「每天 08:00」在
 * `America/New_York` 永远是**当地** 08:00，UTC 偏移随夏令时自己变（25 T-AUT-4）。
 * 所以算法不能写成「取一次偏移再加减」——那会在 DST 切换日把任务挪走一小时。下面
 * `wallClockToUtc` 是「先猜后校正」两趟：拿墙钟当 UTC 猜一个瞬间、问那个瞬间该时区的
 * 真实偏移、按偏移修正、再问一次确认。两趟足够：偏移只在 DST 边界变化，而修正量本身
 * 小于一天。
 */
export class Schedule {
  private constructor(
    readonly kind: ScheduleKind,
    readonly config: Readonly<ScheduleConfig>,
    readonly timezone: string,
  ) {}

  /**
   * 构造即校验（T-AUT-8）。**非 IANA 名当场拒**，而不是等到调度器某个凌晨算不出
   * 下一次触发时刻才发现 —— 那时错误已经离它的成因十万八千里。
   */
  static create(kind: ScheduleKind, config: ScheduleConfig, timezone: string): Schedule {
    if (timezone.trim() === '') {
      throw new AutomationInvariantError('timezone is required and must be an IANA name (I-AUT-9)');
    }
    if (!isIanaTimeZone(timezone)) {
      throw new AutomationInvariantError(
        `timezone '${timezone}' is not an IANA time zone name (I-AUT-9). ` +
          `Fixed-offset spellings like 'UTC+8' are rejected on purpose: they cannot express ` +
          `daylight saving, and this rule must keep firing at the same LOCAL wall clock.`,
      );
    }
    const normalized = normalizeConfig(kind, config);
    return new Schedule(kind, Object.freeze(normalized), timezone);
  }

  /**
   * 严格晚于 `after` 的下一个触发时刻（UTC）。
   *
   * ⚠️ **严格晚于，不是「不早于」**（T-AUT-2）：`hourly minute=0` 在 10:00:00 整点被
   * 问到时必须回 11:00，回 10:00 会让调度器把刚刚触发过的那一刻又排一次，
   * 「先推进后执行」（I-AUT-8）也就白推了。
   */
  nextOccurrence(after: Date): Date {
    switch (this.kind) {
      case 'hourly':
        return this.nextHourly(after);
      case 'daily':
        return this.nextDaily(after);
      case 'weekly':
        return this.nextWeekly(after);
    }
  }

  /**
   * 降频态（I-AUT-3）下的下一次：**每日一次，沿用原规则的时刻**。
   *
   * ⚠️ **原 `kind`/`config` 一个字都不改** —— 恢复时直接按原配置重算（03 §8.4）。
   * 降频只影响「下一次算在哪」，不影响「规则是什么」。
   *
   * `hourly` 规则降频到哪个小时：它的 config 只约束**分钟**，小时本就不受约束，
   * 所以取当天的第一个小时 `00:MM`。这不是随手挑的——「沿用原规则的时刻」对 hourly
   * 而言就只有那个分钟数，剩下的自由度必须由平台定一个稳定值，否则同一条规则会
   * 每天漂到不同的小时。
   */
  nextDailyOccurrence(after: Date): Date {
    const { hour, minute } = this.dailyWallClock();
    return this.nextAtLocalTime(after, hour, minute, () => true);
  }

  private nextHourly(after: Date): Date {
    const minute = this.config.minute ?? 0;
    const parts = this.partsAt(after);
    let cursor = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, minute, 0, 0);
    for (let step = 0; step < MAX_STEPS; step += 1) {
      const utc = this.wallClockToUtc(cursor);
      if (utc.getTime() > after.getTime()) return utc;
      cursor += 3_600_000; // 墙钟意义上的「下一个小时」——伪 UTC 上的算术，与真实偏移无关
    }
    throw new AutomationInvariantError(
      `no hourly occurrence found within ${String(MAX_STEPS)} steps for ${this.timezone}`,
    );
  }

  private nextDaily(after: Date): Date {
    const { hour, minute } = this.dailyWallClock();
    return this.nextAtLocalTime(after, hour, minute, () => true);
  }

  private nextWeekly(after: Date): Date {
    const { hour, minute } = this.dailyWallClock();
    const days = new Set(this.config.days ?? []);
    return this.nextAtLocalTime(after, hour, minute, (weekday) => days.has(weekday));
  }

  /**
   * 从 `after` 当天开始，逐**本地日**试 `hour:minute`，第一个严格晚于 `after` 且
   * 满足 `dayMatches` 的即答案。
   *
   * ⚠️ 「逐日推进」是在**伪 UTC 的墙钟坐标**上 `+86400000` 做的，不是在真实时刻上加
   * 24 小时。DST 切换日的真实间隔是 23 或 25 小时；在真实时刻上加 24 小时会让
   * 「每天 08:00」在切换后变成 07:00 或 09:00 —— 这正是 T-AUT-4 要钉死的那个 bug。
   */
  private nextAtLocalTime(
    after: Date,
    hour: number,
    minute: number,
    dayMatches: (weekday: number) => boolean,
  ): Date {
    const parts = this.partsAt(after);
    let cursor = Date.UTC(parts.year, parts.month - 1, parts.day, hour, minute, 0, 0);
    for (let step = 0; step < MAX_STEPS; step += 1) {
      // 星期几取自**墙钟坐标**：`cursor` 是伪 UTC，所以 getUTCDay 读到的就是当地星期几。
      const weekday = fromEpochMs(cursor).getUTCDay();
      if (dayMatches(weekday)) {
        const utc = this.wallClockToUtc(cursor);
        if (utc.getTime() > after.getTime()) return utc;
      }
      cursor += 86_400_000;
    }
    throw new AutomationInvariantError(
      `no occurrence found within ${String(MAX_STEPS)} days for ${this.timezone}`,
    );
  }

  private dailyWallClock(): { hour: number; minute: number } {
    const raw = this.config.time;
    if (raw === undefined) {
      // hourly：小时不受约束，取当天第一个小时（见 `nextDailyOccurrence` 的注释）。
      return { hour: 0, minute: this.config.minute ?? 0 };
    }
    const m = HHMM_RE.exec(raw);
    if (!m) throw new AutomationInvariantError(`schedule time '${raw}' must be HH:mm`);
    return { hour: Number(m[1]), minute: Number(m[2]) };
  }

  /**
   * 墙钟坐标（伪 UTC 毫秒）→ 真实 UTC 时刻。
   *
   * 两趟「猜—校正」：`offsetAt(t)` 给的是 `t` 这个**瞬间**该时区的偏移，而我们要的是
   * 「哪个瞬间的当地墙钟等于给定墙钟」。第一趟用「墙钟当瞬间」估的偏移必然接近真值
   * （最多差一次 DST 跳变），第二趟用修正后的瞬间再问一次即收敛。
   *
   * ⚠️ **DST 空洞**（春季跳表，当地 02:30 不存在）：两趟会稳定落到跳变后的等价时刻，
   * 不会抛错、不会漏掉一天。**DST 重叠**（秋季回拨，当地 01:30 出现两次）：取先出现
   * 的那一次。两者都是「不补跑、不重复触发」这条更高纪律下的合理取舍。
   */
  private wallClockToUtc(wallClockMs: number): Date {
    let instant = wallClockMs - this.offsetAt(wallClockMs);
    instant = wallClockMs - this.offsetAt(instant);
    return fromEpochMs(instant);
  }

  /** 该时区在 `instant` 这一瞬间相对 UTC 的偏移（毫秒，东为正）。 */
  private offsetAt(instant: number): number {
    const p = partsIn(this.timezone, fromEpochMs(instant));
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second, 0);
    return asUtc - instant;
  }

  private partsAt(d: Date): DateParts {
    return partsIn(this.timezone, d);
  }
}

interface DateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/**
 * `Intl.DateTimeFormat` 是 Node 里**唯一**不引第三方库就能拿到「某瞬间在某 IANA 时区
 * 的墙钟」的东西。`hour12: false` + `hourCycle: 'h23'` 两个都给：单给 `hour12:false`
 * 在部分 ICU 版本上会把午夜格式化成 `24`。
 */
function partsIn(timeZone: string, d: Date): DateParts {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const out: Record<string, number> = {};
  for (const part of fmt.formatToParts(d)) {
    if (part.type !== 'literal') out[part.type] = Number(part.value);
  }
  return {
    year: out.year,
    month: out.month,
    day: out.day,
    hour: out.hour === 24 ? 0 : out.hour,
    minute: out.minute,
    second: out.second,
  };
}

/**
 * ⚠️ **必须真去解一次，不能用正则看「像不像 `Area/City`」**。`Asia/NotACity` 长得
 * 完全合格却不存在（T-AUT-8 点名了它），而 `UTC+8` 会被某些正则放行。`Intl` 对未知
 * 时区抛 `RangeError` —— 那是 Node 里权威的那一票。
 */
function isIanaTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    return false;
  }
  // `Intl` 也接受 'UTC' / 'utc' 这种非 Area/City 拼法。`UTC` 本身是合法 IANA 名，放行；
  // 'UTC+8' / 'GMT+8' 这类偏移拼法会被上面的构造直接抛掉。
  return true;
}

/** 按 `kind` 校验并裁掉不属于这一档的字段（存进库的 config 不带噪声）。 */
function normalizeConfig(kind: ScheduleKind, config: ScheduleConfig): ScheduleConfig {
  switch (kind) {
    case 'hourly': {
      const minute = config.minute ?? 0;
      if (!Number.isInteger(minute) || minute < 0 || minute > 59) {
        throw new AutomationInvariantError(
          `hourly schedule needs minute ∈ [0,59], got ${String(config.minute)}`,
        );
      }
      return { minute };
    }
    case 'daily': {
      const time = requireTime(config.time, 'daily');
      return { time };
    }
    case 'weekly': {
      const time = requireTime(config.time, 'weekly');
      const days = config.days ?? [];
      if (days.length === 0) {
        throw new AutomationInvariantError(
          'weekly schedule needs at least one weekday (0=Sun..6=Sat)',
        );
      }
      if (days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
        throw new AutomationInvariantError(
          `weekly schedule weekdays must be 0..6, got [${days.join(',')}]`,
        );
      }
      return { time, days: [...new Set(days)].sort((a, b) => a - b) };
    }
  }
}

function requireTime(time: string | undefined, kind: string): string {
  if (time === undefined || !HHMM_RE.test(time)) {
    throw new AutomationInvariantError(`${kind} schedule needs time in HH:mm, got ${String(time)}`);
  }
  return time;
}
