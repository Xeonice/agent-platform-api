// 两个 adapter 不许用同一个 env 名注入凭证 —— **启动就炸**（03 §4.3 ④ / 05 §4.1）。
//
// ── 为什么是本切片才需要的 ──────────────────────────────────────────────────
// 在此之前一个沙箱只注入**一份**凭证，撞名没有后果。现在 provision 把所有已配置的
// 凭证合进**同一张** env 表：两个 adapter 声明了同一个名字，就意味着其中一个 CLI 会
// 读到另一家的令牌 —— 而它不会报错，只是"登录不上"，或者更糟：用另一个账号干活。
import { describe, it, expect } from 'vitest';
import type { RuntimeAdapter, RuntimeAdapterRegistry } from '@platform/contracts';
import { ReservedEnvNameRegistrar } from '../../src/infrastructure/registry/reserved-env.registrar';

/**
 * 一个只在乎 `reservedEnvNames` 的 adapter 替身。
 *
 * ⛔ 仓规禁 `as unknown as` 双重断言，⚠️ 其余方法也**不给空壳**：本组用例不该走到它们，
 * 真被调到要的是一条响亮的失败，而不是一个悄悄生效的返回值。
 */
function adapter(id: string, credential: string[], redirect: string[] = []): RuntimeAdapter {
  const nope = (name: string): (() => never) => {
    return () => {
      throw new Error(`RuntimeAdapter.${name} 不该被这组用例调用`);
    };
  };
  return {
    id,
    displayName: id,
    vendor: 'test',
    reservedEnvNames: { credential, redirect },
    loginCommand: nope('loginCommand'),
    getAuthMethods: nope('getAuthMethods'),
    beginAuth: nope('beginAuth'),
    completeAuth: nope('completeAuth'),
    injectCredential: nope('injectCredential'),
    getInstallPlan: nope('getInstallPlan'),
    isInstalled: nope('isInstalled'),
    install: nope('install'),
    buildStartCommand: nope('buildStartCommand'),
    buildAttachCommand: nope('buildAttachCommand'),
  };
}

function registrarOf(adapters: RuntimeAdapter[]): ReservedEnvNameRegistrar {
  const registry: RuntimeAdapterRegistry = {
    register: () => {},
    get: (id) => adapters.find((a) => a.id === id) as RuntimeAdapter,
    has: (id) => adapters.some((a) => a.id === id),
    list: () => adapters,
  };
  return new ReservedEnvNameRegistrar(registry);
}

describe('ReservedEnvNameRegistrar —— 凭证 env 名撞车', () => {
  it('内置的两个 adapter 不撞（这条同时是"本仓当前状态"的回归）', () => {
    const registrar = registrarOf([
      adapter('codex', ['OPENAI_API_KEY'], ['CODEX_HOME']),
      adapter(
        'claude-code',
        ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'],
        ['CLAUDE_CONFIG_DIR'],
      ),
    ]);
    expect(() => registrar.onApplicationBootstrap()).not.toThrow();
  });

  it('⭐ 撞了 ⇒ **启动抛**，⛔ 不按注册顺序静默覆盖', () => {
    // 注册顺序是模块加载次序，不表达任何意图 —— "谁在后面谁赢"没有依据，
    // 而它的后果是沉默的。
    const registrar = registrarOf([
      adapter('acme', ['SHARED_TOKEN']),
      adapter('other', ['SHARED_TOKEN']),
    ]);
    expect(() => registrar.onApplicationBootstrap()).toThrow(/SHARED_TOKEN/);
    expect(() => registrar.onApplicationBootstrap()).toThrow(/acme/);
    expect(() => registrar.onApplicationBootstrap()).toThrow(/other/);
  });

  it('⚠️ 同一个 adapter 自己重复声明同一个名字**不算撞**（那只是写重了）', () => {
    const registrar = registrarOf([adapter('acme', ['T', 'T'])]);
    expect(() => registrar.onApplicationBootstrap()).not.toThrow();
  });

  it('⚠️ 只有 `credential` 类参与判定 —— `redirect` 撞名不会让两份凭证互相覆盖', () => {
    // redirect 是黑名单用途（挡用户设的 env），它重名不会让谁读到别人的令牌。
    const registrar = registrarOf([
      adapter('acme', ['A_KEY'], ['SHARED_DIR']),
      adapter('other', ['O_KEY'], ['SHARED_DIR']),
    ]);
    expect(() => registrar.onApplicationBootstrap()).not.toThrow();
  });
});
