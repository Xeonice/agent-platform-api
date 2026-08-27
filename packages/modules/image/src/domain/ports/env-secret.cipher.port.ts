/**
 * Field-level cipher for `secret: true` env values (13 §2.4.3, 23 I-IMG-5).
 *
 * It is a PORT rather than a pure domain service because it performs IO (it loads the
 * platform master key). It lives in `domain` so the application layer (seal at save
 * time) and the infrastructure layer (open at injection time) can both depend on it
 * without either crossing the application↔infrastructure boundary — the same shape as
 * credential's `CryptoService` and project's `GIT_CLONER`.
 */
export interface SealedEnvValue {
  blob: string;
  iv: string;
  authTag: string;
  keyId: string;
}

export interface EnvSecretCipher {
  seal(plain: string): SealedEnvValue;
  open(sealed: SealedEnvValue): string;
}

export const ENV_SECRET_CIPHER = Symbol('EnvSecretCipher');
