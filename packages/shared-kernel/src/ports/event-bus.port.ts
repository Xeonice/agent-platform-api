import type { Tx } from './unit-of-work.port';
import type { DomainEvent } from '../domain/domain-event';

/**
 * EventBus — domain events are written to the outbox in the SAME transaction as
 * the business write (docs/backend/28 §7.3, R-3). Hence `publishInTx(tx, …)`:
 * it participates in the synchronous UnitOfWork, it does not fire-and-forget.
 *
 * `subscribe` registers an in-process consumer that receives each committed
 * batch AFTER the transaction commits (26 §10 决策 B: in-tx write + post-commit
 * synchronous dispatch). A subscriber that throws must not roll back the write.
 */
export interface EventBus {
  publishInTx(tx: Tx, events: DomainEvent[]): void;
  subscribe(handler: (events: DomainEvent[]) => void): void;
}

export const EVENT_BUS = Symbol('EventBus');
