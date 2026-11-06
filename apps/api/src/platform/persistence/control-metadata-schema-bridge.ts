import type { Clock } from '@platform/shared-kernel';
import { z } from 'zod';
import Database from 'better-sqlite3';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { lstatSync, realpathSync, statSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve, join } from 'node:path';
import { requireUpgrade, upgradeDigest } from '../upgrade/upgrade-trust';

export const CONTROL_METADATA_MIGRATION = Object.freeze({
  businessSchema: 29,
  compiledSchema: 30,
  migrationTag: '0029_upgrade_control_fast_path',
  migrationHash: '6e284064142a808294b96e600f8e30812b62da6229e50fbac42f3760c1a882ce',
  sourceJournalDigest: 'sha256:b945ce667de71cd53b3f1dcda9ff4b8c667613986ba95c9940a7cbdfe0f3a3df',
});
export interface ControlBusinessBinding {
  instance_id: string;
  source_schema: number;
  source_journal_digest: string;
  external_migration_hash: string;
  business_dev: string;
  business_ino: string;
  source_coordinator_digest: string;
  source_coordinator_generation: number;
  /** Schema separation was approved; this is NOT controller activation authority. */
  state: 'active';
}
const BINDING_SQL = `CREATE TABLE IF NOT EXISTS control_business_binding (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),instance_id TEXT NOT NULL,
  source_schema INTEGER NOT NULL,source_journal_digest TEXT NOT NULL,external_migration_hash TEXT NOT NULL,
  business_dev TEXT NOT NULL,business_ino TEXT NOT NULL,source_coordinator_digest TEXT NOT NULL,
  source_coordinator_generation INTEGER NOT NULL,state TEXT NOT NULL CHECK(state='active'))`;

function businessIdentity(sqlite: Database.Database) {
  const path = sqlite.name;
  requireUpgrade(
    isAbsolute(path) && resolve(path) === path && realpathSync(path) === path,
    'CONTROL_BRIDGE_BUSINESS_IDENTITY_UNKNOWN',
  );
  const stat = statSync(path);
  requireUpgrade(stat.isFile(), 'CONTROL_BRIDGE_BUSINESS_IDENTITY_UNKNOWN');
  return { business_dev: String(stat.dev), business_ino: String(stat.ino) };
}
function verifySourceJournal(sqlite: Database.Database, migrationsFolder: string) {
  const metadata = z
    .object({ entries: z.array(z.object({ tag: z.string(), when: z.number() })) })
    .parse(JSON.parse(readFileSync(join(migrationsFolder, 'meta/_journal.json'), 'utf8')));
  requireUpgrade(
    metadata.entries.length === 30 &&
      metadata.entries[29].tag === CONTROL_METADATA_MIGRATION.migrationTag &&
      metadata.entries[29].when === 1792454400000,
    'CONTROL_METADATA_MIGRATION_UNREVIEWED',
  );
  const migrations = readMigrationFiles({ migrationsFolder });
  requireUpgrade(
    migrations.length === CONTROL_METADATA_MIGRATION.compiledSchema &&
      migrations[29].hash === CONTROL_METADATA_MIGRATION.migrationHash,
    'CONTROL_METADATA_MIGRATION_UNREVIEWED',
  );
  const journal = sqlite
    .prepare<unknown[], { hash: string; created_at: number }>(
      'SELECT hash,created_at FROM __drizzle_migrations ORDER BY created_at,id',
    )
    .all();
  requireUpgrade(
    journal.length === 29 &&
      upgradeDigest(journal) === CONTROL_METADATA_MIGRATION.sourceJournalDigest &&
      journal.every(
        (entry, index) =>
          entry.hash === migrations[index].hash &&
          entry.created_at === migrations[index].folderMillis,
      ),
    'CONTROL_BRIDGE_SOURCE_SCHEMA_UNQUALIFIED',
  );
  return journal;
}

/** Privileged migration worker supplies a readonly business handle and a separately
 * verified real source identity. The long-lived Control Agent never mounts this DB. */
export function observeControlMetadataSource(input: {
  businessSqlite: Database.Database;
  instanceId: string;
  migrationsFolder: string;
  clock: Clock;
  sourceCoordinator: {
    instanceId: string;
    artifactDigest: string;
    generation: number;
    writerFenceValid: true;
    observedAt: string;
  };
}): ControlBusinessBinding {
  verifySourceJournal(input.businessSqlite, input.migrationsFolder);
  const identity = businessIdentity(input.businessSqlite),
    source = input.sourceCoordinator;
  const writer = input.businessSqlite
    .prepare<unknown[], { instance_id: string; generation: number; expires_at: number }>(
      "SELECT instance_id,generation,expires_at FROM platform_role_leases WHERE role='state-coordinator'",
    )
    .get();
  requireUpgrade(
    source.instanceId === input.instanceId &&
      /^sha256:[a-f0-9]{64}$/.test(source.artifactDigest) &&
      z.literal(true).safeParse(source.writerFenceValid).success &&
      writer?.instance_id === input.instanceId &&
      writer.generation === source.generation &&
      writer.expires_at > input.clock.now().getTime() &&
      input.clock.now().getTime() - Date.parse(source.observedAt) >= 0 &&
      input.clock.now().getTime() - Date.parse(source.observedAt) <= 5000 &&
      Number.isSafeInteger(source.generation) &&
      source.generation > 0,
    'CONTROL_BRIDGE_SOURCE_IDENTITY_UNQUALIFIED',
  );
  return {
    instance_id: input.instanceId,
    source_schema: 29,
    source_journal_digest: CONTROL_METADATA_MIGRATION.sourceJournalDigest,
    external_migration_hash: CONTROL_METADATA_MIGRATION.migrationHash,
    ...identity,
    source_coordinator_digest: source.artifactDigest,
    source_coordinator_generation: source.generation,
    state: 'active',
  };
}

