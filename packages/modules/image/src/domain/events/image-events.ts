import type { DomainEvent } from '@platform/shared-kernel';

/** Image-context domain events (docs/backend/23 §9.6). Written to the outbox in-tx. */
export interface ImageRegistered extends DomainEvent {
  readonly type: 'image.registered';
  readonly manifestId: string;
  readonly imageId: string;
  readonly ref: string;
  readonly digest: string;
}

export interface ImageValidated extends DomainEvent {
  readonly type: 'image.validated';
  readonly manifestId: string;
  /** Carried on the event because 三级 is the whole product semantics (P21-4 §5). */
  readonly status: string;
}

export interface ImageActivated extends DomainEvent {
  readonly type: 'image.activated';
  readonly manifestId: string;
}

export interface ImageDeactivated extends DomainEvent {
  readonly type: 'image.deactivated';
  readonly manifestId: string;
}

export interface ImageConfigUpdated extends DomainEvent {
  readonly type: 'image.config_updated';
  readonly manifestId: string;
}
