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
} from '@platform/shared-kernel';
