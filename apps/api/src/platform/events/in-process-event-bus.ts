import { Injectable, Logger } from '@nestjs/common';
import type { EventBus, Tx, DomainEvent } from '@platform/shared-kernel';

/**
 * In-process EventBus (01 §5; 26 §10 决策 B; 28 §7.3). `publishInTx` records the
 * events during the synchronous transaction (the in-memory outbox for S1); once
 * the sync stack unwinds — i.e. AFTER the better-sqlite3 transaction has committed
 * and the request handler has returned — a microtask flushes the buffered batch
 * to every subscriber. So dispatch is post-commit and ordered, and a throwing
 * subscriber can never roll back the business write.
 *
 * The durable outbox table + cross-process relay (§10 relay 仅补漏) is a later
 * slice; this in-process path is the primary delivery for the single-node MVP.
 */
@Injectable()
export class InProcessEventBus implements EventBus {
  private readonly logger = new Logger(InProcessEventBus.name);
  private readonly handlers: Array<(events: DomainEvent[]) => void> = [];
  private buffer: DomainEvent[] = [];
  private flushScheduled = false;

  publishInTx(_tx: Tx, events: DomainEvent[]): void {
    if (events.length === 0) return;
    this.buffer.push(...events);
    if (!this.flushScheduled) {
      this.flushScheduled = true;
      queueMicrotask(() => this.flush());
    }
  }

  subscribe(handler: (events: DomainEvent[]) => void): void {
    this.handlers.push(handler);
  }

  private flush(): void {
    this.flushScheduled = false;
    if (this.buffer.length === 0) return;
    const batch = this.buffer;
    this.buffer = [];
    for (const event of batch) this.logger.debug(`domain event: ${event.type}`);
    for (const handler of this.handlers) {
      try {
        handler(batch);
      } catch (e) {
        this.logger.error(`event subscriber threw: ${(e as Error).message}`);
      }
    }
  }
}
