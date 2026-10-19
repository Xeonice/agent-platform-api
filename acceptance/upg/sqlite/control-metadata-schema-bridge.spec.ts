import 'reflect-metadata';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import {
  chmodSync,
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  appendFileSync,
  realpathSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fromEpochMs } from '@platform/shared-kernel';
import { createUpgradeControlStores } from '../../../apps/api/src/platform/upgrade/control-store-factory';
import {
  observeControlMetadataSource,
  bindControlMetadataSource,
  assertControlMetadataBusinessCompatibility,
} from '../../../apps/api/src/platform/persistence/control-metadata-schema-bridge';
import { assertCoordinatorMigrationCompatibility } from '../../../apps/api/src/platform/persistence/coordinator-schema-compatibility';
import { runMigrations } from '../../../apps/api/src/platform/persistence/drizzle.connection';
import { preparedConnection } from '../../../apps/api/src/platform/persistence/prepared-connection';
import { useEnv } from '../../support/strict-ports';

let directory: string, business: Database.Database, ledger: Database.Database, restore: () => void;
const instanceId = 'control-metadata-schema-fixture';
const coordinator = {
  instanceId,
  artifactDigest: 'sha256:' + 'a'.repeat(64),
  generation: 7,
  writerFenceValid: true as const,
  observedAt: '1970-01-01T00:00:00.001Z',
};
function businessFile(path: string) {
  const db = new Database(path);
  db.pragma('journal_mode=WAL');
  migrate(drizzle(db), { migrationsFolder: join(directory, 'source29') });
  db.prepare('INSERT INTO platform_role_leases VALUES(?,?,?,?,?,?)').run(
    'state-coordinator',
    instanceId,
    'fixture-source-only',
    7,
    7,
    60000,
  );
  chmodSync(path, 0o600);
  return db;
}
function bind() {
  const observed = observeControlMetadataSource({
    businessSqlite: business,
    instanceId,
    migrationsFolder: resolve('drizzle'),
    clock: { now: () => fromEpochMs(1) },
    sourceCoordinator: coordinator,
  });
  bindControlMetadataSource(ledger, observed);
  return observed;
}
beforeEach(() => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), 'control-metadata-schema-')));
  const source = join(directory, 'source29');
  cpSync(resolve('drizzle'), source, { recursive: true });
  const journal = JSON.parse(readFileSync(join(source, 'meta/_journal.json'), 'utf8')) as {
    entries: unknown[];
  };
  journal.entries = journal.entries.slice(0, 29);
  writeFileSync(join(source, 'meta/_journal.json'), JSON.stringify(journal));
  business = businessFile(join(directory, 'business.db'));
  ledger = new Database(join(directory, 'control.db'));
  chmodSync(ledger.name, 0o600);
  createUpgradeControlStores({
    sqlite: ledger,
    instanceId,
    clock: { now: () => fromEpochMs(1) },
    ids: { next: randomUUID },
  });
  restore = useEnv({
    PLATFORM_INSTANCE_ID: instanceId,
    UPGRADE_CONTROL_DATABASE_PATH: ledger.name,
    MIGRATIONS_DIR: resolve('drizzle'),
  });
});
afterEach(() => {
  business.close();
  ledger.close();
  restore();
  rmSync(directory, { recursive: true, force: true });
});
describe('reviewed control-only migration separation from actual business schema29', () => {
  it('requires an explicit binding, then preserves business29 through migration and prepared startup', () => {
    expect(() => assertCoordinatorMigrationCompatibility(business, 30)).toThrow(
      'CONTROL_BRIDGE_BINDING_REQUIRED',
    );
    const observed = bind();
    expect(observed.source_schema).toBe(29);
    expect(() => bindControlMetadataSource(ledger, observed)).not.toThrow();
    expect(() => assertCoordinatorMigrationCompatibility(business, 30)).not.toThrow();
    runMigrations(drizzle(business), business);
    expect(business.prepare('SELECT count(*) n FROM __drizzle_migrations').get()).toEqual({
      n: 29,
    });
    expect(business.pragma('table_info(upgrade_steps)')).not.toContainEqual(
      expect.objectContaining({ name: 'evidence_digest' }),
    );
    const prepared = preparedConnection(business.name, instanceId);
    try {
      expect(
        prepared.connection.sqlite.prepare('SELECT count(*) n FROM __drizzle_migrations').get(),
      ).toEqual({ n: 29 });
    } finally {
      prepared.connection.sqlite.close();
    }
  });
  it('rejects the same schema in another physical DB and a mismatched source identity', () => {
    expect(() =>
      observeControlMetadataSource({
        businessSqlite: business,
        instanceId,
        migrationsFolder: resolve('drizzle'),
        clock: { now: () => fromEpochMs(1) },
        sourceCoordinator: { ...coordinator, generation: 6 },
      }),
    ).toThrow('CONTROL_BRIDGE_SOURCE_IDENTITY_UNQUALIFIED');
    bind();
    const other = businessFile(join(directory, 'other-business.db'));
    try {
      expect(() =>
        assertControlMetadataBusinessCompatibility(other, resolve('drizzle'), instanceId),
      ).toThrow('CONTROL_BRIDGE_BINDING_UNQUALIFIED');
    } finally {
      other.close();
    }
  });
  it('refuses a modified or future compiled migration and performs no business DDL', () => {
    bind();
    const modified = join(directory, 'changed30');
    cpSync(resolve('drizzle'), modified, { recursive: true });
    appendFileSync(
      join(modified, '0029_upgrade_control_fast_path.sql'),
      '\n-- unreviewed fixture change\n',
    );
    expect(() =>
      assertControlMetadataBusinessCompatibility(business, modified, instanceId),
    ).toThrow('CONTROL_METADATA_MIGRATION_UNREVIEWED');
    const future = join(directory, 'future31');
    cpSync(resolve('drizzle'), future, { recursive: true });
    const journal = JSON.parse(readFileSync(join(future, 'meta/_journal.json'), 'utf8')) as {
      entries: { idx: number; tag: string; when: number; version: string; breakpoints: boolean }[];
    };
    journal.entries.push({
      idx: 30,
      tag: '0030_unreviewed',
      when: 1792540800000,
      version: '6',
      breakpoints: true,
    });
    writeFileSync(join(future, 'meta/_journal.json'), JSON.stringify(journal));
    writeFileSync(
      join(future, '0030_unreviewed.sql'),
      'CREATE TABLE forbidden_future(value TEXT);',
    );
    expect(() => assertControlMetadataBusinessCompatibility(business, future, instanceId)).toThrow(
      'CONTROL_METADATA_MIGRATION_UNREVIEWED',
    );
    expect(() => assertCoordinatorMigrationCompatibility(business, 31)).toThrow(
      'CONTROL_METADATA_MIGRATION_UNREVIEWED',
    );
    expect(
      business.prepare("SELECT name FROM sqlite_master WHERE name='forbidden_future'").get(),
    ).toBeUndefined();
  });
  it('rejects an altered source journal and a lower or different instance binding', () => {
    const observed = bind();
    expect(() =>
      bindControlMetadataSource(ledger, {
        ...observed,
        business_ino: String(Number(observed.business_ino) + 1),
      }),
    ).toThrow('CONTROL_BRIDGE_BINDING_CONFLICT');
    business
      .prepare(
        "UPDATE __drizzle_migrations SET hash='unreviewed' WHERE rowid=(SELECT min(rowid) FROM __drizzle_migrations)",
      )
      .run();
    expect(() =>
      assertControlMetadataBusinessCompatibility(business, resolve('drizzle'), instanceId),
    ).toThrow('CONTROL_BRIDGE_SOURCE_SCHEMA_UNQUALIFIED');
  });
});