/** Writes only the independent control DB. Idempotent exact binding; no business DDL. */
export function bindControlMetadataSource(
  controlSqlite: Database.Database,
  binding: ControlBusinessBinding,
): void {
  controlSqlite
    .transaction(() => {
      const metadata = controlSqlite
        .prepare<unknown[], { instance_id: string; schema_version: number }>(
          'SELECT instance_id,schema_version FROM control_store_metadata WHERE singleton=1',
        )
        .get();
      requireUpgrade(
        metadata?.instance_id === binding.instance_id && metadata.schema_version === 1,
        'CONTROL_SCHEMA_OR_INSTANCE_MISMATCH',
      );
      requireUpgrade(
        z.literal('active').safeParse(binding.state).success &&
          binding.source_schema === 29 &&
          binding.source_journal_digest === CONTROL_METADATA_MIGRATION.sourceJournalDigest &&
          binding.external_migration_hash === CONTROL_METADATA_MIGRATION.migrationHash &&
          /^\d+$/.test(binding.business_dev) &&
          /^\d+$/.test(binding.business_ino) &&
          /^sha256:[a-f0-9]{64}$/.test(binding.source_coordinator_digest) &&
          Number.isSafeInteger(binding.source_coordinator_generation) &&
          binding.source_coordinator_generation > 0,
        'CONTROL_BRIDGE_BINDING_INVALID',
      );
      controlSqlite.exec(BINDING_SQL);
      const prior = controlSqlite
        .prepare<unknown[], ControlBusinessBinding>(
          'SELECT instance_id,source_schema,source_journal_digest,external_migration_hash,business_dev,business_ino,source_coordinator_digest,source_coordinator_generation,state FROM control_business_binding WHERE singleton=1',
        )
        .get();
      if (prior) {
        requireUpgrade(
          upgradeDigest(prior) === upgradeDigest(binding),
          'CONTROL_BRIDGE_BINDING_CONFLICT',
        );
        return;
      }
      controlSqlite
        .prepare('INSERT INTO control_business_binding VALUES(1,?,?,?,?,?,?,?,?,?)')
        .run(
          binding.instance_id,
          binding.source_schema,
          binding.source_journal_digest,
          binding.external_migration_hash,
          binding.business_dev,
          binding.business_ino,
          binding.source_coordinator_digest,
          binding.source_coordinator_generation,
          binding.state,
        );
    })
    .immediate();
}

/** Explicit, narrowly reviewed business-29/compiled-30 bridge. An environment
 * variable alone, a future migration, another DB inode or an unknown journal fails. */
export function assertControlMetadataBusinessCompatibility(
  businessSqlite: Database.Database,
  migrationsFolder: string,
  instanceId: string,
): void {
  const path = process.env.UPGRADE_CONTROL_DATABASE_PATH;
  requireUpgrade(
    path && isAbsolute(path) && resolve(path) === path,
    'CONTROL_BRIDGE_BINDING_REQUIRED',
  );
  const stat = lstatSync(path);
  requireUpgrade(
    stat.isFile() &&
      !stat.isSymbolicLink() &&
      (stat.mode & 0o077) === 0 &&
      realpathSync(path) === path &&
      (!process.getuid || stat.uid === process.getuid() || stat.uid === 0),
    'CONTROL_LEDGER_INSECURE',
  );
  verifySourceJournal(businessSqlite, migrationsFolder);
  const ledger = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const metadata = ledger
      .prepare<unknown[], { instance_id: string; schema_version: number }>(
        'SELECT instance_id,schema_version FROM control_store_metadata WHERE singleton=1',
      )
      .get();
    requireUpgrade(
      ledger
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='control_business_binding'",
        )
        .get(),
      'CONTROL_BRIDGE_BINDING_REQUIRED',
    );
    const binding = ledger
      .prepare<unknown[], ControlBusinessBinding>(
        'SELECT * FROM control_business_binding WHERE singleton=1',
      )
      .get();
    const identity = businessIdentity(businessSqlite);
    const writer = businessSqlite
      .prepare<unknown[], { instance_id: string; generation: number }>(
        "SELECT instance_id,generation FROM platform_role_leases WHERE role='state-coordinator'",
      )
      .get();
    requireUpgrade(
      metadata?.instance_id === instanceId &&
        metadata.schema_version === 1 &&
        binding?.instance_id === instanceId &&
        z.literal('active').safeParse(binding.state).success &&
        binding.source_schema === 29 &&
        binding.source_journal_digest === CONTROL_METADATA_MIGRATION.sourceJournalDigest &&
        binding.external_migration_hash === CONTROL_METADATA_MIGRATION.migrationHash &&
        binding.business_dev === identity.business_dev &&
        binding.business_ino === identity.business_ino &&
        /^sha256:[a-f0-9]{64}$/.test(binding.source_coordinator_digest) &&
        writer?.instance_id === instanceId &&
        writer.generation >= binding.source_coordinator_generation,
      'CONTROL_BRIDGE_BINDING_UNQUALIFIED',
    );
  } finally {
    ledger.close();
  }
}
