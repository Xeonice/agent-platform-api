import type { CredentialId, Tx } from '@platform/shared-kernel';
import type { Credential } from '../entities/credential.entity';
import type { EncryptedBlob } from '../value-objects/encrypted-blob.vo';

/**
 * CredentialRepository PORT (docs/backend/23 §8.7 — git + runtime). Reads are async;
 * transactional writes are SYNCHRONOUS (`*Sync`) so the type system forbids `await`
 * inside the critical section (P0-2).
 */
export interface CredentialRepository {
  findById(id: CredentialId): Promise<Credential | null>;
  /** All git credentials (I-CRD-5: at most one non-revoked per obtained_via). */
  listGitCredentials(includeRevoked?: boolean): Promise<Credential[]>;
  /** All credentials of a runtime (I-CRD-5: at most one non-revoked per mode). */
  listByRuntime(runtimeId: string, includeRevoked?: boolean): Promise<Credential[]>;
  /** Runtime credentials whose access token is due for refresh (05 §5.1). */
  listRefreshDue(at: Date): Promise<Credential[]>;
  /** Non-revoked credentials with `expires_at < at` (expiry warning scan, 05 §5). */
  listExpiringBefore(at: Date): Promise<Credential[]>;
  saveSync(tx: Tx, cred: Credential): void;
  /** I-CRD-3: wipe ciphertext + set revoked_at in ONE statement (no middle state). */
  revokeAndEraseSync(tx: Tx, id: CredentialId, at: Date): void;
  touchLastUsedSync(tx: Tx, id: CredentialId, at: Date): void;
  /**
   * Refresh write-back (P2-2, atomic like revokeAndEraseSync): ONE UPDATE overwrites
   * encrypted_blob/iv/auth_tag + expires_at + last_refreshed_at and ZEROES
   * refresh_failures — no "new ciphertext written but expires_at stale" middle state.
   */
  refreshSync(
    tx: Tx,
    id: CredentialId,
    newBlob: EncryptedBlob,
    newExpiresAt: Date,
    now: Date,
  ): void;
  /** Increment refresh_failures (05 §5.1: ≥3 stops + presents as expired). */
  recordRefreshFailureSync(tx: Tx, id: CredentialId): void;
}

export const CREDENTIAL_REPOSITORY = Symbol('CredentialRepository');
