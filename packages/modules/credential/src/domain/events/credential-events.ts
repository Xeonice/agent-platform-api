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
