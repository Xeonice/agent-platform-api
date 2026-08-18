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
export const CREDENTIAL_FACADE = Symbol('CredentialFacade');

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
