import { describe, it, expect } from 'vitest';
import type { Clock } from '@platform/shared-kernel';
import type { RuntimeAdapter, RuntimeAdapterRegistry } from '@platform/contracts';
import type { AuthHelper, AuthHelperSession } from '../../src/domain/ports/auth-helper.port';
import { AuthSessionStore } from '../../src/application/auth-session.store';
import { RuntimeApplicationService } from '../../src/application/runtime-application.service';
import { ClaudeCodeAdapter } from '../../src/infrastructure/adapters/claude-code/claude-code.adapter';

/**
 * ── CLI 自己完成的那条路（2026-09-07 真机补）─────────────────────────────────
 *
 * `claude setup-token` 会**起一个本地监听**（实测 `127.0.0.1:51321`）。浏览器授权后，
 * `platform.claude.com` 的回调页把授权码**直接送进那个端口**，页面只显示
 * 「成功，可以关闭此窗口」—— **同机流程下根本不显示码**。
 *
 * ⛔ 而平台此前只等 `completeAuth(pastedText)`：码送到了、CLI 把 token 打在 PTY 上了，
 * 平台却在等一个**永远不会有的粘贴**。用户看到浏览器说成功、这边一直转圈到 120 秒超时。
 * 两边各自「没错」，合起来是死等 —— 而且**这条主路一条测试都没有**。
 */
const clock: Clock = { now: () => new Date(1_700_000_000_000) };
const TOKEN = `sk-ant-oat01-${'a'.repeat(80)}`;
/** claude 把链接打成 OSC-8 超链接（解析器认的就是它）。 */
const URL_LINE = '\x1b]8;;https://claude.com/cai/oauth/authorize?x=1\x07link\x1b]8;;\x07';

function registryWith(adapters: RuntimeAdapter[]): RuntimeAdapterRegistry {
  const map = new Map(adapters.map((a) => [a.id, a]));
  return {
    register: (a) => void map.set(a.id, a),
    get: (id) => {
      const a = map.get(id);
      if (!a) throw new Error(`unknown runtime '${id}'`);
      return a;
    },
    has: (id) => map.has(id),
    list: () => [...map.values()],
  };
}

/**
 * 一个可编排的 helper：先吐授权链接，之后由测试决定 token 什么时候出现
 * —— 这正是「浏览器把码送进本地监听」在 PTY 上的观感。
 */
function scriptedHelper(): { helper: AuthHelper; deliver: () => void; written: string[] } {
  const listeners: Array<(c: Buffer) => void> = [];
  const written: string[] = [];
  const helper: AuthHelper = {
    openSession: async (): Promise<AuthHelperSession> =>
      await Promise.resolve({
        homeDir: '/tmp/none',
        pty: {
          ref: 'x',
          detach: () => undefined,
          onData(cb: (c: Buffer) => void) {
            listeners.push(cb);
            setTimeout(() => {
              cb(Buffer.from(URL_LINE, 'utf8'));
            }, 0);
          },
          write(d: string | Buffer) {
            written.push(String(d));
          },
          resize() {},
          onExit() {},
          kill: async () => undefined,
        },
        dispose: async () => undefined,
      }),
  };
  return {
    helper,
    written,
    deliver: () => {
      for (const cb of listeners) cb(Buffer.from(`\n${TOKEN}\n`, 'utf8'));
    },
  };
}

function makeService(
  helper: AuthHelper,
  sessions: AuthSessionStore,
  stored: string[],
): RuntimeApplicationService {
  let n = 0;
  return new RuntimeApplicationService(
    registryWith([new ClaudeCodeAdapter()]),
    helper,
    undefined as never,
    sessions,
    {
      storeRuntimeCredential: async (input: { maskedIdentifier: string }) =>
        await Promise.resolve({
          maskedIdentifier: (stored.push(input.maskedIdentifier), input.maskedIdentifier),
        }),
    } as never,
    undefined as never,
    undefined as never,
    clock,
    { next: () => `ref-${String(++n)}` } as never,
  );
}

const tick = async (): Promise<void> => {
  await new Promise((r) => setTimeout(r, 20));
};

describe('setup-token：CLI 自己完成时，平台要接住', () => {
  it('⭐ 没有任何粘贴，token 自己出现 ⇒ 落库 + status 变 success', async () => {
    // MUTATION: 去掉 beginAuth 里的 `awaitSelfCompletion` 那一支 ⇒ 本条红（永远 pending）。
    const { helper, deliver, written } = scriptedHelper();
    const sessions = new AuthSessionStore();
    const stored: string[] = [];
    const svc = makeService(helper, sessions, stored);

    const challenge = await svc.beginAuth('claude-code', 'setup-token');
    expect(challenge.kind).toBe('paste-prompt');

    deliver(); // ← 浏览器把码送进 CLI 的本地监听，CLI 直接打出 token
    await tick();

    expect(stored, '自完成这条路必须落库').toHaveLength(1);
    expect(written, '⛔ 用户什么都没粘,平台不该往 PTY 写任何东西').toHaveLength(0);
    const st = await svc.pollAuthStatus('claude-code', challenge.challengeRef);
    expect(st.status).toBe('success');
  });

  it('⭐ 只落库一次 —— 两条路都在等同一个 PTY 上的 token', async () => {
    // MUTATION: 去掉 finishChallenge 里的 `if (!entry) { zeroize; return null }` ⇒ 本条红。
    const { helper, deliver } = scriptedHelper();
    const sessions = new AuthSessionStore();
    const stored: string[] = [];
    const svc = makeService(helper, sessions, stored);

    const challenge = await svc.beginAuth('claude-code', 'setup-token');
    const paste = svc.completeAuth('claude-code', challenge.challengeRef, 'CODE#STATE');
    deliver();
    await paste;
    await tick();

    expect(stored, '同一个 token 不许存两遍').toHaveLength(1);
  });
});
