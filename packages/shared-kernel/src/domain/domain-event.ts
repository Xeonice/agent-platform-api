/** Base shape for domain events (docs/backend 23 §12 / 28 §10). */
export interface DomainEvent {
  readonly type: string;
  readonly occurredAt: Date;
}
