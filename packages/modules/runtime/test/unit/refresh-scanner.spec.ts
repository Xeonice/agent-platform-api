import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import type { Clock } from '@platform/shared-kernel';
import { CredentialRefreshScanner } from '../../src/infrastructure/refresh/credential-refresh.scanner';
import type { AuthHelper, AuthHelperSession } from '../../src/domain/ports/auth-helper.port';

const clock: Clock = { now: () => new Date(1_000_000) };

/** A helper whose session seeds/returns a real temp HOME and exits immediately. */
function fakeHelper(refreshedAccess: string): AuthHelper {
  return {
    async openSession(_cmd, seed = []): Promise<AuthHelperSession> {
      const homeDir = await mkdtemp(join(tmpdir(), 'scan-'));
      for (const f of seed) await writeFile(join(homeDir, f.relPath), f.content);
      // simulate the CLI rewriting auth.json with a fresh access token
      await writeFile(
        join(homeDir, 'auth.json'),
        JSON.stringify({ tokens: { access_token: refreshedAccess, refresh_token: 'r2' } }),
      );
      return {
        homeDir,
        pty: {
          ref: 'x',
          onData() {},
          write() {},
          resize() {},
          onExit(cb) {
            cb(0);
          },
          async kill() {},
        },
        dispose: async () => {
          await rm(homeDir, { recursive: true, force: true });
        },
      };
    },
  };
}

interface FakeCred {
  listRefreshDue: (leadMs: number) => Promise<Array<{ credentialId: string; runtimeId: string }>>;
  materializeById: (id: string) => Promise<{ authFile?: string; zeroize(): void }>;
  applyRefresh: (id: string, payload: unknown, exp: Date) => Promise<void>;
  recordRefreshFailure: (id: string) => Promise<void>;
}

describe('CredentialRefreshScanner (05 §5.1)', () => {
  it('refreshes a due credential and writes back the new token', async () => {
    const applied: Array<{ id: string; payload: { accessToken?: string } }> = [];
    const cred: FakeCred = {
      listRefreshDue: async () => [{ credentialId: 'c1', runtimeId: 'codex' }],
      materializeById: async () => ({
        authFile: '{"tokens":{"access_token":"old"}}',
        zeroize() {},
      }),
      applyRefresh: async (id, payload) => {
        applied.push({ id, payload: payload as { accessToken?: string } });
      },
      recordRefreshFailure: async () => {},
    };
    const scanner = new CredentialRefreshScanner(fakeHelper('NEW-ACCESS'), cred as never, clock);
    await scanner.runOnce();
    expect(applied).toHaveLength(1);
    expect(applied[0].id).toBe('c1');
    expect(applied[0].payload.accessToken).toBe('NEW-ACCESS');
  });

  it('records a failure when materialize throws (feeds ≥3 stop-hand)', async () => {
    const failures: string[] = [];
    const cred: FakeCred = {
      listRefreshDue: async () => [{ credentialId: 'bad', runtimeId: 'codex' }],
      materializeById: async () => {
        throw new Error('decrypt failed');
      },
      applyRefresh: async () => {},
      recordRefreshFailure: async (id) => {
        failures.push(id);
      },
    };
    const scanner = new CredentialRefreshScanner(fakeHelper('x'), cred as never, clock);
    await scanner.runOnce();
    expect(failures).toEqual(['bad']);
  });

  it('single-instance lock: a concurrent runOnce is a no-op while one is in flight', async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const cred: FakeCred = {
      listRefreshDue: async () => {
        calls += 1;
        await gate; // hold the first pass open
        return [];
      },
      materializeById: async () => ({ zeroize() {} }),
      applyRefresh: async () => {},
      recordRefreshFailure: async () => {},
    };
    const scanner = new CredentialRefreshScanner(fakeHelper('x'), cred as never, clock);
    const first = scanner.runOnce();
    const second = scanner.runOnce(); // should return immediately (locked)
    await second;
    expect(calls).toBe(1); // the second pass never entered the body
    release();
    await first;
    expect(calls).toBe(1);
  });
});
