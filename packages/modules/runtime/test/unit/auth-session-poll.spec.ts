import { describe, it, expect } from 'vitest';
import type { Clock } from '@platform/shared-kernel';
import { AuthSessionStore } from '../../src/application/auth-session.store';
import type { AuthSessionEntry } from '../../src/application/auth-session.store';
import { RuntimeApplicationService } from '../../src/application/runtime-application.service';

/**
 * P2: the AuthSessionStore must not leak disposed device-code sessions, and
 * `pollAuthStatus` must return TRUE terminal states (success/error/expired) after the
 * live session is dropped — the frontend's assumed-dead fix depends on this.
 */
const T0 = new Date('2026-08-21T00:00:00.000Z');
const clockAt = (d: Date): Clock => ({ now: () => d });

function liveEntry(ref: string, expiresAt: Date): AuthSessionEntry {
  return {
    challengeRef: ref,
    runtimeId: 'codex',
    session: {} as never,
    challenge: {} as never,
    expiresAt,
    status: 'pending',
  };
}

function service(store: AuthSessionStore, clock: Clock): RuntimeApplicationService {
  return new RuntimeApplicationService(
    {} as never,
    {} as never,
    {} as never,
    store,
    {} as never,
    {} as never,
    clock,
    {} as never,
  );
}

describe('AuthSessionStore settle/outcome (P2 leak fix)', () => {
  it('settle drops the live entry and retains only a terminal tombstone', () => {
    const store = new AuthSessionStore();
    const evictAt = new Date(T0.getTime() + 15 * 60_000);
    store.put(liveEntry('c1', evictAt));
    store.settle('c1', { runtimeId: 'codex', status: 'success', maskedIdentifier: 'm', evictAt });

    expect(store.get('c1')).toBeUndefined(); // heavy entry released
    expect(store.outcome('c1', T0)).toMatchObject({ status: 'success', maskedIdentifier: 'm' });
  });

  it('a tombstone is evicted once past evictAt (bounded growth)', () => {
    const store = new AuthSessionStore();
    const evictAt = new Date(T0.getTime() + 1000);
    store.settle('c1', { runtimeId: 'codex', status: 'error', evictAt });
    expect(store.outcome('c1', new Date(evictAt.getTime() + 1))).toBeUndefined();
  });
});

describe('RuntimeApplicationService.pollAuthStatus (P2 terminal states)', () => {
  it('returns pending while live and unexpired', async () => {
    const store = new AuthSessionStore();
    store.put(liveEntry('c1', new Date(T0.getTime() + 60_000)));
    const r = await service(store, clockAt(T0)).pollAuthStatus('codex', 'c1');
    expect(r.status).toBe('pending');
  });

  it('returns expired for a live-but-past-TTL pending challenge', async () => {
    const store = new AuthSessionStore();
    store.put(liveEntry('c1', new Date(T0.getTime() - 1)));
    const r = await service(store, clockAt(T0)).pollAuthStatus('codex', 'c1');
    expect(r.status).toBe('expired');
  });

  it('returns the terminal outcome after the session is settled (success/error/expired)', async () => {
    const evictAt = new Date(T0.getTime() + 60_000);
    for (const status of ['success', 'error', 'expired'] as const) {
      const store = new AuthSessionStore();
      store.settle('c1', { runtimeId: 'codex', status, maskedIdentifier: 'm', evictAt });
      const r = await service(store, clockAt(T0)).pollAuthStatus('codex', 'c1');
      expect(r.status).toBe(status);
    }
  });

  it('throws NotFound for a truly unknown challengeRef', async () => {
    const store = new AuthSessionStore();
    await expect(service(store, clockAt(T0)).pollAuthStatus('codex', 'nope')).rejects.toThrow(
      /unknown challengeRef/,
    );
  });
});
