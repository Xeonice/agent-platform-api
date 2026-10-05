import { afterEach, describe, expect, it, vi } from 'vitest';
import { RuntimeApplicationService } from '../../../packages/modules/runtime/src/application/runtime-application.service';
import { AuthSessionStore } from '../../../packages/modules/runtime/src/application/auth-session.store';

import type {
  AuthChallenge,
  AuthSessionContext,
  RuntimeAdapterRegistry,
  ProcessStream,
} from '@platform/contracts';
import type { AuthHelperSession } from '../../../packages/modules/runtime/src/domain/ports/auth-helper.port';
import type { RuntimeCredentialService } from '@platform/credential';
import { ClaudeCodeAdapter } from '../../../packages/modules/runtime/src/infrastructure/adapters/claude-code/claude-code.adapter';
import { CodexAdapter } from '../../../packages/modules/runtime/src/infrastructure/adapters/codex/codex.adapter';
import { deferred, unused } from '../../support/strict-ports';

function harness() {
  let now = new Date('2026-10-05T00:00:00Z');
  let id = 0;
  const dispose = vi.fn(async () => undefined);
  const session: AuthHelperSession = {
    pty: unused<ProcessStream>('unused auth PTY'),
    homeDir: '/test',
    readFile: async () => '',
    dispose,
  };
  const helper = { openSession: vi.fn(async () => session) };
  const adapters = [new CodexAdapter(), new ClaudeCodeAdapter()];
  for (const adapter of adapters) {
    adapter.getAuthMethods = () => ['setup-token'];
    adapter.loginCommand = () => ['synthetic-login'];
    adapter.beginAuth = vi.fn(
      async (_method, context: AuthSessionContext): Promise<AuthChallenge> => ({
        challengeRef: context.challengeRef,
        method: 'setup-token',
        kind: 'paste-prompt',
        verificationUrl: 'https://example.test/auth',
        instructions: 'synthetic auth fixture',
      }),
    );
    // This fixture exercises resource lifecycle; external vendor completion stays outside it.
    if ('awaitSelfCompletion' in adapter)
      Object.defineProperty(adapter, 'awaitSelfCompletion', { value: undefined });
  }
  const registry: RuntimeAdapterRegistry = {
    list: () => adapters,
    has: (runtimeId) => adapters.some((adapter) => adapter.id === runtimeId),
    get: (runtimeId) => {
      const adapter = adapters.find((item) => item.id === runtimeId);
      if (!adapter) throw new Error('unknown runtime');
      return adapter;
    },
    register: () => {
      throw new Error('registration outside auth lifecycle');
    },
  };
  const store = new AuthSessionStore();
  const credentialWrites = vi.fn(async () => {
    throw new Error('unexpected credential write');
  });
  const credentials = new Proxy(unused<RuntimeCredentialService>('runtime credentials'), {
    get: (target, key) =>
      key === 'storeRuntimeCredential' ? credentialWrites : Reflect.get(target, key),
  });
  const app = new RuntimeApplicationService(
    registry,
    helper,
    unused('runtime settings'),
    store,
    credentials,
    unused('uow'),
    unused('events'),
    { now: () => new Date(now.getTime()) },
    { next: () => `login-${++id}` },
  );
  return {
    app,
    helper,
    store,
    dispose,
    session,
    adapters,
    credentialWrites,
    setNow: (value: Date) => {
      now = value;
    },
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('AUTH010 登录会话资源生命周期', () => {
  it('连续与并发begin共用同一挑战，不拉起重复进程', async () => {
    const h = harness();
    const first = await h.app.beginAuth('claude-code', 'setup-token');
    for (let n = 0; n < 5; n++)
      expect(await h.app.beginAuth('claude-code', 'setup-token')).toEqual(first);
    const concurrent = await Promise.all(
      Array.from({ length: 5 }, () => h.app.beginAuth('claude-code', 'setup-token')),
    );
    expect(concurrent.every((item) => item.challengeRef === first.challengeRef)).toBe(true);
    expect(h.helper.openSession).toHaveBeenCalledTimes(1);
    expect(h.store.entries()).toHaveLength(1);
  });
  it('在挑战返回前的并发请求也单飞', async () => {
    const h = harness();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => h.app.beginAuth('codex', 'setup-token')),
    );
    expect(new Set(results.map((item) => item.challengeRef)).size).toBe(1);
    expect(h.helper.openSession).toHaveBeenCalledTimes(1);
  });
  it('全机上限拒绝另一Agent，不启动进程', async () => {
    vi.stubEnv('AUTH_SESSION_MAX', '1');
    const h = harness();
    await h.app.beginAuth('codex', 'setup-token');
    await expect(h.app.beginAuth('claude-code', 'setup-token')).rejects.toMatchObject({
      response: { code: 'AUTH_SESSION_CAPACITY', sideEffectFree: true },
    });
    expect(h.helper.openSession).toHaveBeenCalledTimes(1);
  });
  it('取消幂等，删会话并释放进程', async () => {
    const h = harness();
    const first = await h.app.beginAuth('codex', 'setup-token');
    await h.app.cancelAuth('codex', first.challengeRef);
    await h.app.cancelAuth('codex', first.challengeRef);
    expect(h.store.entries()).toHaveLength(0);
    expect(h.dispose).toHaveBeenCalledTimes(1);
  });
  it('无人访问的授权链接在有效期后一个清扫周期内回收', async () => {
    vi.useFakeTimers();
    const h = harness();
    h.app.onModuleInit();
    await h.app.beginAuth('codex', 'setup-token');
    h.setNow(new Date('2026-10-05T00:16:00Z'));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.store.entries()).toHaveLength(0);
    expect(h.dispose).toHaveBeenCalledTimes(1);
    await h.app.onModuleDestroy();
  });
  it('清理失败仍占机器名额，下一轮清扫成功后才释放', async () => {
    vi.stubEnv('AUTH_SESSION_MAX', '1');
    const h = harness();
    h.dispose.mockRejectedValueOnce(new Error('helper offline'));
    const first = await h.app.beginAuth('codex', 'setup-token');
    await h.app.cancelAuth('codex', first.challengeRef);
    expect(h.store.entries()).toHaveLength(0);
    await expect(h.app.beginAuth('claude-code', 'setup-token')).rejects.toMatchObject({
      response: { code: 'AUTH_SESSION_CAPACITY' },
    });
    await h.app.sweepAuthSessions();
    await expect(h.app.beginAuth('claude-code', 'setup-token')).resolves.toMatchObject({
      challengeRef: 'login-2',
    });
    expect(h.dispose).toHaveBeenCalledTimes(2);
  });
  it('清理无响应10秒后返回，但未确认回收前保持名额并允许重试', async () => {
    vi.useFakeTimers();
    vi.stubEnv('AUTH_SESSION_MAX', '1');
    const h = harness();
    h.dispose.mockImplementationOnce(() => new Promise<undefined>(() => undefined));
    const first = await h.app.beginAuth('codex', 'setup-token');
    const cancelled = h.app.cancelAuth('codex', first.challengeRef);
    await vi.advanceTimersByTimeAsync(10_000);
    await cancelled;
    await expect(h.app.beginAuth('claude-code', 'setup-token')).rejects.toMatchObject({
      response: { code: 'AUTH_SESSION_CAPACITY' },
    });
    await h.app.cancelAuth('codex', first.challengeRef);
    await expect(h.app.beginAuth('claude-code', 'setup-token')).resolves.toBeDefined();
  });
  it('shutdown rejects new begins before allocating a helper', async () => {
    const h = harness();
    await h.app.onModuleDestroy();
    await expect(h.app.beginAuth('codex', 'setup-token')).rejects.toMatchObject({
      response: { code: 'PROVIDER_UNAVAILABLE' },
    });
    expect(h.helper.openSession).not.toHaveBeenCalled();
    expect(h.store.entries()).toEqual([]);
    expect(h.credentialWrites).not.toHaveBeenCalled();
  });
  it('a helper allocated after shutdown is disposed without starting auth or storing a session', async () => {
    const h = harness();
    const late = deferred<AuthHelperSession>();
    h.helper.openSession.mockImplementationOnce(() => late.promise);
    const result = h.app.beginAuth('codex', 'setup-token').catch((error: unknown) => error);
    await h.app.onModuleDestroy();
    late.resolve(h.session);
    expect(await result).toMatchObject({ response: { code: 'PROVIDER_UNAVAILABLE' } });
    expect(h.adapters[0].beginAuth).not.toHaveBeenCalled();
    expect(h.dispose).toHaveBeenCalledTimes(1);
    expect(h.store.entries()).toEqual([]);
    expect(h.credentialWrites).not.toHaveBeenCalled();
  });
  it('an adapter challenge arriving after shutdown is discarded and its helper disposed exactly once', async () => {
    const h = harness();
    const entered = deferred<void>();
    const late = deferred<AuthChallenge>();
    h.adapters[0].beginAuth = vi.fn(async () => {
      entered.resolve();
      return late.promise;
    });
    const result = h.app.beginAuth('codex', 'setup-token').catch((error: unknown) => error);
    await entered.promise;
    await h.app.onModuleDestroy();
    late.resolve({
      challengeRef: 'login-1',
      method: 'setup-token',
      kind: 'paste-prompt',
      instructions: 'late',
    });
    expect(await result).toMatchObject({ response: { code: 'PROVIDER_UNAVAILABLE' } });
    expect(h.dispose).toHaveBeenCalledTimes(1);
    expect(h.store.entries()).toEqual([]);
    expect(h.credentialWrites).not.toHaveBeenCalled();
    await h.app.onModuleDestroy();
    expect(h.dispose).toHaveBeenCalledTimes(1);
  });
});
