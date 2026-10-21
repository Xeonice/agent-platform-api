import type { Clock } from '@platform/shared-kernel';
import { z } from 'zod';
import type { UpgradeStore } from './upgrade-store';
import { loopbackOrigin } from './upgrade-inspection-boundary';
import { requireUpgrade } from './upgrade-trust';

const Receipt = z.object({
  instanceId: z.string(),
  attemptId: z.string(),
  fence: z.number().int().positive(),
  generation: z.number().int().positive(),
  phase: z.enum(['quiesce', 'release', 'adopt']),
  leaseExpiresAt: z.number(),
});
/** A business writer cannot extend the independent controller's ledger directly. */
export async function preserveUpgradeCriticalAuthority(
  store: UpgradeStore,
  clock: Clock,
  id: string,
  fence: number,
  phase: 'quiesce' | 'release' | 'adopt',
  remainingMs = 2000,
): Promise<void> {
  if (!store.ledgerReadonly) {
    if (phase === 'quiesce') store.preserveCriticalAuthority(id, fence);
    return;
  }
  requireUpgrade(
    Number.isFinite(remainingMs) && remainingMs > 0,
    'HANDOFF_CONTROL_BUDGET_EXCEEDED',
  );
  const current = store.authorityCheck(id, fence),
    key = process.env.PLATFORM_CONTROLLER_RPC_KEY ?? '';
  requireUpgrade(key.length >= 32, 'CONTROL_AUTHORITY_RPC_REQUIRED');
  const response = await fetch(
    loopbackOrigin(process.env.UPGRADE_CONTROL_ORIGIN) +
      '/internal/upgrades/' +
      encodeURIComponent(id) +
      '/critical-authority',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-platform-internal-key': key,
        'x-platform-instance-id': store.instanceId,
      },
      body: JSON.stringify({ fence, generation: current.generation, phase }),
      signal: AbortSignal.timeout(Math.max(1, Math.floor(Math.min(2000, remainingMs)))),
    },
  );
  requireUpgrade(response.ok, 'CONTROL_CRITICAL_AUTHORITY_UNCONFIRMED');
  const text = await response.text();
  requireUpgrade(Buffer.byteLength(text) <= 4096, 'CONTROL_AUTHORITY_RECEIPT_TOO_LARGE');
  const receipt = Receipt.parse(JSON.parse(text));
  requireUpgrade(
    receipt.instanceId === store.instanceId &&
      receipt.attemptId === id &&
      receipt.fence === fence &&
      receipt.generation === current.generation &&
      receipt.phase === phase &&
      receipt.leaseExpiresAt > clock.now().getTime(),
    'CONTROL_CRITICAL_AUTHORITY_UNCONFIRMED',
  );
  store.authorityCheck(id, fence, current.generation);
}
