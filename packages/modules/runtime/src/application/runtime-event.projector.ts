import { Inject, Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { EVENT_BUS } from '@platform/shared-kernel';
import type { DomainEvent, EventBus } from '@platform/shared-kernel';
import { SANDBOX_EVENT_BROADCASTER } from '@platform/contracts';
import type { SandboxEventBroadcaster, SandboxWsEvent } from '@platform/contracts';
import { RuntimeInstallationStateChanged } from '../domain/events/runtime-events';

/**
 * Projects runtime DOMAIN events into `/events` WS frames (23 §12). Today exactly
 * one projection exists: `RuntimeInstallationStateChanged` → `runtime.install_progress`.
 *
 * WHY THIS IS A SEPARATE EVENT INSTEAD OF `sandbox.status_changed`: throughout the
 * install, `sandboxes.status` stays at `starting` — measured at 753s for a cold
 * claude-code (04 §3 ★1). Reusing `status_changed` would emit a run of "state
 * changes" where nothing changed, breaking its "EVERY transition" contract and the
 * frontend patch logic; without any event, the progress card just sits on "启动实例"
 * for twelve minutes.
 */
@Injectable()
export class RuntimeEventProjector implements OnApplicationBootstrap {
  constructor(
    @Inject(EVENT_BUS) private readonly events: EventBus,
    @Inject(SANDBOX_EVENT_BROADCASTER) private readonly broadcaster: SandboxEventBroadcaster,
  ) {}

  onApplicationBootstrap(): void {
    this.events.subscribe((batch) => this.onEvents(batch));
  }

  private onEvents(batch: DomainEvent[]): void {
    for (const e of batch) {
      const ws = this.project(e);
      if (ws) this.broadcaster.broadcast(ws);
    }
  }

  private project(e: DomainEvent): SandboxWsEvent | null {
    if (!(e instanceof RuntimeInstallationStateChanged)) return null;
    return {
      event: 'runtime.install_progress',
      sandboxId: e.sandboxId,
      runtime: e.runtimeId,
      status: e.status,
      versionDetected: e.versionDetected,
      // the frontend does not act on a failed install here — the `sandbox.status_changed`
      // → `failed` that follows immediately is the authoritative signal (10 §3.1).
      errorCode: e.error === undefined ? undefined : 'INSTALL_FAILED',
    };
  }
}
