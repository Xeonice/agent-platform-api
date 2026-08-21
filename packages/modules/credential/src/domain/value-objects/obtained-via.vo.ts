/**
 * Credential `obtained_via` enums (docs/backend/23 §8.1, 13 §2.5.1). The column is
 * the SUPERSET `RuntimeAuthMethod ∪ {git-ssh-key, git-https-token}`; this file owns
 * both halves + the wire↔domain maps + the runtime `mode` derivation.
 */

/** git half — `mode` is always NULL for these (I-CRD-1). */
export type GitObtainedVia = 'git-ssh-key' | 'git-https-token';

/**
 * runtime half (S4). Mirrors the contract `RuntimeAuthMethod` (04 §3) and the DB
 * CHECK's four runtime values. The domain re-declares the union locally rather than
 * importing `contracts` (boundaries: domain → shared-kernel only).
 */
export type RuntimeAuthMethod = 'setup-token' | 'oauth-device' | 'api-key' | 'access-token-paste';

/** Full superset carried by the `obtained_via` column. */
export type ObtainedVia = GitObtainedVia | RuntimeAuthMethod;

/** Effective mode class (13 §2.5.1): `uq_cred_runtime_active` keys on this, not obtained_via. */
export type RuntimeMode = 'account' | 'api-key';

const RUNTIME_AUTH_METHODS: readonly RuntimeAuthMethod[] = [
  'setup-token',
  'oauth-device',
  'api-key',
  'access-token-paste',
];

export function isRuntimeAuthMethod(v: string): v is RuntimeAuthMethod {
  return (RUNTIME_AUTH_METHODS as readonly string[]).includes(v);
}

export function isGitObtainedVia(v: string): v is GitObtainedVia {
  return v === 'git-ssh-key' || v === 'git-https-token';
}

/**
 * Derive the runtime `mode` from `obtained_via` (13 §2.5.1): `api-key` → `api-key`;
 * every account-class method (`setup-token`/`oauth-device`/`access-token-paste`) →
 * `account`. Storing `mode` (not deriving it virtually) lets the partial-unique
 * index key on it.
 */
export function modeForRuntimeMethod(via: RuntimeAuthMethod): RuntimeMode {
  return via === 'api-key' ? 'api-key' : 'account';
}

// Single source of truth lives in the shared kernel's git-platform registry; re-export
// so domain code keeps its familiar `./obtained-via.vo` import site without a duplicate
// literal union (the domain boundary allows `domain → shared-kernel`, not `→ contracts`).
export type { GitPlatform } from '@platform/shared-kernel';

/** Wire `type` (27 §5) ↔ domain `obtained_via`. */
export function obtainedViaFromType(type: 'ssh-key' | 'https-token'): GitObtainedVia {
  return type === 'ssh-key' ? 'git-ssh-key' : 'git-https-token';
}

export function typeFromObtainedVia(via: GitObtainedVia): 'ssh-key' | 'https-token' {
  return via === 'git-ssh-key' ? 'ssh-key' : 'https-token';
}
