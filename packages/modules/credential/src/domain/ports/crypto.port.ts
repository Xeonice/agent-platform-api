import type { SecretMaterial } from '../value-objects/secret-material.vo';
import type { EncryptedBlob } from '../value-objects/encrypted-blob.vo';

/**
 * CryptoService PORT (docs/backend/23 §8.5, 05 §4). AES-256-GCM encrypt/decrypt
 * over the Vault master key. It is a PORT (not a pure domain service) because it
 * performs IO (loads the master key). Lives in `domain` so BOTH the application
 * (encrypt at store time) and the infrastructure git materializer (decrypt at use
 * time) can depend on it without crossing the application↔infra boundary — same
 * pattern as project's `GIT_CLONER`.
 */
export interface CryptoService {
  /** Encrypt plaintext → ciphertext blob (stamped with the current key fingerprint). */
  encrypt(plain: SecretMaterial): Promise<EncryptedBlob>;
  /**
   * Decrypt → plaintext Buffer wrapper. Throws `DecryptionError` on an authTag
   * mismatch or when the master key is unavailable (05 §4.2: the caller presents
   * the credential as `revoked` — it must NOT surface as a 500).
   */
  decrypt(blob: EncryptedBlob): Promise<SecretMaterial>;
}

/** authTag mismatch / master key unavailable (05 §4.2 — presented as revoked, not 500). */
export class DecryptionError extends Error {
  constructor(message = 'decryption failed') {
    super(message);
    this.name = 'DecryptionError';
  }
}

export const CRYPTO_SERVICE = Symbol('CryptoService');
