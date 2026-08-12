import type { DomainEvent } from './domain-event';

/**
 * AggregateRoot base — records domain events raised during a unit of work.
 * Events are drained by the application layer and written to the outbox
 * inside the same transaction (28 §7.3 EventBus.publishInTx).
 */
export abstract class AggregateRoot<TId> {
  private readonly _events: DomainEvent[] = [];

  protected constructor(public readonly id: TId) {}

  protected raise(event: DomainEvent): void {
    this._events.push(event);
  }

  pullEvents(): DomainEvent[] {
    const drained = [...this._events];
    this._events.length = 0;
    return drained;
  }
}
