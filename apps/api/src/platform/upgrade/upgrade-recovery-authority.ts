import type Database from 'better-sqlite3';
import { fromEpochMs, type Clock } from '@platform/shared-kernel';
import type { UpgradeRecovery } from '@platform/contracts';
import type { Request } from 'express';
import { z } from 'zod';
import { requireUpgrade, upgradeDigest } from './upgrade-trust';
import { upgradeRecord } from './upgrade-values';
import {
  currentUpgradeRecovery,
  withUpgradeRecovery,
  type UpgradeRecoveryContext,
} from '../persistence/upgrade-recovery-context';

const Header = z
  .object({
    id: z.string().uuid(),
    epoch: z
      .string()
      .regex(/^[1-9][0-9]{0,15}$/)
      .transform(Number)
      .pipe(z.number().int().positive().safe()),
  })
  .strict();
export interface ControlRecoveryRow {
  recovery_id: string;
  instance_id: string;
  triggering_attempt_id: string;
  triggering_operation_id: string | null;
  authorization_plan: string;
  authorization_digest: string;
  plan: string | null;
  plan_digest: string | null;
  phase: 'created' | 'reconciling' | 'restoring' | 'verifying' | 'recovered' | 'blocked';
  epoch: number;
  sequence: number;
  reason: string;
  deadline: number;
  updated_at: number;
  confirmed_at: number | null;
  diagnostic_id: string | null;
}
export function readRecoveryAuthority(
  sqlite: Database.Database,
  instanceId: string,
  clock: Clock,
  recoveryId: string,
  epoch: number,
  attemptId: string,
) {
  const row = sqlite
    .prepare<unknown[], ControlRecoveryRow>(
      'SELECT * FROM control_recovery_intents WHERE recovery_id=? AND instance_id=?',
    )
    .get(recoveryId, instanceId);
  const authority = sqlite
    .prepare<
      unknown[],
      {
        epoch: number;
        operation_id: string;
        kind: string;
        mode: string;
        holder_id: string | null;
        lease_expires_at: number;
      }
    >(
      'SELECT epoch,operation_id,kind,mode,holder_id,lease_expires_at FROM control_authority WHERE instance_id=?',
    )
    .get(instanceId);
  requireUpgrade(
    row &&
      authority &&
      row.triggering_attempt_id === attemptId &&
      row.epoch === epoch &&
      authority.epoch === epoch &&
      authority.operation_id === recoveryId &&
      authority.kind === 'recovery' &&
      authority.mode === 'active' &&
      authority.holder_id &&
      authority.lease_expires_at > clock.now().getTime() &&
      row.deadline > clock.now().getTime() &&
      !['recovered', 'blocked'].includes(row.phase),
    'RECOVERY_AUTHORITY_EXPIRED_OR_SUPERSEDED',
  );
  const plan = row.plan === null ? null : upgradeRecord(JSON.parse(row.plan));
  const authorization = upgradeRecord(JSON.parse(row.authorization_plan));
  const { planDigest: _digest, ...spec } = plan ?? {};
  requireUpgrade(
    upgradeDigest(authorization) === row.authorization_digest &&
      (plan === null
        ? row.plan_digest === null
        : plan.planDigest === row.plan_digest &&
          upgradeDigest(spec) === row.plan_digest &&
          plan.triggeringAttemptId === attemptId),
    'CONTROL_RECOVERY_JOURNAL_CORRUPT',
  );
  return { row, authority, plan, authorization };
}
export function recoveryView(row: ControlRecoveryRow): UpgradeRecovery {
  return {
    recoveryAttemptId: row.recovery_id,
    triggeringAttemptId: row.triggering_attempt_id,
    generation: row.epoch,
    sequence: row.sequence,
    state:
      row.phase === 'recovered'
        ? 'recovery-confirmed'
        : row.phase === 'blocked'
          ? 'failed'
          : 'recovering',
    // Public recovery scope is immutable from intent creation. The separately
    // qualified executable plan is read through recoveryPlan(), never substituted.
    planDigest: row.authorization_digest,
    reason: row.reason,
    observedAt: fromEpochMs(row.updated_at).toISOString(),
    phase: row.phase,
    confirmedAt: row.confirmed_at === null ? null : fromEpochMs(row.confirmed_at).toISOString(),
    ...(row.triggering_operation_id ? { triggeringOperationId: row.triggering_operation_id } : {}),
    ...(row.diagnostic_id ? { diagnosticId: row.diagnostic_id } : {}),
  };
}
export function recoveryHeaders(): Record<string, string> {
  const context = currentUpgradeRecovery();
  return context
    ? {
        'x-platform-recovery-id': context.recoveryId,
        'x-platform-recovery-epoch': String(context.epoch),
      }
    : {};
}
/** Caller has already verified the existing private role key and instance. */
export function withRecoveryRequest<T>(
  input: {
    req: Pick<Request, 'headers'>;
    sqlite: Database.Database;
    instanceId: string;
    clock: Clock;
    readonlyLedger: boolean;
    attemptId: string | undefined;
    mode: UpgradeRecoveryContext['mode'];
  },
  work: () => T,
): T {
  const id = input.req.headers['x-platform-recovery-id'],
    canonicalEpoch = input.req.headers['x-platform-recovery-epoch'],
    compatibilityEpoch = input.req.headers['x-platform-control-epoch'];
  if (id === undefined && canonicalEpoch === undefined && compatibilityEpoch === undefined)
    return work();
  requireUpgrade(
    canonicalEpoch === undefined ||
      compatibilityEpoch === undefined ||
      (typeof canonicalEpoch === 'string' && canonicalEpoch === compatibilityEpoch),
    'RECOVERY_EPOCH_HEADER_CONFLICT',
  );
  const epoch = canonicalEpoch ?? compatibilityEpoch;
  requireUpgrade(input.readonlyLedger, 'RECOVERY_AUTHORITY_MODE_UNSUPPORTED');
  const parsed = Header.safeParse({ id, epoch });
  requireUpgrade(parsed.success, 'INVALID_RECOVERY_AUTHORITY_HEADERS', 400);
  const headers = parsed.data;
  const original = input.sqlite
    .prepare<unknown[], { triggering_attempt_id: string }>(
      'SELECT triggering_attempt_id FROM control_recovery_intents WHERE recovery_id=? AND instance_id=?',
    )
    .get(headers.id, input.instanceId);
  requireUpgrade(original, 'CONTROL_RECOVERY_INTENT_REQUIRED');
  const attemptId = input.attemptId ?? original.triggering_attempt_id;
  const assertGlobal = () => {
    const current = readRecoveryAuthority(
      input.sqlite,
      input.instanceId,
      input.clock,
      headers.id,
      headers.epoch,
      attemptId,
    );
    if (input.mode === 'admit')
      requireUpgrade(
        ['reconciling', 'restoring', 'verifying'].includes(current.row.phase),
        'CONTROL_RECOVERY_ADMISSION_PHASE_INVALID',
      );
    else if (input.mode === 'stabilize')
      requireUpgrade(
        current.row.phase === 'reconciling' &&
          upgradeRecord(JSON.parse(current.row.authorization_plan)).stabilizeCurrentWriter === true,
        'CONTROL_RECOVERY_STABILIZATION_NOT_AUTHORIZED',
      );
    else if (input.mode !== 'read')
      requireUpgrade(
        (input.mode === 'observe'
          ? ['restoring', 'verifying'].includes(current.row.phase)
          : current.row.phase === 'restoring') && current.plan !== null,
        'CONTROL_RECOVERY_FIXED_PLAN_REQUIRED',
      );
  };
  assertGlobal();
  return withUpgradeRecovery(
    {
      instanceId: input.instanceId,
      recoveryId: headers.id,
      epoch: headers.epoch,
      attemptId,
      mode: input.mode,
      assertGlobal,
    },
    work,
  );
}
export function rejectRecoveryHeaders(req: Pick<Request, 'headers'>): void {
  requireUpgrade(
    req.headers['x-platform-recovery-id'] === undefined &&
      req.headers['x-platform-recovery-epoch'] === undefined,
    'RECOVERY_RPC_NOT_ALLOWED',
  );
}
