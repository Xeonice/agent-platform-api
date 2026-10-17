import type { Tx } from '@platform/shared-kernel';

export interface SandboxStopIntent {
  sandboxId: string;
  operationId: string;
  actor: { kind: 'user' | 'automation' | 'system'; id: string };
}
export interface SandboxStopIntents {
  reserveSync(tx: Tx, intent: SandboxStopIntent, at: Date): void;
  finishSync(tx: Tx, operationId: string, at: Date): void;
  pending(): Promise<SandboxStopIntent[]>;
}
export const SANDBOX_STOP_INTENTS = Symbol('SandboxStopIntents');
