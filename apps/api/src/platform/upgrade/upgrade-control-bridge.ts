import type Database from 'better-sqlite3';
import type { UpgradeAttempt } from '@platform/contracts';

export const UPGRADE_STORE_OPTIONS = Symbol('UpgradeStoreOptions');
export const UPGRADE_CONTROL_CAPABILITIES = Object.freeze({
  controlFastPath: 1 as const,
  progressEvidenceReference: 1 as const,
});

export interface UpgradeStoreOptions {
  instanceId?: string;
  /** The externally visible sqlite handle remains the business connection. */
  ledgerSqlite?: Database.Database;
  readonly?: boolean;
  independent?: boolean;
  /** Live business compatibility is supplied by the restricted semantic boundary. */
  dataFormatGuard?: (input: {
    targetDigest: string;
    coordinatorDataFormats: readonly string[];
  }) => void;
  /** Return a known critical handoff, null for proven safe, or throw on unknown. */
  claimGuard?: (input: {
    attemptId: string;
    controllerId: string;
    fence: number;
    leaseExpiresAt: number;
    now: number;
  }) => { stage: string } | null;
}

export interface UpgradeControlReceipt {
  instanceId: string;
  attemptId: string;
  targetDigest: string;
  planDigest: string;
  generation: number;
  sequence: number;
  state: UpgradeAttempt['state'];
  stage: string;
  fence: number;
  controllerId: string | null;
  leaseExpiresAt: number;
}

export interface UpgradeCheckpoint extends UpgradeControlReceipt {
  step: {
    stepId: string;
    completedWork: number;
    applied: boolean;
    receiptDigest: string | null;
    /** null means the legacy writer has not persisted a digest: fetch full once. */
    evidenceDigest: string | null;
  } | null;
}

export interface UpgradeCommitReceipt extends UpgradeControlReceipt {
  eventId: string;
  eventDigest: string;
  eventSequence: number;
}
