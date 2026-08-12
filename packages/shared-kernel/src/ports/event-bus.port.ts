import type { Tx } from './unit-of-work.port';
import type { DomainEvent } from '../domain/domain-event';

/**
 * EventBus — domain events are written to the outbox in the SAME transaction as
 * the business write (docs/backend/28 §7.3, R-3). Hence `publishInTx(tx, …)`:
 * it participates in the synchronous UnitOfWork, it does not fire-and-forget.
 */
export interface EventBus {
  publishInTx(tx: Tx, events: DomainEvent[]): void;
}

export const EVENT_BUS = Symbol('EventBus');
