import type { CredentialId, Tx } from '@platform/shared-kernel';
import type { Credential } from '../entities/credential.entity';

/**
 * CredentialRepository PORT (docs/backend/23 §8.7 — git subset for this slice).
 * Reads are async; transactional writes are SYNCHRONOUS (`saveSync`/
 * `revokeAndEraseSync`/`touchLastUsedSync`) so the type system forbids `await`
 * inside the critical section (P0-2).
 */
export interface CredentialRepository {
  findById(id: CredentialId): Promise<Credential | null>;
  /** All git credentials (I-CRD-5: at most one non-revoked per obtained_via). */
  listGitCredentials(includeRevoked?: boolean): Promise<Credential[]>;
  saveSync(tx: Tx, cred: Credential): void;
  /** I-CRD-3: wipe ciphertext + set revoked_at in ONE statement (no middle state). */
  revokeAndEraseSync(tx: Tx, id: CredentialId, at: Date): void;
  touchLastUsedSync(tx: Tx, id: CredentialId, at: Date): void;
}

export const CREDENTIAL_REPOSITORY = Symbol('CredentialRepository');
