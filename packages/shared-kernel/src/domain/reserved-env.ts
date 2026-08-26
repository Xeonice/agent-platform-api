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

/** True when `name` is reserved (exact or prefix). Case-sensitive (05 §4.1). */
export function isReservedEnvName(name: string): boolean {
  if (RESERVED_ENV_EXACT.includes(name)) return true;
  return RESERVED_ENV_PREFIXES.some((p) => name.startsWith(p));
}
