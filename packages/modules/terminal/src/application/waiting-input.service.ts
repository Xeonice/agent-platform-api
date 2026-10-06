import { Inject, Injectable } from '@nestjs/common';
import type { WaitingInputQueryPort } from '@platform/contracts';
import { WAITING_INPUT_OBSERVER } from '../domain/ports/waiting-input-observer.port';
import type { WaitingInputObserver } from '../domain/ports/waiting-input-observer.port';

/** The only application boundary to transient terminal observations. */
@Injectable()
export class WaitingInputService implements WaitingInputQueryPort {
  constructor(@Inject(WAITING_INPUT_OBSERVER) private readonly observer: WaitingInputObserver) {}

  attach(sessionId: string, sandboxId: string): void {
    this.observer.attach(sessionId, sandboxId);
  }
  output(sessionId: string, data: string): void {
    this.observer.output(sessionId, data);
  }
  input(sessionId: string): void {
    this.observer.input(sessionId);
  }
  detach(sessionId: string): void {
    this.observer.detach(sessionId);
  }
  isWaiting(sandboxId: string): boolean {
    return this.observer.isWaiting(sandboxId);
  }
  filterWaiting(sandboxIds: string[]): Set<string> {
    return this.observer.filterWaiting(sandboxIds);
  }
}
