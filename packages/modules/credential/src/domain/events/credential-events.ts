import type { CredentialId, DomainEvent } from '@platform/shared-kernel';

/** Git credential domain events (docs/backend/23 §8.6). This slice raises Stored/Revoked. */
export class CredentialStored implements DomainEvent {
  readonly type = 'CredentialStored';
  constructor(
    readonly credentialId: CredentialId,
    readonly occurredAt: Date,
  ) {}
}

export class CredentialRevoked implements DomainEvent {
  readonly type = 'CredentialRevoked';
  constructor(
    readonly credentialId: CredentialId,
    readonly occurredAt: Date,
  ) {}
}

/** Runtime credential injected into a sandbox (23 §8.6, ledger source). */
export class CredentialInjected implements DomainEvent {
  readonly type = 'CredentialInjected';
  constructor(
    readonly credentialId: CredentialId,
    readonly sandboxId: string,
    readonly occurredAt: Date,
  ) {}
}
