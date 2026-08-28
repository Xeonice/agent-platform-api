import { Injectable } from '@nestjs/common';

const MAX_FAILURES = 5;
const LOCK_MS = 5 * 60 * 1000; // 5 minutes (docs/shared/11 §3.1)

/**
 * 一次失败之后的锁定视图。
 *
 * ⚠️ **计数由 limiter 交出来，调用方不许自己再数一遍。** 「连续第几次」是审计里唯一
 * 真正回答得了「试了多少次」的那个数（13 §2.8.2 的 `system` 档，单机私有化部署没有
 * 用户身份可记）。调用方另起一个计数器，迟早与这里的 `failures` 漂移——而漂移之后
 * 审计写的是一个**看着像真的、其实没人维护**的数字。
 */
export interface PasscodeFailureOutcome {
  /** 连续失败次数，**含这一次**。 */
  consecutiveFailures: number;
  /** 触发上限所需的次数（`MAX_FAILURES`），供审计写出「5 次中的第 3 次」。 */
  maxFailures: number;
  /** 这一次失败之后的锁定剩余秒数；`0` = 还没锁。 */
  lockedForSec: number;
}

/**
 * Per-client-IP passcode attempt limiter (docs/shared/11 §3.1). Shared by the
 * `PasscodeGuard` and the `POST /api/access/unlock` endpoint so BOTH entry points
 * feed ONE lockout state: 5 consecutive failures → locked 5 minutes (HTTP 429).
 * In-memory (single-process MVP). Lives in the access-passcode folder (eslint
 * time/random port-impl exemption).
 */
@Injectable()
export class PasscodeAttemptLimiter {
  private readonly failures = new Map<string, { count: number; lockedUntil: number }>();

  /** Seconds remaining on a lock, or 0 when not locked. */
  lockedForSec(ip: string, now: number): number {
    const state = this.failures.get(ip);
    return state && state.lockedUntil > now ? Math.ceil((state.lockedUntil - now) / 1000) : 0;
  }

  recordFailure(ip: string, now: number): PasscodeFailureOutcome {
    const count = (this.failures.get(ip)?.count ?? 0) + 1;
    const lockedUntil = count >= MAX_FAILURES ? now + LOCK_MS : 0;
    this.failures.set(ip, { count, lockedUntil });
    return {
      consecutiveFailures: count,
      maxFailures: MAX_FAILURES,
      lockedForSec: lockedUntil > now ? Math.ceil((lockedUntil - now) / 1000) : 0,
    };
  }

  reset(ip: string): void {
    this.failures.delete(ip);
  }
}
