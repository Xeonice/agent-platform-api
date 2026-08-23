import { describe, it, expect } from 'vitest';
import { UnknownRuntimeError } from '@platform/contracts';
import type { RuntimeAdapter } from '@platform/contracts';
import { DefaultRuntimeAdapterRegistry } from '../../src/infrastructure/registry/runtime-adapter.registry';
import { CodexAdapter } from '../../src/infrastructure/adapters/codex/codex.adapter';
import { ClaudeCodeAdapter } from '../../src/infrastructure/adapters/claude-code/claude-code.adapter';

/** The REAL registry class (04 §8), symmetric with the sandbox provider registry. */
const makeRegistry = (): DefaultRuntimeAdapterRegistry =>
  new DefaultRuntimeAdapterRegistry(new CodexAdapter(), new ClaudeCodeAdapter());

function thirdParty(id: string): RuntimeAdapter {
  return {
    id,
    displayName: 'Acme Agent',
    vendor: 'Acme Inc',
    loginCommand: () => [id, 'login'],
    getAuthMethods: () => ['api-key'],
    beginAuth: async () => {
      throw new Error('unused');
    },
    completeAuth: async () => {
      throw new Error('unused');
    },
    injectCredential: async () => {},
  };
}

describe('DefaultRuntimeAdapterRegistry — the open extension point (04 §8)', () => {
  it('starts with the two built-ins', () => {
    expect(
      makeRegistry()
        .list()
        .map((a) => a.id)
        .sort(),
    ).toEqual(['claude-code', 'codex']);
  });

  it('register() adds an adapter that get/has/list see immediately', () => {
    const registry = makeRegistry();
    expect(registry.has('acme')).toBe(false);

    const acme = thirdParty('acme');
    registry.register(acme);

    expect(registry.has('acme')).toBe(true);
    expect(registry.get('acme')).toBe(acme);
    expect(registry.list().map((a) => a.id)).toContain('acme');
  });

  it('a duplicate id FAILS FAST instead of silently overwriting (04 §8)', () => {
    const registry = makeRegistry();
    const first = thirdParty('acme');
    registry.register(first);

    expect(() => registry.register(thirdParty('acme'))).toThrow(/duplicate runtime adapter id/i);
    expect(registry.get('acme')).toBe(first);
  });

  it('shadowing a BUILT-IN id is the same fail-fast — codex keeps its adapter', () => {
    const registry = makeRegistry();
    expect(() => registry.register(thirdParty('codex'))).toThrow(/duplicate runtime adapter id/i);
    expect(registry.get('codex')).toBeInstanceOf(CodexAdapter);
  });

  /**
   * ⚠️ THE THROW HAS TO CARRY A CODE, and that is the whole content of this test.
   * Callers that skip `has()` — the task pump re-attaching after a restart, the terminal
   * building an attach command — funnel it into a `code`-reading failure path, and a
   * bare `Error` has none, so "no adapter with this id" was filed as `INTERNAL`
   * (04 §4 / 14 §10). `retryable:false` matters just as much: nothing about waiting puts
   * an adapter in the registry, so a [重试] button here can only ever fail again.
   */
  it('get() on a missing id throws the TYPED UNKNOWN_RUNTIME error, not a bare Error', () => {
    const registry = makeRegistry();
    expect(() => registry.get('shell')).toThrow(UnknownRuntimeError);
    expect(() => registry.get('shell')).toThrow(/unknown runtime 'shell'/i);
    const e = (() => {
      try {
        registry.get('shell');
        return null;
      } catch (err) {
        return err as UnknownRuntimeError;
      }
    })();
    expect(e).toMatchObject({ code: 'UNKNOWN_RUNTIME', retryable: false, runtimeId: 'shell' });
  });
});
