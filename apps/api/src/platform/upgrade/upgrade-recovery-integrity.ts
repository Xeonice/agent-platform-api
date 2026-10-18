import type { Clock } from '@platform/shared-kernel';
import type { UpgradeStore } from './upgrade-store';
import { persistedBinding, type UpgradeInspector } from './upgrade-inspector';
import { verifyMigrationDatabaseIntegrity } from './migration-database-integrity';
import { requireUpgrade, UpgradeError, upgradeDigest } from './upgrade-trust';

/** Recovery uses a real uncached read-only scan without blocking HTTP or lease
 * renewal. An awaited scan cannot qualify a different route or controller. */
export async function recoveryIntegrity(
  store: Pick<UpgradeStore, 'sqlite' | 'assertFence'>,
  inspector: Pick<UpgradeInspector, 'entryBinding'>,
  clock: Clock,
  id: string,
  fence: number,
  binding: Record<string, unknown>,
  freshnessMs: number,
): Promise<boolean> {
  store.assertFence(id, fence);
  const started = clock.now().getTime();
  const originalBinding = upgradeDigest(persistedBinding(binding));
  let healthy = true;
  try {
    await verifyMigrationDatabaseIntegrity(store.sqlite);
  } catch (error) {
    if (error instanceof UpgradeError && error.code === 'GLOBAL_SCHEMA_INTEGRITY_FAILED')
      healthy = false;
    else throw error;
  }
  store.assertFence(id, fence);
  const actual = await inspector.entryBinding();
  store.assertFence(id, fence);
  requireUpgrade(
    upgradeDigest(persistedBinding(actual)) === originalBinding,
    'ENTRY_BINDING_CHANGED',
  );
  const elapsed = clock.now().getTime() - started;
  requireUpgrade(elapsed >= 0 && elapsed <= freshnessMs, 'OBSERVATION_STALE');
  return healthy;
}
