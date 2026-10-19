import Database from 'better-sqlite3';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { open, lstat, realpath, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { z } from 'zod';
import { type Clock, type IdGenerator, verifyInstalledArtifactTree } from '@platform/shared-kernel';
import { requireUpgrade, upgradeDigest } from '../upgrade/upgrade-trust';
import { createUpgradeControlStores } from '../upgrade/control-store-factory';
import {
  CONTROL_METADATA_MIGRATION,
  observeControlMetadataSource,
  bindControlMetadataSource,
} from './control-metadata-schema-bridge';
import { coordinatorWriterControl, fenceCoordinatorConnection } from './coordinator-lease';

export interface ColdBusinessBootstrapInput {
  instanceId: string;
  businessPath: string;
  controlPath: string;
  migrationsFolder: string;
  coordinatorArtifactRoot: string;
  deadline: number;
}
const bundleSchema = z.object({
  components: z.object({
    coordinator: z.object({ artifactDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/) }),
  }),
  files: z.array(z.record(z.unknown())),
});
const journalSchema = z.object({
  entries: z.array(z.object({ tag: z.string(), when: z.number().int() })),
});
function below(root: string, path: string) {
  const rel = relative(root, path);
  return rel !== '' && !isAbsolute(rel) && rel !== '..' && !rel.startsWith('../');
}
async function freshPrivateFile(path: string) {
  requireUpgrade(
    isAbsolute(path) && resolve(path) === path,
    'COLD_BOOTSTRAP_ABSOLUTE_PATH_REQUIRED',
  );
  const directory = dirname(path),
    stat = await lstat(directory);
  requireUpgrade(
    stat.isDirectory() &&
      !stat.isSymbolicLink() &&
      (await realpath(directory)) === directory &&
      (stat.mode & 0o077) === 0 &&
      (!process.getuid || stat.uid === process.getuid()),
    'COLD_BOOTSTRAP_DIRECTORY_INSECURE',
  );
  for (const suffix of ['-wal', '-shm', '-journal']) {
    const present = await lstat(path + suffix).catch((error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
      throw error;
    });
    requireUpgrade(present === null, 'COLD_BOOTSTRAP_EXISTING_DATABASE_FORBIDDEN');
  }
  try {
    const file = await open(path, 'wx', 0o600);
    await file.sync();
    await file.close();
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST')
      requireUpgrade(false, 'COLD_BOOTSTRAP_EXISTING_DATABASE_FORBIDDEN');
    throw error;
  }
}

/** Explicit cold-install administrator only. No application, provider registry,
 * Owner or listener is constructed. Existing databases cannot enter this path.
 * The temporary writer is a real fenced SQLite holder and is released before
 * return. A subsequent normal Coordinator must acquire a later generation. */
