import { AsyncLocalStorage } from 'node:async_hooks';
import type Database from 'better-sqlite3';
import { requireUpgrade } from '../upgrade/upgrade-trust';
export interface ContractControlContext {
  instanceId: string;
  contractId: string;
  intentFence: number;
  epoch: number;
  mode: 'admit' | 'execute';
  assertGlobal(): void;
}
const contexts = new AsyncLocalStorage<ContractControlContext>();
export function currentContractControl(): ContractControlContext | undefined {
  return contexts.getStore();
}
export function withContractControl<T>(context: ContractControlContext, work: () => T): T {
  return contexts.run(context, work);
}
export function assertContractBusinessAdmission(sqlite: Database.Database): void {
  const context = contexts.getStore();
  if (!context) return;
  context.assertGlobal();
  if (context.mode === 'admit') return;
  const row = sqlite
    .prepare<unknown[], { fence: number; actor_id: string; request_digest: string }>(
      "SELECT fence,actor_id,request_digest FROM platform_operations WHERE operation_id=? AND instance_id=? AND role='schema-contract-admission'",
    )
    .get('contract-admission:' + context.instanceId, context.instanceId);
  requireUpgrade(
    row?.fence === context.epoch &&
      row.actor_id === context.contractId &&
      row.request_digest === String(context.intentFence),
    'CONTRACT_PARTICIPANT_NOT_ADMITTED',
  );
}
