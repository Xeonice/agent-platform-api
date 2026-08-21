import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import type { Clock } from '@platform/shared-kernel';
import type { RuntimeAdapter, RuntimeAdapterRegistry } from '@platform/contracts';
import { CredentialRefreshScanner } from '../../src/infrastructure/refresh/credential-refresh.scanner';
import { CodexAdapter } from '../../src/infrastructure/adapters/codex/codex.adapter';
import { ClaudeCodeAdapter } from '../../src/infrastructure/adapters/claude-code/claude-code.adapter';
import type { AuthHelper, AuthHelperSession } from '../../src/domain/ports/auth-helper.port';

const clock: Clock = { now: () => new Date(1_000_000) };

/** Minimal open registry — application code depends on this, never a concrete adapter. */
function registryWith(adapters: RuntimeAdapter[]): RuntimeAdapterRegistry {
  const map = new Map(adapters.map((a) => [a.id, a]));
  return {
    register(a) {
      if (map.has(a.id)) throw new Error(`duplicate runtime adapter id '${a.id}'`);
      map.set(a.id, a);
    },
    get(id) {
      const a = map.get(id);
      if (!a) throw new Error(`unknown runtime '${id}'`);
      return a;
    },
    has: (id) => map.has(id),
    list: () => [...map.values()],
  };
}

/** The two built-ins wired the way the composition root wires them. */
const builtinRegistry = registryWith([new CodexAdapter(), new ClaudeCodeAdapter()]);

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
    const scanner = new CredentialRefreshScanner(
      fakeHelper('NEW-ACCESS'),
      cred as never,
      builtinRegistry,
      clock,
    );
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
    const scanner = new CredentialRefreshScanner(
      fakeHelper('x'),
      cred as never,
      builtinRegistry,
      clock,
    );
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
    const scanner = new CredentialRefreshScanner(
      fakeHelper('x'),
      cred as never,
      builtinRegistry,
      clock,
    );
    const first = scanner.runOnce();
    const second = scanner.runOnce(); // should return immediately (locked)
    await second;
    expect(calls).toBe(1); // the second pass never entered the body
    release();
    await first;
    expect(calls).toBe(1);
  });

  it('skips a runtime whose adapter declares NO refreshCapability (claude), no failure', async () => {
    let materialized = false;
    const applied: string[] = [];
    const failures: string[] = [];
    const cred: FakeCred = {
      // a due claude-code credential surfaces (e.g. its ~1yr token nears expiry)
      listRefreshDue: async () => [{ credentialId: 'cc1', runtimeId: 'claude-code' }],
      materializeById: async () => {
        materialized = true;
        return { authFile: '{}', zeroize() {} };
      },
      applyRefresh: async (id) => {
        applied.push(id);
      },
      recordRefreshFailure: async (id) => {
        failures.push(id);
      },
    };
    const scanner = new CredentialRefreshScanner(
      fakeHelper('x'),
      cred as never,
      builtinRegistry,
      clock,
    );
    await scanner.runOnce();
    // claude has no refreshCapability → skipped BEFORE materialize; nothing refreshed,
    // and — crucially — no failure recorded (a skip is not an error).
    expect(materialized).toBe(false);
    expect(applied).toEqual([]);
    expect(failures).toEqual([]);
  });

  it('refreshes an IMAGINARY third-party runtime via ITS adapter refreshCapability — scanner unchanged', async () => {
    // A brand-new runtime added by writing ONLY an adapter + registering it: it declares
    // a refreshCapability with its OWN probe command + auth-file format. The scanner
    // discovers both through the registry — proving the extension point is closed.
    const acme: RuntimeAdapter = {
      id: 'acme',
      displayName: 'Acme',
      vendor: 'Acme Inc',
      refreshCapability: {
        probeCommand: ['acme', 'refresh'],
        parseRefreshedAuth(raw: string): { accessToken: string } {
          const parsed = JSON.parse(raw) as { acme?: { key?: string } };
          const key = parsed.acme?.key;
          if (!key) throw new Error('acme auth missing key');
          return { accessToken: key };
        },
      },
      loginCommand: () => ['acme', 'login'],
      getAuthMethods: () => ['oauth-device'],
      beginAuth: async () => {
        throw new Error('unused');
      },
      completeAuth: async () => {
        throw new Error('unused');
      },
      injectCredential: async () => {},
    };
    // helper that rewrites the seeded auth.json into ACME's own on-disk format
    const acmeHelper: AuthHelper = {
      async openSession(_cmd, seed = []): Promise<AuthHelperSession> {
        const homeDir = await mkdtemp(join(tmpdir(), 'scan-acme-'));
        for (const f of seed) await writeFile(join(homeDir, f.relPath), f.content);
        await writeFile(join(homeDir, 'auth.json'), JSON.stringify({ acme: { key: 'ACME-NEW' } }));
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
    const usedCommands: string[][] = [];
    const wrapped: AuthHelper = {
      async openSession(cmd, seed) {
        usedCommands.push(cmd);
        return acmeHelper.openSession(cmd, seed);
      },
    };
    const applied: Array<{ id: string; payload: { accessToken?: string } }> = [];
    const cred: FakeCred = {
      listRefreshDue: async () => [{ credentialId: 'a1', runtimeId: 'acme' }],
      materializeById: async () => ({ authFile: '{"acme":{"key":"OLD"}}', zeroize() {} }),
      applyRefresh: async (id, payload) => {
        applied.push({ id, payload: payload as { accessToken?: string } });
      },
      recordRefreshFailure: async () => {},
    };
    // register the third-party adapter alongside the built-ins — the ONLY wiring change
    const scanner = new CredentialRefreshScanner(
      wrapped,
      cred as never,
      registryWith([new CodexAdapter(), new ClaudeCodeAdapter(), acme]),
      clock,
    );
    await scanner.runOnce();
    expect(usedCommands).toEqual([['acme', 'refresh']]); // the adapter's probe, not codex's
    expect(applied).toHaveLength(1);
    expect(applied[0].payload.accessToken).toBe('ACME-NEW');
  });
});
