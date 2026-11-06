import { AsyncLocalStorage } from 'node:async_hooks';
import type Database from 'better-sqlite3';
import { requireUpgrade } from '../upgrade/upgrade-trust';

export interface UpgradeRecoveryContext {
  instanceId: string;
  recoveryId: string;
  attemptId: string;
  epoch: number;
  mode: 'read' | 'admit' | 'restore' | 'observe' | 'stabilize';
  /** Re-read the independent ledger; never treat the initial admission as a lease. */
  assertGlobal(): void;
}
const contexts = new AsyncLocalStorage<UpgradeRecoveryContext>();
export function currentUpgradeRecovery(): UpgradeRecoveryContext | undefined {
  return contexts.getStore();
}
export function withUpgradeRecovery<T>(context: UpgradeRecoveryContext, work: () => T): T {
  return contexts.run(context, work);
}
/** Resumed ordinary business workers retain their own writer epoch, not a
 * temporary control-request authorization in future timer callbacks. */
export function withoutUpgradeRecovery<T>(work: () => T): T {
  return contexts.exit(work);
}
export const RECOVERY_ADMISSION_ROLE = 'upgrade-control-admission';
export const RECOVERY_ACTION_ROLE = 'upgrade-control-action';
export function recoveryAdmissionId(instanceId: string): string {
  return 'control-admission:' + instanceId;
}
export function assertRecoverySideEffect(): void {
  const context = currentUpgradeRecovery();
  if (!context) return;
  context.assertGlobal();
  requireUpgrade(
    context.mode === 'restore' || context.mode === 'stabilize',
    'RECOVERY_READ_CONTEXT_CANNOT_MUTATE',
  );
}

/** Called inside the same business transaction as each mutation. This local
 * monotonic barrier is distinct from the independent controller lease. */
export function assertRecoveryBusinessAdmission(sqlite: Database.Database): void {
  const context = currentUpgradeRecovery();
  if (!context) return;
  context.assertGlobal();
  requireUpgrade(context.mode !== 'read', 'RECOVERY_READ_CONTEXT_CANNOT_MUTATE');
  if (context.mode === 'admit') return;
  const row = sqlite
    .prepare<unknown[], { fence: number; actor_id: string; request_digest: string }>(
      'SELECT fence,actor_id,request_digest FROM platform_operations WHERE operation_id=? AND instance_id=? AND role=?',
    )
    .get(recoveryAdmissionId(context.instanceId), context.instanceId, RECOVERY_ADMISSION_ROLE);
  requireUpgrade(
    row?.fence === context.epoch &&
      row.actor_id === context.recoveryId &&
      row.request_digest === context.attemptId,
    'RECOVERY_PARTICIPANT_NOT_ADMITTED',
  );
}
