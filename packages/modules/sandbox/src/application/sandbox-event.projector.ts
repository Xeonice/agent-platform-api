import { Inject, Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { EVENT_BUS } from '@platform/shared-kernel';
import type { DomainEvent, EventBus } from '@platform/shared-kernel';
import { SANDBOX_EVENT_BROADCASTER } from '@platform/contracts';
import type { SandboxEventBroadcaster, SandboxWsEvent } from '@platform/contracts';
import { SandboxCreated, SandboxStateChanged } from '../domain/events/sandbox-events';

/**
 * Projects sandbox DOMAIN events into `/events` WS projections (23 §12: the domain
 * event is the source, the WS frame is a not-1:1 projection). Subscribes to the
 * post-commit EventBus and pushes `SandboxWsEvent`s through the broadcaster port.
 *
 * S1 emits: SandboxCreated → `sandbox.created`; SandboxStateChanged →
 * `sandbox.status_changed` (+ `sandbox.removed` when the terminal state is
 * `destroyed`). Other union variants (waiting_input/clone_progress/runtime-auth)
 * are produced by later slices.
 */
@Injectable()
export class SandboxEventProjector implements OnApplicationBootstrap {
  constructor(
    @Inject(EVENT_BUS) private readonly events: EventBus,
    @Inject(SANDBOX_EVENT_BROADCASTER) private readonly broadcaster: SandboxEventBroadcaster,
  ) {}

  onApplicationBootstrap(): void {
    this.events.subscribe((batch) => this.onEvents(batch));
  }

  private onEvents(batch: DomainEvent[]): void {
    for (const domainEvent of batch) {
      for (const ws of this.project(domainEvent)) {
        this.broadcaster.broadcast(ws);
      }
    }
  }

  private project(e: DomainEvent): SandboxWsEvent[] {
    if (e instanceof SandboxCreated) {
      return [{ event: 'sandbox.created', sandboxId: e.sandboxId, projectId: e.projectId }];
    }
    if (e instanceof SandboxStateChanged) {
      const out: SandboxWsEvent[] = [
        {
          event: 'sandbox.status_changed',
          sandboxId: e.sandboxId,
          status: e.to,
          // present only on `failed` — the LIVE channel for a failure code, since an
          // async provision has no HTTP response left to carry one (04 §4).
          errorCode: e.errorCode,
        },
      ];
      if (e.to === 'destroyed') out.push({ event: 'sandbox.removed', sandboxId: e.sandboxId });
      return out;
    }
    return [];
  }
}
