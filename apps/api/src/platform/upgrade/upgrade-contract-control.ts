import type { Clock } from '@platform/shared-kernel';
import type { Request } from 'express';
import type { UpgradeContractStore } from './upgrade-contract-store';
import { withContractControl } from '../persistence/upgrade-contract-context';
import { requireUpgrade } from './upgrade-trust';
import { z } from 'zod';
const Headers = z
  .object({
    id: z.string().uuid(),
    epoch: z
      .string()
      .regex(/^[1-9][0-9]{0,15}$/)
      .transform(Number)
      .pipe(z.number().positive().int().safe()),
  })
  .strict();
/** Contract intent fence and replaceable execution epoch are separate values. */
export function withContractRequest<T>(
  req: Pick<Request, 'headers'>,
  store: UpgradeContractStore,
  clock: Clock,
  contractId: string,
  work: () => T,
): T {
  const id = req.headers['x-platform-contract-id'],
    epoch = req.headers['x-platform-control-epoch'];
  if (!store.upgrades.ledgerReadonly) {
    requireUpgrade(id === undefined && epoch === undefined, 'CONTRACT_CONTROL_MODE_UNSUPPORTED');
    return work();
  }
  const parsed = Headers.safeParse({ id, epoch });
  requireUpgrade(parsed.success, 'INVALID_CONTRACT_AUTHORITY_HEADERS', 400);
  const headers = parsed.data;
  requireUpgrade(headers.id === contractId, 'CONTRACT_CONTROL_SCOPE_MISMATCH');
  const record = store.snapshot(contractId),
    sqlite = store.ledgerSqlite;
  const assertGlobal = () => {
    const current = sqlite
      .prepare<
        unknown[],
        {
          epoch: number;
          operation_id: string;
          kind: string;
          mode: string;
          holder_id: string;
          lease_expires_at: number;
        }
      >(
        'SELECT epoch,operation_id,kind,mode,holder_id,lease_expires_at FROM control_authority WHERE instance_id=?',
      )
      .get(store.upgrades.instanceId);
    const binding = sqlite
      .prepare<
        unknown[],
        { instance_id: string; intent_fence: number; epoch: number; executor_id: string }
      >(
        'SELECT instance_id,intent_fence,epoch,executor_id FROM control_contract_authority WHERE contract_attempt_id=?',
      )
      .get(contractId);
    requireUpgrade(
      current?.kind === 'contract' &&
        current.mode === 'active' &&
        current.operation_id === contractId &&
        current.epoch === headers.epoch &&
        current.lease_expires_at > clock.now().getTime() &&
        binding?.instance_id === store.upgrades.instanceId &&
        binding.epoch === headers.epoch &&
        binding.executor_id === current.holder_id &&
        binding.intent_fence === record.fence,
      'CONTRACT_CONTROL_AUTHORITY_EXPIRED_OR_SUPERSEDED',
    );
  };
  assertGlobal();
  return withContractControl(
    {
      instanceId: store.upgrades.instanceId,
      contractId,
      intentFence: record.fence,
      epoch: headers.epoch,
      mode: 'admit',
      assertGlobal,
    },
    work,
  );
}
