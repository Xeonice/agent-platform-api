import { Injectable } from '@nestjs/common';
import type { AuthHelperSession } from '../domain/ports/auth-helper.port';
import type { AuthChallenge } from '../domain/value-objects/auth-challenge.vo';

/**
 * In-memory AuthSession store (docs/backend/23 §7.3 / D-6). `challengeRef → { helper
 * session pty, isolated homeDir, challenge }`. NOT persisted — lifetime ≤15min; a
 * process restart drops it and the frontend re-runs `begin` (matches the device-code
 * 15-min expiry fallback). Entries are evicted on complete / cancel / expiry.
 */
export interface AuthSessionEntry {
  challengeRef: string;
  runtimeId: string;
  session: AuthHelperSession;
  challenge: AuthChallenge;
  expiresAt: Date;
  status: 'pending' | 'success' | 'error';
  maskedIdentifier?: string;
}

/** Terminal outcome (device-code) — the FINAL status queryable after the live entry is dropped. */
export type AuthOutcomeStatus = 'success' | 'error' | 'expired';
export interface AuthOutcome {
  runtimeId: string;
  status: AuthOutcomeStatus;
  maskedIdentifier?: string;
  /** Tombstone eviction instant — bounds `outcomes` growth (challenge TTL). */
  evictAt: Date;
}

@Injectable()
export class AuthSessionStore {
  private readonly sessions = new Map<string, AuthSessionEntry>();
  /**
   * Terminal-status tombstones. When a device-code login finishes, the HEAVY live
   * entry (its pty session) is dropped, but the frontend still polls for the terminal
   * status (success/error/expired) — so we retain a tiny outcome record instead of
   * leaking the whole session entry forever (P2 memory leak). Bounded by `evictAt`.
   */
  private readonly outcomes = new Map<string, AuthOutcome>();

  put(entry: AuthSessionEntry): void {
    this.sessions.set(entry.challengeRef, entry);
  }

  get(challengeRef: string): AuthSessionEntry | undefined {
    return this.sessions.get(challengeRef);
  }

  /** Returns the entry only if it exists AND has not passed `expiresAt` (per `now`). */
  getLive(challengeRef: string, now: Date): AuthSessionEntry | undefined {
    const e = this.sessions.get(challengeRef);
    if (!e) return undefined;
    if (e.expiresAt.getTime() <= now.getTime()) return undefined;
    return e;
  }

  delete(challengeRef: string): void {
    this.sessions.delete(challengeRef);
  }

  /**
   * Record the terminal outcome AND drop the live session entry (releasing its pty
   * session reference). Called from the device-code completion `finally` so the map
   * never accumulates disposed sessions (P2). The tombstone is readable via `outcome`
   * until `evictAt`, so the frontend's next poll still sees the real terminal status.
   */
  settle(challengeRef: string, outcome: AuthOutcome): void {
    this.sessions.delete(challengeRef);
    this.outcomes.set(challengeRef, outcome);
  }

  /**
   * The terminal outcome for a settled challenge, or undefined once evicted / never
   * set. Eviction is lazy (on read) — `evictAt` bounds each tombstone's lifetime; the
   * store holds no clock so it cannot sweep on a timer. `sweepOutcomes(now)` can be
   * called by a caller that DOES have a clock to bound never-polled tombstones.
   */
  outcome(challengeRef: string, now: Date): AuthOutcome | undefined {
    const o = this.outcomes.get(challengeRef);
    if (!o) return undefined;
    if (o.evictAt.getTime() <= now.getTime()) {
      this.outcomes.delete(challengeRef);
      return undefined;
    }
    return o;
  }

  /** Sweep expired tombstones relative to `now` (bounds growth from never-polled refs). */
  sweepOutcomes(now: Date): void {
    for (const [ref, o] of this.outcomes) {
      if (o.evictAt.getTime() <= now.getTime()) this.outcomes.delete(ref);
    }
  }
}
