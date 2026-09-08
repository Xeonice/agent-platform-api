/**
 * Re-export of the reserved env-var blacklist (docs/backend/05 §4.1).
 *
 * ⚠️ THE LIST ITSELF LIVES IN `shared-kernel`, AND THAT MOVE IS FORCED, NOT STYLISTIC.
 * Two layers must apply the SAME list: `contracts` (the wire-level pre-check) and the
 * image context's `EnvVarSet` value object, which validates 构造即校验 inside `domain`
 * — and `eslint-plugin-boundaries` forbids `domain → contracts`. shared-kernel is the
 * only point both may depend on, exactly as `GIT_PLATFORM_REGISTRY` and `git-remote`
 * already do for the same reason (04 §8 方式三).
 *
 * A copy in each layer is the alternative, and 「同一个词在两处指不同东西，就一定会
 * 出事」 applies verbatim to a blacklist: the copy that misses `CODEX_HOME` accepts a
 * variable that redirects a CLI at an attacker-controlled credential directory.
 */
export {
  RESERVED_ENV_EXACT,
  RESERVED_ENV_PREFIXES,
  RUNTIME_CREDENTIAL_ENV_NAMES,
  CREDENTIAL_REDIRECT_ENV_NAMES,
  isReservedEnvName,
  registerReservedEnvNames,
  registeredReservedEnvNames,
  resetRegisteredReservedEnvNames,
} from '@platform/shared-kernel';

import type { RuntimeAdapter, RuntimeAdapterRegistry } from './runtime-adapter.contract';

/**
 * Every env name the REGISTERED adapters declare as theirs (04 §3 ★3z
 * `reservedEnvNames`), both classes flattened — this is what the runtime context feeds
 * `registerReservedEnvNames` at boot.
 *
 * ⚠️ THE TWO CLASSES ARE FLATTENED HERE ON PURPOSE, AND THEY ARE STILL DECLARED
 * SEPARATELY. The blacklist treats them identically (both are refused), but the split
 * carries the REASON, which is what 05 §4.1's CI list is about: `credential` names are
 * additionally protected by the env merge ORDER, `redirect` names are protected by
 * NOTHING ELSE. Losing the distinction at the declaration site would make it
 * impossible to state the second, stronger clause at all.
 */
export function runtimeReservedEnvNamesOf(
  registry: Pick<RuntimeAdapterRegistry, 'list'>,
): string[] {
  return adapterReservedEnvNames(registry.list());
}

/** Same, over an explicit adapter list (the reconcile test drives this half). */
export function adapterReservedEnvNames(adapters: readonly RuntimeAdapter[]): string[] {
  const names = new Set<string>();
  for (const adapter of adapters) {
    const declared = adapter.reservedEnvNames;
    if (!declared) continue;
    for (const name of [...declared.credential, ...declared.redirect]) names.add(name);
  }
  return [...names];
}
