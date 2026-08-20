import type { CredentialId, SandboxId } from '@platform/shared-kernel';

/**
 * CredentialSandboxBinding (docs/backend/23 §8.4). An injection ledger row — two IDs
 * + timestamps, NO ciphertext (D-7). Invariants: I-CSB-1 `(sandboxId, credentialId)`
 * unique (DB); I-CSB-2 `revokedAt` non-null = cleared, cannot revert.
 */
export interface CredentialSandboxBindingProps {
  id: string;
  credentialId: CredentialId;
  sandboxId: SandboxId;
  injectedAt: Date;
  revokedAt: Date | null;
}

export class CredentialSandboxBinding {
  readonly id: string;
  readonly credentialId: CredentialId;
  readonly sandboxId: SandboxId;
  readonly injectedAt: Date;
  private _revokedAt: Date | null;

  private constructor(props: CredentialSandboxBindingProps) {
    this.id = props.id;
    this.credentialId = props.credentialId;
    this.sandboxId = props.sandboxId;
    this.injectedAt = props.injectedAt;
    this._revokedAt = props.revokedAt;
  }

  static record(input: {
    id: string;
    credentialId: CredentialId;
    sandboxId: SandboxId;
    now: Date;
  }): CredentialSandboxBinding {
    return new CredentialSandboxBinding({
      id: input.id,
      credentialId: input.credentialId,
      sandboxId: input.sandboxId,
      injectedAt: input.now,
      revokedAt: null,
    });
  }

  static rehydrate(props: CredentialSandboxBindingProps): CredentialSandboxBinding {
    return new CredentialSandboxBinding(props);
  }

  get revokedAt(): Date | null {
    return this._revokedAt;
  }

  isCleared(): boolean {
    return this._revokedAt !== null;
  }
}
