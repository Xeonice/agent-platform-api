import type { Tx } from '@platform/shared-kernel/pure';

export type SandboxStartupStage =
  | 'workspace-preparation'
  | 'instance-create'
  | 'instance-start'
  | 'runtime-tools'
  | 'environment-initialization'
  | 'agent-bootstrap'
  | 'completed';

/** Public facts only: never provider contexts, native handles or credentials. */
export interface SandboxStartupProgress {
  operationId: string;
  sequence: number;
  state: 'inflight' | 'unknown' | 'succeeded' | 'failed';
  stage: SandboxStartupStage;
  startedAt: string | null;
  stageEnteredAt: string | null;
  lastProgressAt: string | null;
  heartbeatAt: string | null;
}

export interface SandboxStartupProgressStore {
  readSync(sandboxId: string): SandboxStartupProgress | undefined;
  saveSync(tx: Tx, sandboxId: string, progress: SandboxStartupProgress, at: Date): void;
}

export const SANDBOX_STARTUP_PROGRESS = Symbol('SandboxStartupProgressStore');
