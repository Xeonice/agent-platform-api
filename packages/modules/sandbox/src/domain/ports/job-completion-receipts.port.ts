import type { Tx } from '@platform/shared-kernel/pure';

/** Actual guest exit observation, with no output, command, credentials or runtime token. */
export interface JobCompletionObservation {
  taskId: string;
  sandboxId: string;
  jobHandle: { provider: string; jobId: string };
  cursor: string | null;
  lastSeq: number;
  exitCode: number | null;
  exitKind: 'natural' | 'timeout' | 'cancelled';
  observedAt: Date;
}

/** Survives release of the guest's output/exit receipt. */
export interface JobCompletionReceipt {
  taskId: string;
  sandboxId: string;
  provider: string;
  jobHandleDigest: string;
  cursor: string | null;
  lastSeq: number;
  exitCode: number | null;
  exitKind: JobCompletionObservation['exitKind'];
  observedAt: Date;
  evidenceDigest: string;
}

export interface JobCompletionReceipts {
  /** Called only after readJob returned exited, in the terminal task/event transaction. */
  saveObservedSync(tx: Tx, observation: JobCompletionObservation): JobCompletionReceipt;
  find(taskId: string): Promise<JobCompletionReceipt | null>;
}

export const JOB_COMPLETION_RECEIPTS = Symbol('JobCompletionReceipts');
