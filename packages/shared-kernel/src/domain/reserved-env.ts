/**
 * Reserved env-var blacklist (docs/backend/05 §4.1). The three-layer image/project/
 * Task env merge runs THROUGH this list before Vault credentials are written last
 * ("凭证永远赢" is guaranteed by ORDER, not by this list — this is a UX pre-check +
 * a CI reconcile target, NOT the only defense).
 *
 * JUDGEMENT (P1-2): the blacklist bans not only credential VARIABLE NAMES but every
 * var that can REDIRECT the credential-injection target or a CLI's credential
 * lookup path (`CLAUDE_CONFIG_DIR`, `CODEX_HOME` via the `CODEX_*` prefix, `HOME`) —
 * they carry no secret yet can point a CLI at an attacker-controlled cred dir.
 */

/** Exact-match reserved names (case-sensitive). */
export const RESERVED_ENV_EXACT: readonly string[] = [
  // credential variable names
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  // redirect-class: can point a CLI at another cred dir (P1-2)
  'CLAUDE_CONFIG_DIR',
  // git / infra
  'SSH_PRIVATE_KEY',
  'KUBECONFIG',
  'HOME',
  'USER',
  'PATH',
  'PWD',
  'DOCKER_HOST',
  'DOCKER_CONFIG',
] as const;

/** Prefix-match reserved names (whole prefix blocked). `CODEX_*` covers `CODEX_HOME`. */
export const RESERVED_ENV_PREFIXES: readonly string[] = ['CODEX_', 'GIT_'] as const;

/**
 * Env-var names a RuntimeAdapter may inject a credential through. The CI reconcile
 * test (25) asserts EACH is covered by the blacklist so "a new runtime's cred name
 * can be overridden in cleartext" cannot happen. Names covered by a prefix
 * (`CODEX_*`) are intentionally omitted here (already blocked structurally).
 */
export const RUNTIME_CREDENTIAL_ENV_NAMES: readonly string[] = [
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
] as const;

/** Redirect-class names the blacklist MUST list explicitly (05 §4.1 P1-2 CI list). */
export const CREDENTIAL_REDIRECT_ENV_NAMES: readonly string[] = [
  'CLAUDE_CONFIG_DIR',
  'CODEX_HOME',
  'HOME',
] as const;

/**
 * Names contributed by REGISTERED RuntimeAdapters (`RuntimeAdapter.reservedEnvNames`,
 * 04 §3 ★3z), unioned into the blacklist at boot by the runtime context.
 *
 * ── WHY A REGISTRATION AND NOT A PARAMETER ───────────────────────────────────
 * The one consumer that matters is `EnvVarSet` — an image-context DOMAIN value object
 * whose whole design point is 「存在即合法」: three call sites (image / project / task
 * env) construct it, and none of them can be trusted to remember an extra argument.
 * `domain` may not reach a registry either (boundaries: domain → shared-kernel only).
 * So the composition happens where the fact arrives — at registration — and the
 * predicate keeps its one-argument shape.
 *
 * ⚠️ ADDITIVE AND IDEMPOTENT BY CONSTRUCTION. Registering the same adapter twice, or a
 * second app instance in one test process, can only re-add names that were already
 * declared. `reset` exists for tests that must observe the base table alone.
 *
 * ⛔ RUNTIME IDS ARE AN OPEN REGISTRY, so this list cannot be a static table — that is
 * exactly the defect it repairs: the reconcile test used to assert 「hard-coded table A
 * ⊆ hard-coded table B」, which cannot go red when a NEW adapter shows up with names
 * nobody listed (05 §4.1 ★4.1a ①).
 */
const REGISTERED_RESERVED_ENV_NAMES = new Set<string>();

/** Union `names` into the blacklist. Called once per boot from the runtime context. */
export function registerReservedEnvNames(names: Iterable<string>): void {
  for (const name of names) {
    const trimmed = name.trim();
    if (trimmed !== '') REGISTERED_RESERVED_ENV_NAMES.add(trimmed);
  }
}

/** What adapters have contributed so far (diagnostics + the reconcile test). */
export function registeredReservedEnvNames(): readonly string[] {
  return [...REGISTERED_RESERVED_ENV_NAMES];
}

/** TEST ONLY: drop adapter-contributed names so a case can observe the base table. */
export function resetRegisteredReservedEnvNames(): void {
  REGISTERED_RESERVED_ENV_NAMES.clear();
}

/**
 * True when `name` is reserved (base exact table ∪ adapter-declared names ∪ prefixes).
 * Case-sensitive (05 §4.1).
 */
export function isReservedEnvName(name: string): boolean {
  if (RESERVED_ENV_EXACT.includes(name)) return true;
  if (REGISTERED_RESERVED_ENV_NAMES.has(name)) return true;
  return RESERVED_ENV_PREFIXES.some((p) => name.startsWith(p));
}
