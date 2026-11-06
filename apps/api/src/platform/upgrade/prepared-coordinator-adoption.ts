import { fromEpochMs, type Clock } from '@platform/shared-kernel';
import type { RuntimeOwnerProviderRegistry } from '@platform/sandbox';
import type { HandoffRow } from './coordinator-handoff';
import type { UpgradeStore } from './upgrade-store';
import type { CoordinatorHandoffBudget } from './coordinator-handoff-budget';
import { requireUpgrade } from './upgrade-trust';
import { writeInstalledBinding } from './upgrade-atomic-file';
import { withoutBusinessAction } from './upgrade-business-action';
import {
  coordinatorWriterControl,
  withCoordinatorBusinessEpoch,
} from '../persistence/coordinator-lease';

/** Critical section only. Task recovery/quota work is started by the role root
 * after this original adoption commits. No callback may publish after expiry. */
export async function completePreparedCoordinatorAdoption(p: {
  store: UpgradeStore;
  row: HandoffRow;
  fence: number;
  generation: number;
  clock: Clock;
  budget: CoordinatorHandoffBudget;
  owners: Pick<RuntimeOwnerProviderRegistry, 'activateBusinessAuthority'>;
  initialize(): Promise<void>;
  seal(): void;
  continuity(): Promise<Record<string, unknown>>;
  assertAuthority(): void;
  transportReady(): boolean;
  binding: { path: string; origin: string; artifactDigest: string | null };
}): Promise<Record<string, unknown>> {
  return withCoordinatorBusinessEpoch(p.store.sqlite, async () => {
    const writer = coordinatorWriterControl(p.store.sqlite);
    requireUpgrade(writer.generation === p.generation, 'HANDOFF_WRITER_EPOCH_CHANGED');
    const writerFence = writer.fence;
    const plan = p.store.snapshot(p.row.attempt_id).plan;
    requireUpgrade(
      Number.isSafeInteger(p.row.quiesced_at) &&
        p.row.plan_digest === plan.planDigest &&
        p.budget.deadline === Number(p.row.quiesced_at) + plan.policy.requestDeadlineMs,
      'ORIGINAL_HANDOFF_DEADLINE_REQUIRED',
    );
    const check = () => {
      p.budget.assert();
      p.assertAuthority();
      requireUpgrade(
        writer.generation === p.generation && writer.fence === writerFence,
        'HANDOFF_WRITER_EPOCH_CHANGED',
      );
      p.store.assertFence(p.row.attempt_id, p.fence);
      requireUpgrade(p.transportReady(), 'PREPARED_HTTP_LISTENER_CLOSED');
    };
    check();
    await p.budget.step(() =>
      withoutBusinessAction(() =>
        p.owners.activateBusinessAuthority(p.generation, p.budget.signal),
      ),
    );
    check();
    await p.budget.step(() => p.initialize());
    check();
    p.seal();
    check();
    const continuity = await p.budget.step(() => p.continuity());
    check();
    requireUpgrade(continuity.qualified === true, 'HANDOFF_CONTINUITY_UNCONFIRMED');
    await p.budget.step(() =>
      writeInstalledBinding(
        p.binding.path,
        {
          state: 'ready',
          instanceId: p.store.instanceId,
          origin: p.binding.origin,
          generation: p.generation,
          artifactDigest: p.binding.artifactDigest,
        },
        check,
      ),
    );
    check();
    const activatedAt = p.clock.now().getTime();
    const evidence = {
      qualified: true,
      commitKnown: true,
      singleWriter: true,
      maxControlPauseMs: activatedAt - Number(p.row.quiesced_at),
      originalResourcesPreserved: true,
      instanceId: p.store.instanceId,
      attemptId: p.row.attempt_id,
      artifactDigest: p.binding.artifactDigest,
      generation: p.generation,
      observedAt: fromEpochMs(activatedAt).toISOString(),
    };
    check();
    const committed = p.store.sqlite
      .prepare(
        "UPDATE coordinator_handoffs SET stage='adopted',activated_at=?,evidence=? WHERE attempt_id=? AND stage='adopting'",
      )
      .run(activatedAt, JSON.stringify(evidence), p.row.attempt_id);
    requireUpgrade(committed.changes === 1, 'HANDOFF_STAGE_CONFLICT');
    check();
    return evidence;
  });
}
