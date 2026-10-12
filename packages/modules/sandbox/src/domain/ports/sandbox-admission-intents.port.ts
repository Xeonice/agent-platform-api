import type { Tx } from '@platform/shared-kernel';

/** Accepted internal create identity; public clients cannot supply these IDs. */
export interface SandboxAdmissionIntents {
  find(sandboxId: string): Promise<string | null>;
  reserveSync(tx: Tx, sandboxId: string, input: string): void;
}
export const SANDBOX_ADMISSION_INTENTS = Symbol('SandboxAdmissionIntents');
