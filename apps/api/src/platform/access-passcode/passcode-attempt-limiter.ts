import { Injectable } from '@nestjs/common';

const MAX_FAILURES = 5;
const LOCK_MS = 5 * 60 * 1000; // 5 minutes (docs/shared/11 §3.1)

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

  recordFailure(ip: string, now: number): void {
    const count = (this.failures.get(ip)?.count ?? 0) + 1;
    this.failures.set(ip, { count, lockedUntil: count >= MAX_FAILURES ? now + LOCK_MS : 0 });
  }

  reset(ip: string): void {
    this.failures.delete(ip);
  }
}
