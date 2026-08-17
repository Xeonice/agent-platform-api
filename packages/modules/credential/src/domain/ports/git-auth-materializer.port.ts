import type { EncryptedBlob } from '../value-objects/encrypted-blob.vo';
import type { GitObtainedVia } from '../value-objects/obtained-via.vo';

/**
 * Structural equivalent of contracts' `GitAuthContext` (the domain must not import
 * `contracts`, boundaries §2.2). The application facade returns this as the
 * contracts `GitAuthContext` — the shapes are identical so it is assignable.
 */
export interface MaterializedGitAuth {
  env: Record<string, string>;
  gitSshCommand?: string;
  dispose(): Promise<void>;
}

/**
 * GitAuthMaterializer PORT (docs/backend/03 §7.3, 26 §A1). Turns an encrypted git
 * secret into an opaque `GitAuthContext` handle: decrypt → write the 0600 temp
 * keyfile (SSH) / assemble the env-scoped credential.helper (HTTPS) → env /
 * GIT_SSH_COMMAND → `dispose()`. The plaintext (`SecretMaterial`) NEVER leaves the
 * infrastructure impl (A1); the application facade only ever holds the handle.
 *
 * The port lives in `domain` so the application facade adapter (which drives it)
 * can depend on it without importing infrastructure.
 */
export interface MaterializeGitAuthInput {
  obtainedVia: GitObtainedVia;
  secret: EncryptedBlob;
  /** Full whitelist (HTTPS helper is bound per host); the current target host too. */
  allowedHosts: string[];
  host: string;
}

export interface GitAuthMaterializer {
  materialize(input: MaterializeGitAuthInput): Promise<MaterializedGitAuth>;
}

export const GIT_AUTH_MATERIALIZER = Symbol('GitAuthMaterializer');
