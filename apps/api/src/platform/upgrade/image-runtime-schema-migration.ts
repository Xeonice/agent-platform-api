import type Database from 'better-sqlite3';
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { coordinatorWriterControl } from '../persistence/coordinator-lease';
import type { UpgradeStore } from './upgrade-store';
import { canonicalUpgrade, requireUpgrade, upgradeDigest } from './upgrade-trust';
import {
  IMAGE_RUNTIME_SCHEMA_PLAN as plan,
  IMAGE_RUNTIME_SCHEMA_PLAN_DIGEST as planDigest,
} from './image-runtime-schema-plan';
import { sqliteStorageObservation } from './sqlite-storage-budget';

type Json = Record<string, unknown>;
const SQL = "ALTER TABLE `image_manifests` ADD `runtime_versions` text DEFAULT '{}' NOT NULL;";
const RECEIPT = 'global-schema:' + planDigest;
function state(sqlite: Database.Database): 'source' | 'target' | 'invalid' {
  const journal = sqlite
    .prepare('SELECT hash,created_at FROM __drizzle_migrations ORDER BY created_at,id')
    .all();
  const columns = sqlite.prepare('PRAGMA table_xinfo(image_manifests)').all();
  if (
    upgradeDigest(journal) === plan.sourceJournalDigest &&
    upgradeDigest(columns) === plan.sourceColumnsDigest
  )
    return 'source';
  if (
    upgradeDigest(journal) === plan.targetJournalDigest &&
    upgradeDigest(columns) === plan.targetColumnsDigest
  )
    return 'target';
  return 'invalid';
}
/** Presence of a column alone never proves a committed journal or safe bridge. */
export function imageRuntimeSchemaCommitted(sqlite: Database.Database): boolean {
  if (state(sqlite) !== 'target') return false;
  const row = sqlite
    .prepare('SELECT request_digest,result FROM upgrade_migration_operations WHERE operation_id=?')
    .get(RECEIPT) as { request_digest: string; result: string } | undefined;
  if (!row || row.request_digest !== planDigest) return false;
  try {
    const receipt = JSON.parse(row.result) as Json;
    return (
      receipt.planDigest === planDigest &&
      receipt.targetJournalDigest === plan.targetJournalDigest &&
      receipt.migrationHash === plan.migrationHash &&
      receipt.complete === true
    );
  } catch {
    return false;
  }
}
export function imageRuntimeSchemaMetrics(sqlite: Database.Database) {
  const current = state(sqlite);
  const committed = current === 'target' && imageRuntimeSchemaCommitted(sqlite);
  return {
    known: current === 'source' || committed,
    differences: current === 'invalid' || (current === 'target' && !committed) ? 1 : 0,
    oldRepresentationRetained: current === 'source' || committed,
    readEpoch: committed ? 1 : 0,
    degraded: current === 'invalid' || (current === 'target' && !committed),
  };
}
/** Runs on the existing Coordinator writer before any role handoff. The DDL,
 * real Drizzle journal and operation receipt commit together or not at all.
 * Failure after commit preserves the added column and every old representation.
 */
