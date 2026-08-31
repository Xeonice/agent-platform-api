import { fromEpochMs, shiftMs } from '@platform/shared-kernel';
import { AutomationInvariantError } from '../errors/automation-errors';

/**
 * 23 §11.3 最后一行：**阈值集中在这三个值对象里，不散落在调度器代码中**。
 *
 * 这不是洁癖。03 §8 的阈值一共五个（超时四档、重试 24min×5、降频 3、禁用 10、
 * missed 5min），它们分别出现在决策服务、调度循环、聚合的三处；散着写的必然结局是
 * 「改了一处、另两处照旧」，而那种漂移在测试里表现为「某一条断言仍然绿」。
 */

/** I-AUT-5：只有四档，别的分钟数是调用方算错了。 */
export const ALLOWED_TIMEOUT_MINUTES = [30, 60, 120, 240] as const;
export type TimeoutMinutes = (typeof ALLOWED_TIMEOUT_MINUTES)[number];

export class TimeoutPolicy {
  private constructor(readonly minutes: TimeoutMinutes) {}

  /** 默认 2h（03 §8.3 / P20 §0 决策 5）。 */
  static default(): TimeoutPolicy {
    return new TimeoutPolicy(120);
  }

  static of(minutes: number): TimeoutPolicy {
    if (!(ALLOWED_TIMEOUT_MINUTES as readonly number[]).includes(minutes)) {
      throw new AutomationInvariantError(
        `timeout must be one of ${ALLOWED_TIMEOUT_MINUTES.join('/')} minutes (I-AUT-5), got ${String(minutes)}`,
      );
    }
    return new TimeoutPolicy(minutes as TimeoutMinutes);
  }
}

/** I-AUR-2 / 03 §8.2 行 3：24min 间隔 × 最多 5 次（≈2h 窗口）。 */
export class RetryPolicy {
  static readonly INTERVAL_MS = 24 * 60_000;
  static readonly MAX_ATTEMPTS = 5;

  /** 还能不能再排一次。`retryCount` 是**已经排过**的次数。 */
  static canRetry(retryCount: number): boolean {
    return retryCount < RetryPolicy.MAX_ATTEMPTS;
  }

  static nextAttemptAt(now: Date): Date {
    return shift(now, RetryPolicy.INTERVAL_MS);
  }
}

/** 03 §8.4 / I-AUT-2：≥3 降频，≥10 禁用。 */
export class FailurePolicy {
  static readonly DEGRADE_AT = 3;
  static readonly DISABLE_AT = 10;

  static shouldDegrade(failureCount: number): boolean {
    return failureCount >= FailurePolicy.DEGRADE_AT;
  }

  static shouldDisable(failureCount: number): boolean {
    return failureCount >= FailurePolicy.DISABLE_AT;
  }
}

/** 03 §8.2「宕机 missed」的默认阈值（分钟）。 */
export const DEFAULT_MISSED_THRESHOLD_MIN = 5;

/** 保留期（I-RV-1 的三个取值；自动化产物喂 `retained_volumes.retain_until`）。 */
export const ALLOWED_RETENTION_DAYS = [3, 7, 30] as const;
export type RetentionDays = (typeof ALLOWED_RETENTION_DAYS)[number];

export function assertRetentionDays(days: number): RetentionDays {
  if (!(ALLOWED_RETENTION_DAYS as readonly number[]).includes(days)) {
    throw new AutomationInvariantError(
      `artifactRetentionDays must be one of ${ALLOWED_RETENTION_DAYS.join('/')}, got ${String(days)}`,
    );
  }
  return days as RetentionDays;
}

/**
 * 位移一个**拷贝**。`shiftMs` 是**原地改**的，直接把调用方的 `now` 传进去会把它一起
 * 挪走（`retained-volume.entity.ts` 同一处踩过），所以先 `fromEpochMs` 复制一份。
 */
function shift(base: Date, ms: number): Date {
  return shiftMs(fromEpochMs(base.getTime()), ms);
}
