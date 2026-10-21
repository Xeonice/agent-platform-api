import type { CredentialId, SandboxId, Tx } from '@platform/shared-kernel/pure';
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
  listPendingRevocations(credentialId?: CredentialId): Promise<CredentialSandboxBinding[]>;
  migrateCredentialSync(tx: Tx, previousId: CredentialId, nextId: CredentialId): void;
  saveIfUsableSync(
    tx: Tx,
    binding: CredentialSandboxBinding,
    runtimeId: string,
    now: Date,
  ): boolean;
  saveSync(tx: Tx, binding: CredentialSandboxBinding): void;
  /** I-CSB-2: clear only this exact uncleared binding of a revoked credential.
   * A refresh may have migrated the row after the caller read its identity. */
  markClearedSync(
    tx: Tx,
    identity: Readonly<{ id: string; credentialId: CredentialId; sandboxId: SandboxId }>,
    at: Date,
  ): boolean;
}

export const CREDENTIAL_SANDBOX_BINDING_REPOSITORY = Symbol('CredentialSandboxBindingRepository');
