import { afterEach, describe, it, expect } from 'vitest';
import {
  CREDENTIAL_REDIRECT_ENV_NAMES,
  RUNTIME_CREDENTIAL_ENV_NAMES,
  adapterReservedEnvNames,
  isReservedEnvName,
  registerReservedEnvNames,
  resetRegisteredReservedEnvNames,
  runtimeReservedEnvNamesOf,
} from '../../src/reserved-env';
import type { RuntimeAdapter, RuntimeAdapterRegistry } from '../../src/runtime-adapter.contract';

/**
 * Env blacklist reconcile (docs/backend/05 §4.1).
 *
 * ⛔ WHAT THIS FILE USED TO ASSERT, AND WHY IT WAS WORTHLESS. The doc promises a CI
 * check that goes red 「新增 adapter 时若其 `RuntimeCredential` 用到新的 env 名」. The
 * implementation was:
 *
 *     for (const name of RUNTIME_CREDENTIAL_ENV_NAMES) expect(isReservedEnvName(name)).toBe(true);
 *
 * i.e. 「hard-coded table A is covered by hard-coded table B」 — a tautology that
 * enumerates NO adapter and therefore cannot go red when a new one arrives (★4.1a ①).
 * The property that actually matters is that the blacklist is DERIVED from the
 * registry, so the cases below drive real adapters through the real collection path.
 */

/** Minimal open registry — the same shape the composition root binds. */
function registryWith(adapters: RuntimeAdapter[]): RuntimeAdapterRegistry {
  const map = new Map(adapters.map((a) => [a.id, a]));
  return {
    register(a) {
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

/**
 * An adapter that declares nothing but its env names. Every other member throws: this
 * suite must not accidentally depend on behaviour it is not testing, and a double that
 * answers questions nobody asked is how a stub starts lying (see `test/_run-half.ts`).
 */
function adapterDeclaring(
  id: string,
  reservedEnvNames: { credential: readonly string[]; redirect: readonly string[] },
): RuntimeAdapter {
  const unused = (): never => {
    throw new Error(`${id}: this adapter member is not exercised by the env-blacklist suite`);
  };
  return {
    id,
    displayName: id,
    vendor: 'test',
    reservedEnvNames,
    loginCommand: unused,
    getAuthMethods: () => ['api-key'],
    beginAuth: unused,
    completeAuth: unused,
    injectCredential: unused,
    getInstallPlan: unused,
    isInstalled: unused,
    install: unused,
    buildStartCommand: unused,
    buildAttachCommand: unused,
  };
}

afterEach(() => resetRegisteredReservedEnvNames());

describe('reserved env blacklist (05 §4.1)', () => {
  it('blocks CLAUDE_CONFIG_DIR (P1-2 redirect-class)', () => {
    expect(isReservedEnvName('CLAUDE_CONFIG_DIR')).toBe(true);
  });

  it('the base table still covers the built-in credential + redirect names', () => {
    // Kept as a REGRESSION floor, not as the reconcile: these names must stay blocked
    // even with zero adapters registered (a boot that failed to enumerate the registry
    // must still refuse `ANTHROPIC_API_KEY`).
    for (const name of [...RUNTIME_CREDENTIAL_ENV_NAMES, ...CREDENTIAL_REDIRECT_ENV_NAMES]) {
      expect(isReservedEnvName(name), `${name} must be reserved`).toBe(true);
    }
  });

  it('blocks the CODEX_* / GIT_* prefixes (covers CODEX_HOME, GIT_SSH_COMMAND)', () => {
    expect(isReservedEnvName('CODEX_HOME')).toBe(true);
    expect(isReservedEnvName('CODEX_ANYTHING')).toBe(true);
    expect(isReservedEnvName('GIT_SSH_COMMAND')).toBe(true);
  });

  it('permits an ordinary user variable', () => {
    expect(isReservedEnvName('MY_APP_FLAG')).toBe(false);
    expect(isReservedEnvName('NODE_ENV')).toBe(false);
  });

  it('⛔ ENUMERATES THE REGISTRY: every name a registered adapter declares becomes reserved', () => {
    const registry = registryWith([
      adapterDeclaring('acme-agent', {
        credential: ['ACME_API_KEY'],
        // the redirect class — the one with NO backstop from the env merge order
        redirect: ['ACME_CONFIG_DIR'],
      }),
      adapterDeclaring('zeta', { credential: ['ZETA_TOKEN'], redirect: [] }),
    ]);

    // pre-condition: nothing about these names is in any hard-coded table
    for (const name of ['ACME_API_KEY', 'ACME_CONFIG_DIR', 'ZETA_TOKEN']) {
      expect(isReservedEnvName(name), `${name} must not be pre-blessed`).toBe(false);
    }

    registerReservedEnvNames(runtimeReservedEnvNamesOf(registry));

    for (const adapter of registry.list()) {
      for (const name of [
        ...(adapter.reservedEnvNames?.credential ?? []),
        ...(adapter.reservedEnvNames?.redirect ?? []),
      ]) {
        expect(isReservedEnvName(name), `${adapter.id} declared ${name}; it must be reserved`).toBe(
          true,
        );
      }
    }
  });

  it('an adapter that declares NOTHING contributes nothing (declaring is opt-in)', () => {
    const silent = adapterDeclaring('quiet', { credential: [], redirect: [] });
    const bare: RuntimeAdapter = { ...silent, reservedEnvNames: undefined };
    expect(adapterReservedEnvNames([bare])).toEqual([]);
    expect(isReservedEnvName('QUIET_ANYTHING')).toBe(false);
  });

  it('duplicate declarations across adapters collapse (a set, not a list)', () => {
    const a = adapterDeclaring('a', { credential: ['SHARED_KEY'], redirect: [] });
    const b = adapterDeclaring('b', { credential: ['SHARED_KEY'], redirect: [] });
    expect(adapterReservedEnvNames([a, b])).toEqual(['SHARED_KEY']);
  });
});
