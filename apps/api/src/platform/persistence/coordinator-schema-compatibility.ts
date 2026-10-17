import type Database from 'better-sqlite3';
import { imageRuntimeSchemaCommitted } from '../upgrade/image-runtime-schema-migration';
import { requireUpgrade } from '../upgrade/upgrade-trust';

/** A schema-28 bridge may reopen the one proven additive schema. It must never
 * migrate backwards or accept a future journal merely because old columns exist.
 */
export function assertCoordinatorMigrationCompatibility(
  sqlite: Database.Database,
  localMigrationCount: number,
  allowEmpty = false,
): void {
  const journal = sqlite
    .prepare("SELECT 1 FROM sqlite_master WHERE name='__drizzle_migrations'")
    .get();
  requireUpgrade(journal || allowEmpty, 'ONLINE_MIGRATION_REQUIRED');
  if (!journal) return;
  const applied = (
    sqlite.prepare('SELECT count(*) n FROM __drizzle_migrations').get() as { n: number }
  ).n;
  requireUpgrade(
    (allowEmpty && applied === 0) ||
      applied === localMigrationCount ||
      (localMigrationCount === 28 && applied === 29 && imageRuntimeSchemaCommitted(sqlite)),
    'ONLINE_MIGRATION_REQUIRED',
  );
}
