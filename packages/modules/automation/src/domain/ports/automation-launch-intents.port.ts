import type { Tx } from '@platform/shared-kernel';

/** Immutable reservation, committed with the occurrence before any external work. */
export interface AutomationLaunchIntent {
  runId: string;
  retryCount: number;
  sandboxId: string;
  taskId: string;
  actorId: string;
  /** Frozen non-credential launch input; no runtime/deployment secret. */
  input: string;
  createdAt: Date;
}
export interface AutomationLaunchIntents {
  find(runId: string, retryCount: number): Promise<AutomationLaunchIntent | null>;
  reserveSync(tx: Tx, intent: AutomationLaunchIntent): AutomationLaunchIntent;
  /** CAS the actual cron slot, not a uniqueness constraint on manual run times. */
  reserveOccurrenceSync(tx: Tx, automationId: string, dueAt: Date, runId: string): boolean;
}
export const AUTOMATION_LAUNCH_INTENTS = Symbol('AutomationLaunchIntents');
