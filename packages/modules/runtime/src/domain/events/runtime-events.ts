import type { DomainEvent } from '@platform/shared-kernel';
import type { RuntimeInstallState } from '../entities/runtime-installation.entity';

/**
 * Every `RuntimeInstallation` state move raises one of these (23 §7.5, ✅ Outbox).
 * It is the SOURCE of WS `runtime.install_progress` (23 §12) — the domain event is
 * the source, the WS frame is the projection, and they are not 1:1 by design.
 */
export class RuntimeInstallationStateChanged implements DomainEvent {
  readonly type = 'RuntimeInstallationStateChanged';
  constructor(
    readonly sandboxId: string,
    readonly runtimeId: string,
    readonly status: RuntimeInstallState,
    readonly versionDetected: string | undefined,
    readonly error: string | undefined,
    readonly occurredAt: Date,
  ) {}
}
