import type { DomainEvent, SandboxId, ProjectId } from '@platform/shared-kernel';
import type { SandboxStatus } from '../value-objects/sandbox-status.vo';

/**
 * Domain events use DOMAIN names, not WS projection names (23 §12): the domain
 * event is the source, the WS frame is a projection (not 1:1).
 * e.g. SandboxStateChanged → WS `sandbox.status_changed`.
 */
export class SandboxCreated implements DomainEvent {
  readonly type = 'SandboxCreated';
  constructor(
    readonly sandboxId: SandboxId,
    readonly projectId: ProjectId,
    readonly occurredAt: Date,
  ) {}
}

export class SandboxStateChanged implements DomainEvent {
  readonly type = 'SandboxStateChanged';
  constructor(
    readonly sandboxId: SandboxId,
    readonly from: SandboxStatus,
    readonly to: SandboxStatus,
    readonly occurredAt: Date,
    /**
     * Set only when `to === 'failed'`: the machine-readable cause, carried on the
     * event so the WS projection can hand the frontend a CODE rather than leaving it
     * to guess. Provisioning is async, so this event is the only LIVE channel a
     * failure has (04 §4) — the same code is persisted for the post-refresh read.
     */
    readonly errorCode?: string,
  ) {}
}
