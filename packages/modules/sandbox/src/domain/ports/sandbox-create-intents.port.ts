import type { Tx } from '@platform/shared-kernel';
export interface SandboxCreateIntent {
  sandboxId: string;
  operationId: string;
  requestDigest: string;
  workspacePath: string;
  state: 'pending' | 'bound';
  createdAt: Date;
}
export interface SandboxCreateIntents {
  reserveSync(
    tx: Tx,
    sandboxId: string,
    operationId: string,
    opaqueInput: Readonly<object>,
    workspacePath: string,
    at: Date,
  ): SandboxCreateIntent;
  completeSync(tx: Tx, sandboxId: string): void;
  finishSync(tx: Tx, sandboxId: string): void;
  pending(): Promise<SandboxCreateIntent[]>;
}
export const SANDBOX_CREATE_INTENTS = Symbol('SandboxCreateIntents');
