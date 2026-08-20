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

@Injectable()
export class AuthSessionStore {
  private readonly sessions = new Map<string, AuthSessionEntry>();

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
}
