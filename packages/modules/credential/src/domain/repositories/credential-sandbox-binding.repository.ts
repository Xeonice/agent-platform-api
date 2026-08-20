import type { CredentialId, SandboxId, Tx } from '@platform/shared-kernel';
import type { CredentialSandboxBinding } from '../entities/credential-sandbox-binding.entity';

/**
 * CredentialSandboxBindingRepository PORT (docs/backend/23 §8.7). Writes are
 * synchronous (P0-2). `listByCredential` drives the revoke → live-sandbox
 * coordination; `findActive` gives the idempotent upsert (I-CSB-1).
 */
export interface CredentialSandboxBindingRepository {
  findActive(
    sandboxId: SandboxId,
    credentialId: CredentialId,
  ): Promise<CredentialSandboxBinding | null>;
  listBySandbox(sandboxId: SandboxId): Promise<CredentialSandboxBinding[]>;
  /** Bindings for a credential (revoke coordination). Excludes cleared unless asked. */
  listByCredential(
    credentialId: CredentialId,
    includeCleared?: boolean,
  ): Promise<CredentialSandboxBinding[]>;
  saveSync(tx: Tx, binding: CredentialSandboxBinding): void;
  /** I-CSB-2: mark a binding cleared (non-null revoked_at, cannot revert). */
  markClearedSync(tx: Tx, id: string, at: Date): void;
}

export const CREDENTIAL_SANDBOX_BINDING_REPOSITORY = Symbol('CredentialSandboxBindingRepository');