export async function executeImageRuntimeSchemaMigration(
  store: UpgradeStore,
  id: string,
  input: Json,
): Promise<Json> {
  const fence = Number(input.fence);
  store.assertControllerFence(id, fence);
  const snapshot = store.snapshot(id);
  requireUpgrade(
    snapshot.plan.migrationPath.migrationPlanDigest === planDigest &&
      snapshot.plan.migrationPath.targetSchema === 29 &&
      snapshot.plan.migrationPath.minSchema === 28 &&
      snapshot.plan.migrationPath.maxSchema === 29 &&
      input.planDigest === planDigest &&
      typeof input.operationId === 'string' &&
      ['prepare', 'batch', 'status'].includes(String(input.action)),
    'FIXED_GLOBAL_SCHEMA_COMMAND_REQUIRED',
  );
  const sqlite = store.sqlite;
  const result = (): Json => ({
    commitKnown: true,
    checkpoint: { phase: 'complete', planDigest, schema: 29 },
    completedWork: 1,
    complete: true,
    integrityValid: sqlite.pragma('quick_check', { simple: true }) === 'ok',
    budgetExceeded: false,
    metrics: imageRuntimeSchemaMetrics(sqlite),
  });
  if (input.action === 'status') {
    if (imageRuntimeSchemaCommitted(sqlite)) return result();
    requireUpgrade(state(sqlite) === 'source', 'GLOBAL_SCHEMA_BASELINE_CHANGED');
    return { definitelyNotApplied: true };
  }
  requireUpgrade(store.step(id, 'package-verify').applied, 'MIGRATION_PACKAGE_NOT_VERIFIED');
  const root = process.env.UPGRADE_INSTALLER_ROOT;
  requireUpgrade(root, 'INSTALLER_ROOT_REQUIRED');
  const file = join(
    root,
    'artifacts',
    snapshot.plan.package.digest.slice(7),
    'upgrade-migration.json',
  );
  const stat = await lstat(file);
  requireUpgrade(
    stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o022) === 0,
    'INSECURE_MIGRATION_PLAN',
  );
  const actual: unknown = JSON.parse(await readFile(file, 'utf8'));
  requireUpgrade(
    canonicalUpgrade(actual) === canonicalUpgrade(plan) && upgradeDigest(actual) === planDigest,
    'GLOBAL_SCHEMA_RECIPE_CHANGED',
  );
  const migrations = join(root, 'artifacts', snapshot.plan.package.digest.slice(7), 'api/drizzle');
  const journal = JSON.parse(await readFile(join(migrations, 'meta/_journal.json'), 'utf8')) as {
    entries: { tag: string; when: number }[];
  };
  requireUpgrade(
    Array.isArray(journal.entries) &&
      journal.entries.length === 29 &&
      journal.entries[28].tag === plan.migrationTag &&
      journal.entries.every((entry) => /^\d{4}_[a-z0-9_]+$/.test(entry.tag)),
    'GLOBAL_SCHEMA_TARGET_JOURNAL_CHANGED',
  );
  const targetJournal = await Promise.all(
    journal.entries.map(async (entry) => ({
      hash: createHash('sha256')
        .update(await readFile(join(migrations, entry.tag + '.sql')))
        .digest('hex'),
      created_at: entry.when,
    })),
  );
  requireUpgrade(
    upgradeDigest(targetJournal) === plan.targetJournalDigest &&
      createHash('sha256').update(SQL).digest('hex') === plan.migrationHash,
    'GLOBAL_SCHEMA_TARGET_JOURNAL_CHANGED',
  );
  store.assertControllerFence(id, fence);
  if (imageRuntimeSchemaCommitted(sqlite)) return result();
  const policy = snapshot.plan.policy;
  const storage = await sqliteStorageObservation(sqlite);
  requireUpgrade(storage.availableBytes >= policy.minFreeBytes, 'MIGRATION_DISK_BUDGET');
  requireUpgrade(storage.walBytes <= policy.maxWalBytes, 'MIGRATION_WAL_BUDGET');
  const writer = coordinatorWriterControl(sqlite);
  writer.assert();
  const started = performance.now();
  const busy = Number(sqlite.pragma('busy_timeout', { simple: true }));
  sqlite.pragma('busy_timeout = ' + Math.min(busy, policy.migrationBatchMs));
  try {
    sqlite
      .transaction(() => {
        writer.assert();
        store.assertControllerFence(id, fence);
        requireUpgrade(state(sqlite) === 'source', 'GLOBAL_SCHEMA_BASELINE_CHANGED');
        requireUpgrade(
          performance.now() - started <= policy.migrationBatchMs,
          'MIGRATION_BATCH_BUDGET',
        );
        sqlite.exec(SQL);
        sqlite
          .prepare('INSERT INTO __drizzle_migrations(hash,created_at) VALUES(?,?)')
          .run(plan.migrationHash, plan.migrationTimestamp);
        requireUpgrade(state(sqlite) === 'target', 'GLOBAL_SCHEMA_COMMIT_IDENTITY_INVALID');
        requireUpgrade(
          sqlite.pragma('quick_check', { simple: true }) === 'ok' &&
            (sqlite.pragma('foreign_key_check') as unknown[]).length === 0,
          'GLOBAL_SCHEMA_INTEGRITY_FAILED',
        );
        requireUpgrade(
          performance.now() - started <= policy.migrationBatchMs,
          'MIGRATION_BATCH_BUDGET',
        );
        writer.assert();
        store.assertControllerFence(id, fence);
        sqlite
          .prepare(
            'INSERT INTO upgrade_migration_operations(operation_id,request_digest,result) VALUES(?,?,?)',
          )
          .run(
            RECEIPT,
            planDigest,
            canonicalUpgrade({
              planDigest,
              attemptId: id,
              migrationHash: plan.migrationHash,
              targetJournalDigest: plan.targetJournalDigest,
              complete: true,
            }),
          );
      })
      .immediate();
  } finally {
    sqlite.pragma('busy_timeout = ' + busy);
  }
  requireUpgrade(imageRuntimeSchemaCommitted(sqlite), 'GLOBAL_SCHEMA_COMMIT_UNCONFIRMED');
  return result();
}
