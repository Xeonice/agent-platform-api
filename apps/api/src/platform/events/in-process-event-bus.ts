import { Injectable, Logger } from '@nestjs/common';
import type { EventBus, Tx, DomainEvent } from '@platform/shared-kernel';

/**
 * In-process EventBus (01 §5: "起步用进程内 EventEmitter 实现").
 *
 * Scaffold behavior: events are logged. The full implementation writes them to
 * the outbox table in the SAME transaction (`publishInTx(tx, …)`, 28 §7.3 R-3),
 * from which the outbox relay projects WS frames. The synchronous `tx` param is
 * kept in the signature now so the seam is correct from day one.
 */
@Injectable()
export class InProcessEventBus implements EventBus {
  private readonly logger = new Logger(InProcessEventBus.name);

  publishInTx(_tx: Tx, events: DomainEvent[]): void {
    for (const event of events) {
      this.logger.debug(`domain event: ${event.type}`);
    }
  }
}
