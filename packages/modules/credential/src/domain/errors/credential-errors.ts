/**
 * Domain errors for the credential context (docs/backend/23 §8). The interface
 * layer maps these to HTTP; the application maps some to Nest exceptions.
 */

/** A store request violated an invariant (I-CRD-1/6/8, bad input) → HTTP 400. */
export class InvalidCredentialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidCredentialError';
  }
}

/** SSH private key carries a passphrase (I-CRD-6) → HTTP 400. */
export class PassphraseProtectedKeyError extends InvalidCredentialError {
  constructor(reason: string) {
    super(`SSH private key must not be passphrase-protected: ${reason}`);
    this.name = 'PassphraseProtectedKeyError';
  }
}

/** Attempted to materialize / select a revoked credential (I-CRD-4). */
export class CredentialRevokedError extends Error {
  constructor(message = 'credential is revoked') {
    super(message);
    this.name = 'CredentialRevokedError';
  }
}