export async function bootstrapIndependentColdBusiness(
  input: ColdBusinessBootstrapInput,
  { clock, ids }: { clock: Clock; ids: IdGenerator },
) {
  requireUpgrade(
    /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(input.instanceId) &&
      [
        input.businessPath,
        input.controlPath,
        input.migrationsFolder,
        input.coordinatorArtifactRoot,
      ].every((path) => isAbsolute(path) && resolve(path) === path) &&
      input.businessPath !== input.controlPath &&
      !below(dirname(input.businessPath), input.controlPath) &&
      !below(dirname(input.controlPath), input.businessPath) &&
      ![input.businessPath, input.controlPath].some(
        (path) =>
          below(input.coordinatorArtifactRoot, path) ||
          below(dirname(path), input.coordinatorArtifactRoot),
      ),
    'COLD_BOOTSTRAP_SCOPE_INVALID',
  );
  const assertTime = () => {
    requireUpgrade(
      Number.isSafeInteger(input.deadline) && clock.now().getTime() < input.deadline,
      'COLD_BOOTSTRAP_DEADLINE_EXPIRED',
    );
  };
  assertTime();
  requireUpgrade(
    (await realpath(input.coordinatorArtifactRoot)) === input.coordinatorArtifactRoot &&
      (await realpath(input.migrationsFolder)) === input.migrationsFolder &&
      input.migrationsFolder === join(input.coordinatorArtifactRoot, 'api/drizzle'),
    'COLD_BOOTSTRAP_MIGRATION_ROOT_INVALID',
  );
  const bundle = bundleSchema.parse(
    JSON.parse(
      await readFile(join(input.coordinatorArtifactRoot, 'upgrade-artifact.json'), 'utf8'),
    ),
  );
  const actualDigest = await verifyInstalledArtifactTree(
    input.coordinatorArtifactRoot,
    'api',
    bundle.files.filter((file) => typeof file.path === 'string' && file.path.startsWith('api/')),
  );
  requireUpgrade(
    actualDigest === bundle.components.coordinator.artifactDigest,
    'COLD_BOOTSTRAP_ARTIFACT_CHANGED',
  );
  const metadata = journalSchema.parse(
    JSON.parse(await readFile(join(input.migrationsFolder, 'meta/_journal.json'), 'utf8')),
  );
  const migrations = readMigrationFiles({ migrationsFolder: input.migrationsFolder });
  requireUpgrade(
    metadata.entries.length === CONTROL_METADATA_MIGRATION.compiledSchema &&
      migrations.length === CONTROL_METADATA_MIGRATION.compiledSchema &&
      metadata.entries.filter((entry) => entry.tag === CONTROL_METADATA_MIGRATION.migrationTag)
        .length === 1 &&
      metadata.entries[29]?.tag === CONTROL_METADATA_MIGRATION.migrationTag &&
      metadata.entries[29].when === 1792454400000 &&
      migrations[29]?.hash === CONTROL_METADATA_MIGRATION.migrationHash &&
      upgradeDigest(
        migrations
          .slice(0, 29)
          .map((migration) => ({ hash: migration.hash, created_at: migration.folderMillis })),
      ) === CONTROL_METADATA_MIGRATION.sourceJournalDigest,
    'COLD_BOOTSTRAP_MIGRATIONS_UNREVIEWED',
  );
  assertTime();
  // Exclusive creation is the admission barrier. A partial or failed cold
  // install is retained for diagnosis and cannot be silently reinitialized.
  await freshPrivateFile(input.businessPath);
  await freshPrivateFile(input.controlPath);
  const business = new Database(input.businessPath);
  let ledger: Database.Database | undefined;
  let fenced: Database.Database | undefined;
  try {
    ledger = new Database(input.controlPath);
    for (const sqlite of [business, ledger]) {
      sqlite.pragma('busy_timeout=50');
      sqlite.pragma('journal_mode=WAL');
      sqlite.pragma('foreign_keys=ON');
      requireUpgrade(
        sqlite
          .prepare("SELECT 1 FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' LIMIT 1")
          .get() === undefined,
        'COLD_BOOTSTRAP_EXISTING_DATABASE_FORBIDDEN',
      );
    }
    // Acquire before the first business table exists, using the same production
    // connection fence that normal Coordinators use. No lease row is invented.
    const active = fenceCoordinatorConnection(business, input.instanceId, clock, ids);
    fenced = active;
    const control = coordinatorWriterControl(active);
    control.assert();
    requireUpgrade(
      control.generation === 1 && control.fence === 1,
      'COLD_BOOTSTRAP_WRITER_NOT_FRESH',
    );
    business.pragma('foreign_keys=OFF');
    try {
      active
        .transaction(() => {
          assertTime();
          active.exec(
            'CREATE TABLE "__drizzle_migrations" (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)',
          );
          const insert = active.prepare(
            'INSERT INTO "__drizzle_migrations" (hash,created_at) VALUES(?,?)',
          );
          for (const migration of migrations.slice(0, 29)) {
            assertTime();
            control.assert();
            for (const sql of migration.sql) active.exec(sql);
            insert.run(migration.hash, migration.folderMillis);
          }
        })
        .immediate();
    } finally {
      business.pragma('foreign_keys=ON');
    }
    const violations: unknown = business.pragma('foreign_key_check');
    requireUpgrade(
      Array.isArray(violations) && violations.length === 0,
      'COLD_BOOTSTRAP_FOREIGN_KEY_CHECK_FAILED',
    );
    assertTime();
    control.assert();
    createUpgradeControlStores({ sqlite: ledger, instanceId: input.instanceId, clock, ids });
    const observed = observeControlMetadataSource({
      businessSqlite: business,
      instanceId: input.instanceId,
      migrationsFolder: input.migrationsFolder,
      clock,
      sourceCoordinator: {
        instanceId: input.instanceId,
        artifactDigest: actualDigest,
        generation: control.generation,
        writerFenceValid: true,
        observedAt: clock.now().toISOString(),
      },
    });
    bindControlMetadataSource(ledger, observed);
    control.release();
    const lease = business
      .prepare<unknown[], { generation: number; fence: number; expires_at: number }>(
        "SELECT generation,fence,expires_at FROM platform_role_leases WHERE role='state-coordinator'",
      )
      .get();
    requireUpgrade(
      lease?.generation === 1 && lease.fence === 1 && lease.expires_at === 0,
      'COLD_BOOTSTRAP_WRITER_RELEASE_UNKNOWN',
    );
    const facts = {
      schemaVersion: 1,
      kind: 'independent-cold-business-bootstrap',
      instanceId: input.instanceId,
      businessSchema: 29,
      controlSchema: 1,
      businessBinding: observed,
      sourceCoordinatorDigest: actualDigest,
      sourceJournalDigest: CONTROL_METADATA_MIGRATION.sourceJournalDigest,
      temporaryWriter: lease,
      confirmed: false,
      observedAt: clock.now().toISOString(),
    };
    return { ...facts, receiptDigest: upgradeDigest(facts) };
  } finally {
    ledger?.close();
    if (fenced) fenced.close();
    else business.close();
  }
}
