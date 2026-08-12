import type { SandboxStatus } from '../value-objects/sandbox-status.vo';

/** Who triggered the transition (13 §2.1.2 CHECK, 5 values). */
export type TriggeredBy = 'scheduler' | 'reaper' | 'user' | 'health-check' | 'provider-event';

/**
 * Append-only history inside the Sandbox aggregate (13 §2.1.2).
 * `from` is null for the very first record.
 */
export interface StateTransition {
  readonly from: SandboxStatus | null;
  readonly to: SandboxStatus;
  readonly at: Date;
  readonly triggeredBy: TriggeredBy;
}
