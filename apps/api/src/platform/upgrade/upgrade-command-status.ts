import type { UpgradeStore } from './upgrade-store';
import { currentUpgradeRecovery } from '../persistence/upgrade-recovery-context';
import { requireUpgrade } from './upgrade-trust';
import { upgradeRecord } from './upgrade-values';
export function readUpgradeCommandStatus(
  store: UpgradeStore,
  command: {
    attemptId: string;
    commandKind: 'coordinator-handoff' | 'owner-candidate' | 'migration';
    operationId: string;
    expectedRequestDigest?: string;
  },
) {
  const context = currentUpgradeRecovery();
  requireUpgrade(
    context?.attemptId === command.attemptId,
    'RECOVERY_COMMAND_STATUS_SCOPE_REQUIRED',
  );
  store.assertFence(command.attemptId, context.epoch);
  const plan = store.plan(command.attemptId);
  const base = {
    instanceId: store.instanceId,
    attemptId: command.attemptId,
    commandKind: command.commandKind,
    operationId: command.operationId,
  };
  if (command.commandKind === 'migration') {
    const row = store.sqlite
      .prepare<unknown[], { request_digest: string; result: string }>(
        'SELECT request_digest,result FROM upgrade_migration_operations WHERE operation_id=?',
      )
      .get(command.operationId);
    if (!row)
      return {
        ...base,
        planDigest: plan.migrationPath.migrationPlanDigest,
        stage: 'absent',
        state: 'unknown',
      };
    if (command.expectedRequestDigest !== row.request_digest)
      return {
        ...base,
        planDigest: plan.migrationPath.migrationPlanDigest,
        requestDigest: row.request_digest,
        stage: 'journaled',
        state: 'unknown',
      };
    const result = upgradeRecord(JSON.parse(row.result));
    return {
      ...base,
      planDigest: plan.migrationPath.migrationPlanDigest,
      requestDigest: row.request_digest,
      stage: 'journaled',
      state: result.commitKnown === true ? 'applied' : 'unknown',
      result,
    };
  }
  const row =
    command.commandKind === 'coordinator-handoff'
      ? store.sqlite
          .prepare<
            unknown[],
            {
              operation_id: string;
              plan_digest: string;
              stage: string;
              candidate: string;
              evidence: string | null;
            }
          >(
            'SELECT operation_id,plan_digest,stage,candidate,evidence FROM coordinator_handoffs WHERE attempt_id=?',
          )
          .get(command.attemptId)
      : store.sqlite
          .prepare<
            unknown[],
            {
              operation_id: string;
              plan_digest: string;
              stage: string;
              candidate: string;
              evidence: string | null;
            }
          >(
            "SELECT operation_id,plan_digest,stage,candidate,evidence FROM upgrade_role_handoffs WHERE attempt_id=? AND kind='owner'",
          )
          .get(command.attemptId);
  if (!row)
    return {
      ...base,
      planDigest: plan.planDigest,
      stage: 'absent',
      state: command.commandKind === 'coordinator-handoff' ? 'definitely-not-applied' : 'unknown',
      actionsCompleted: [],
    };
  requireUpgrade(
    row.operation_id === command.operationId && row.plan_digest === plan.planDigest,
    'RECOVERY_ORIGINAL_COMMAND_BINDING_MISMATCH',
  );
  const candidate = upgradeRecord(JSON.parse(row.candidate)),
    evidence = row.evidence ? upgradeRecord(JSON.parse(row.evidence)) : null;
  const adopted = row.stage === 'adopted' && evidence !== null;
  // quiesced/releasing/adopting are pre-side-effect markers, not completion receipts.
  return {
    ...base,
    planDigest: row.plan_digest,
    stage: row.stage,
    state: adopted ? 'applied' : 'unknown',
    actionsCompleted: adopted
      ? [
          'prepare',
          ...(command.commandKind === 'coordinator-handoff' ? ['quiesce', 'release'] : []),
          'adopt',
        ]
      : ['prepare'],
    candidate: {
      artifactDigest: candidate.artifactDigest,
      startIdentity: candidate.startIdentity,
      origin: candidate.origin,
      managementOrigin: candidate.managementOrigin,
    },
    ...(evidence ? { result: evidence } : {}),
  };
}
