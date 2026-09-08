import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { runHalfStub } from '../_run-half';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it, expect } from 'vitest';
import type { Clock } from '@platform/shared-kernel';
import type {
  RuntimeAdapter,
  RuntimeAdapterRegistry,
  RuntimeAuthMethod,
} from '@platform/contracts';
import { CredentialRefreshScanner } from '../../src/infrastructure/refresh/credential-refresh.scanner';
import { CodexAdapter } from '../../src/infrastructure/adapters/codex/codex.adapter';
import { ClaudeCodeAdapter } from '../../src/infrastructure/adapters/claude-code/claude-code.adapter';
import type { AuthHelper, AuthHelperSession } from '../../src/domain/ports/auth-helper.port';

const clock: Clock = { now: () => new Date(1_000_000) };

/** Six hours — deliberately NOT the platform's Codex-shaped hourly default. */
const ACME_TTL_MS = 6 * 60 * 60_000;

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
          // ⚠️ 契约必需，此前这个替身缺着（2026-09-05 补）。
          detach: () => undefined,
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
  listRefreshDue: (
    leadMs: number,
  ) => Promise<Array<{ credentialId: string; runtimeId: string; obtainedVia: RuntimeAuthMethod }>>;
  // the refresh out-口 (05 §4.3) — `authFile` is REQUIRED here, unlike the injection
  // out-口, which has no such field at all
  prepareForRefresh: (id: string) => Promise<{ authFile: string; zeroize(): void }>;
  applyRefresh: (id: string, payload: unknown, exp: Date) => Promise<void>;
  recordRefreshFailure: (id: string) => Promise<void>;
}

describe('CredentialRefreshScanner (05 §5.1)', () => {
  it('refreshes a due credential and writes back the new token', async () => {
    const applied: Array<{ id: string; payload: { accessToken?: string } }> = [];
    const cred: FakeCred = {
      listRefreshDue: async () => [
        { credentialId: 'c1', runtimeId: 'codex', obtainedVia: 'oauth-device' },
      ],
      prepareForRefresh: async () => ({
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
      listRefreshDue: async () => [
        { credentialId: 'bad', runtimeId: 'codex', obtainedVia: 'oauth-device' },
      ],
      prepareForRefresh: async () => {
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
      prepareForRefresh: async () => ({ authFile: '{}', zeroize() {} }),
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
      listRefreshDue: async () => [
        { credentialId: 'cc1', runtimeId: 'claude-code', obtainedVia: 'setup-token' },
      ],
      prepareForRefresh: async () => {
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
      // ⛔ 运行半边本测试不涉及，但**契约要求它在** —— 见 `_run-half.ts`。
      ...runHalfStub,
      id: 'acme',
      displayName: 'Acme',
      vendor: 'Acme Inc',
      // ⚠️ 三样都**故意与 codex 不同**：文件名不是 `auth.json`、TTL 不是一小时、
      //    方法集由自己声明。这三条正是 05 §5.1 ★5.1a 里被下推到平台代码的那三个常量；
      //    只要它们中任何一个又被写死回去，本用例就红。
      refreshCapability: {
        probeCommand: ['acme', 'refresh'],
        authFileRelPath: '.acme/creds.json',
        eligibleMethods: ['oauth-device'],
        parseRefreshedAuth(raw: string): { accessToken: string } {
          const parsed = JSON.parse(raw) as { acme?: { key?: string } };
          const key = parsed.acme?.key;
          if (!key) throw new Error('acme auth missing key');
          return { accessToken: key };
        },
      },
      credentialTtlMs: { 'oauth-device': ACME_TTL_MS },
      configDirEnvNames: ['ACME_CONFIG_DIR'],
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
        for (const f of seed) {
          await mkdir(dirname(join(homeDir, f.relPath)), { recursive: true });
          await writeFile(join(homeDir, f.relPath), f.content);
        }
        // ⛔ 这个 CLI 只认自己那份文件。平台若还按 `auth.json` 播种/读回，读到的就是
        //    **它自己刚写进去的那份**，`parseRefreshedAuth` 会解析成功并存下同一个过期
        //    token —— 永远刷新成功的那个静默循环（★5.1a ②）。
        await mkdir(join(homeDir, '.acme'), { recursive: true });
        await writeFile(
          join(homeDir, '.acme/creds.json'),
          JSON.stringify({ acme: { key: 'ACME-NEW' } }),
        );
        return {
          homeDir,
          pty: {
            ref: 'x',
            // ⚠️ 契约必需，此前这个替身缺着（2026-09-05 补）。
            detach: () => undefined,
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
    const seededPaths: string[] = [];
    const configDirNames: Array<readonly string[] | undefined> = [];
    const wrapped: AuthHelper = {
      async openSession(cmd, seed, configDirEnvNames) {
        usedCommands.push(cmd);
        for (const f of seed ?? []) seededPaths.push(f.relPath);
        configDirNames.push(configDirEnvNames);
        return acmeHelper.openSession(cmd, seed, configDirEnvNames);
      },
    };
    const applied: Array<{
      id: string;
      payload: { accessToken?: string };
      expiresAt: Date;
    }> = [];
    const cred: FakeCred = {
      listRefreshDue: async () => [
        { credentialId: 'a1', runtimeId: 'acme', obtainedVia: 'oauth-device' },
      ],
      prepareForRefresh: async () => ({ authFile: '{"acme":{"key":"OLD"}}', zeroize() {} }),
      applyRefresh: async (id, payload, expiresAt) => {
        applied.push({ id, payload: payload as { accessToken?: string }, expiresAt });
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
    // the adapter's OWN auth-file path, not the hard-coded `auth.json` (★5.1a ②)
    expect(seededPaths).toEqual(['.acme/creds.json']);
    // the adapter's OWN config-dir variable reaches the helper (04 §3 ★3z)
    expect(configDirNames).toEqual([['ACME_CONFIG_DIR']]);
    expect(applied).toHaveLength(1);
    expect(applied[0].payload.accessToken).toBe('ACME-NEW');
    // ⛔ AND ITS OWN LIFETIME, not the built-in hourly default (★5.1a ③). Codex's hour
    //    would land at now+1h; acme said six.
    expect(applied[0].expiresAt.getTime()).toBe(clock.now().getTime() + ACME_TTL_MS);
  });

  it('skips a due credential whose METHOD the adapter never declared refreshable (★5.1a ①)', async () => {
    // codex DOES declare a refreshCapability, but only for `oauth-device`. A credential
    // obtained some other way must be skipped — silently, and WITHOUT burning a retry:
    // this used to be decided by `obtainedVia === 'oauth-device'` inside the credential
    // repository, where no adapter could see it, let alone override it.
    let materialized = false;
    const failures: string[] = [];
    const cred: FakeCred = {
      listRefreshDue: async () => [
        { credentialId: 'k1', runtimeId: 'codex', obtainedVia: 'api-key' },
      ],
      prepareForRefresh: async () => {
        materialized = true;
        return { authFile: '{}', zeroize() {} };
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
    expect(materialized).toBe(false);
    expect(failures).toEqual([]);
  });
});
