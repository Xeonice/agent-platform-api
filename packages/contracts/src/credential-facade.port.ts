/**
 * Cross-context facade (docs/backend/23 §8, 27 §5, 03 §7.3): the third
 * cross-context facade alongside SANDBOX_FACADE / PROJECT_FACADE. The `project`
 * clone workflow needs, per clone, a READY-TO-USE git auth handle WITHOUT ever
 * touching plaintext — decrypt + write the 0600 temp keyfile + assemble
 * env / GIT_SSH_COMMAND + dispose() ALL happen inside `credential/infrastructure`.
 * The consumer only ever holds the opaque `GitAuthContext` (A1) — never a
 * `SecretMaterial`. Living in `contracts` keeps both sides boundaries-clean and
 * avoids a package cycle.
 */
import type { Tx } from '@platform/shared-kernel';
import type { RuntimeCredential } from './runtime-adapter.contract';

export const CREDENTIAL_FACADE = Symbol('CredentialFacade');

/**
 * Read port the credential facade uses to learn a runtime's effective mode
 * (`runtime_settings.active_auth_method`) WITHOUT importing the runtime module —
 * the runtime context provides the impl against this contracts token, so
 * `prepareRuntimeCredential(runtimeId)` can select by mode with no package cycle.
 * Returns `null` when the runtime has no settings row yet.
 */
export const RUNTIME_SETTINGS_READER = Symbol('RuntimeSettingsReader');
export interface RuntimeSettingsReader {
  activeAuthMethod(runtimeId: string): Promise<'account' | 'api-key' | null>;
}

/**
 * SYNC write port for `runtime_settings` used INSIDE the credential store
 * transaction (R-1 bounded exception ②, 24 §2.3): first-config writes `credentials`
 * + `runtime_settings` in ONE UoW. Implemented by the runtime module; injected into
 * the credential store path via this contracts token (no package cycle).
 */
export const RUNTIME_SETTINGS_WRITER = Symbol('RuntimeSettingsWriter');
export interface RuntimeSettingsWriter {
  /** Upsert the runtime's effective mode in the caller's transaction. */
  saveSync(tx: Tx, runtimeId: string, mode: 'account' | 'api-key', now: Date): void;
}

/**
 * Opaque git-auth handle (23 §8). The token lives ONLY in `env` (via `$GIT_TOKEN`
 * + the env-scoped credential.helper config, never in a URL/argv); the SSH keyfile
 * is pointed at by `gitSshCommand`. `dispose()` deletes the temp keyfile dir / drops
 * env references and MUST be called by the consumer in a `try/finally`.
 */
export interface GitAuthContext {
  /** Assembled injection env (GIT_TOKEN + GIT_CONFIG_* credential.helper for HTTPS). */
  env: Record<string, string>;
  /** SSH `GIT_SSH_COMMAND` pointing at this clone's keyfile (SSH only). */
  gitSshCommand?: string;
  dispose(): Promise<void>;
}

/**
 * The git remote's URL scheme, carried across the facade alongside `host` so the
 * HTTPS credential helper key is scheme-aware (03 §7.3 C4). git credential matching
 * is scheme+authority sensitive — `credential.https://h.helper` does NOT match a
 * plaintext `http://h/` remote — so a plaintext internal git host would never
 * receive its token unless the helper is keyed on the ACTUAL scheme. `allowedHosts`
 * stays scheme-agnostic (authorizing a host authorizes its http/https); only the
 * helper KEY tracks the scheme.
 */
export type GitRemoteScheme = 'http' | 'https' | 'ssh' | 'git';

export interface CredentialFacade {
  /**
   * Runtime out-口 (S4, P0-2 — parallel to `prepareGitAuth` but semantically
   * DIFFERENT): hand out a CONTROLLED-PLAINTEXT `RuntimeCredential` (NOT an opaque
   * handle — runtime credentials must be injected INTO a sandbox). Internally
   * `forRuntime` picks the effective credential by `runtime_settings.active_auth_method`
   * → `credential/infrastructure` decrypts and produces the `RuntimeCredential`.
   * The credential context NEVER reverse-depends on sandbox exec: the sandbox
   * orchestration side holds `exec` and calls `adapter.injectCredential(cred, exec)`,
   * then `zeroize()`s (23 §8.2, 27 §4). Throws `CredentialPreparationError`
   * (`NO_CREDENTIAL`) when the active mode has no usable credential.
   */
  prepareRuntimeCredential(runtimeId: string): Promise<RuntimeCredential>;

  /**
   * Record that the active runtime credential was injected into `sandboxId`
   * (23 §8.4 ledger, I-CSB-1). The credential context owns the ledger (it knows the
   * `credentialId`); the orchestration side passes only the `sandboxId` it holds.
   * Idempotent; a no-op when no active credential is configured.
   */
  recordRuntimeInjection(runtimeId: string, sandboxId: string): Promise<void>;

  /**
   * Resolve + materialize the effective git credential for `(kind, host, scheme)`
   * into an opaque handle. `forKind` selects the credential → `host ∈ allowedHosts`
   * is enforced (I-CRD-8) → `credential/infrastructure` decrypts and materializes.
   * `scheme` (the remote's actual http/https/…) makes the HTTPS helper key
   * scheme-aware so a plaintext `http://` internal remote still matches its helper.
   * Throws `CredentialPreparationError` when no credential is configured
   * (`NO_CREDENTIAL`) or the host is not whitelisted / not public (`HOST_NOT_ALLOWED`)
   * — the clone workflow catches it and falls back to the public-repo path.
   */
  prepareGitAuth(
    kind: 'git-ssh-key' | 'git-https-token',
    host: string,
    scheme: GitRemoteScheme,
  ): Promise<GitAuthContext>;
}

export type CredentialPreparationErrorCode = 'NO_CREDENTIAL' | 'HOST_NOT_ALLOWED';

/**
 * Boundaries-safe error `prepareGitAuth` throws. `NO_CREDENTIAL` = nothing to
 * carry (proceed as a public repo); `HOST_NOT_ALLOWED` = a credential exists but
 * the target host is not whitelisted or resolves to a private/internal address
 * (refuse to carry the credential, C/C4).
 */
export class CredentialPreparationError extends Error {
  constructor(
    readonly code: CredentialPreparationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CredentialPreparationError';
  }
}
