import { assertDefined } from '../../support/assert-defined';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { asProjectId } from '@platform/shared-kernel';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { fenceCoordinatorConnection } from '../../../apps/api/src/platform/persistence/coordinator-lease';
import { SqliteUnitOfWork } from '../../../apps/api/src/platform/persistence/unit-of-work.impl';
import { Project } from '../../../packages/modules/project/src/domain/entities/project.entity';
import { SqliteProjectRepository } from '../../../packages/modules/project/src/infrastructure/persistence/sqlite/project.repository.impl';
import { UpgradeStore } from '../../../apps/api/src/platform/upgrade/upgrade-store';
import {
  UpgradeOnlineMigration,
  OnlineMigrationPlanSchema,
} from '../../../apps/api/src/platform/upgrade/upgrade-online-migration';
import { upgradeDigest } from '../../../apps/api/src/platform/upgrade/upgrade-trust';
import { UpgradeContractPlanSchema } from '@platform/contracts';
import { currentDatabase } from '../../support/sqlite';
import { fixedClock, NOW } from '../../support/project-ports';
import { useEnv } from '../../support/strict-ports';

const cleanup: (() => void)[] = [];
afterEach(() =>
  cleanup
    .splice(0)
    .reverse()
    .forEach((fn) => fn()),
);
// A real repository consumes a real renamed shadow column. The prepared ledger
// row below is a read-boundary fixture, not proof of executing the migration;
// online-migration.spec and the native runner separately execute that transition.
function fixture() {
  const raw = currentDatabase();
  cleanup.push(() => raw.sqlite.close());
  cleanup.push(
    useEnv({ COORDINATOR_GENERATION: undefined, COORDINATOR_WRITER_FENCE_VALID: undefined }),
  );
  const sqlite = fenceCoordinatorConnection(
    raw.sqlite,
    'project-read-projection-test',
    fixedClock(),
    { next: () => randomUUID() },
  );
  const db = { sqlite, db: drizzle(sqlite), uow: new SqliteUnitOfWork(sqlite) };
  cleanup.push(useEnv({ PLATFORM_INSTANCE_ID: 'project-read-projection-test' }));
  const store = new UpgradeStore(db.sqlite, fixedClock(), { next: () => randomUUID() });
  const migration = new UpgradeOnlineMigration(store, fixedClock());
  const schema = migration.schema();
  const oldReader = new SqliteProjectRepository(db.db);
  const newReader = new SqliteProjectRepository(db.db, {
    name: (id, original) => migration.projectedProjectName(id, original),
    authoritative: () => migration.projectNameAuthoritative(),
    findIdByName: (name) => migration.projectIdByName(name),
    saveNameSync: (_tx, id, name) => migration.saveProjectName(id, name),
  });
  const project = Project.create({
    id: asProjectId('original-project'),
    name: 'Original project',
    sourceType: 'empty',
    baselinePath: '/isolated/original-project',
    now: NOW,
  });
  db.uow.run((tx) => oldReader.saveSync(tx, project));
  const plan = OnlineMigrationPlanSchema.parse({
    schemaVersion: 1,
    kind: 'expand-shadow',
    fromSchema: schema,
    targetSchema: schema,
    maxBatchRows: 100,
    oldRepresentationRetained: true,
    newSemanticsEnabled: false,
    projections: [
      {
        sourceTable: 'projects',
        primaryKey: 'id',
        targetTable: 'upg_shadow_project_display',
        fields: [{ name: 'display_name', source: 'name', type: 'text' }],
      },
    ],
  });
  const digest = upgradeDigest(plan);
  db.sqlite
    .prepare("INSERT INTO upgrade_online_migrations VALUES(?,?,?,'complete',?,1,1,0,NULL,?)")
    .run(
      digest,
      'read-fixture-not-attempt',
      JSON.stringify(plan),
      JSON.stringify({ phase: 'complete' }),
      NOW.getTime(),
    );
  db.sqlite.exec(
    'CREATE TABLE upg_shadow_project_display(row_key TEXT PRIMARY KEY,row_revision INTEGER,tombstone INTEGER,display_name TEXT)',
  );
  db.sqlite
    .prepare('INSERT INTO upg_shadow_project_display VALUES(?,1,0,?)')
    .run(project.id, project.name);
  const rawContract = {
    schemaVersion: 1,
    kind: 'project-name-contract',
    expandPlanDigest: digest,
    targetTable: 'upg_shadow_project_display',
    nameColumn: 'display_name',
    artifactInputFingerprint: upgradeDigest({ fixture: 'state-boundary-only' }),
    rollbackWindowMs: 60000,
    maxValidationRows: 100,
    maxBatchRows: 1,
    batchBudgetMs: 1000,
    minFreeBytes: 1,
    maxWalBytes: 1024 ** 3,
    preserveUserResources: true,
    rollbackToLegacy: false,
  };
  const contract = UpgradeContractPlanSchema.parse({
    ...rawContract,
    planDigest: upgradeDigest(rawContract),
  });
  // Same durable source-change outbox shape as the production bridge, on real
  // business writes. Admission/signature/reader retirement is tested separately.
  for (const operation of ['INSERT', 'UPDATE', 'DELETE']) {
    db.sqlite.exec(`CREATE TRIGGER fixture_${operation.toLowerCase()} AFTER ${operation} ON projects
      BEGIN INSERT INTO upgrade_projection_changes(plan_digest,projection,row_key,payload,tombstone)
      VALUES('${digest}','upg_shadow_project_display',${operation === 'DELETE' ? 'OLD' : 'NEW'}.id,
      ${operation === 'DELETE' ? 'NULL' : "json_object('name',NEW.name)"},${Number(operation === 'DELETE')}); END`);
  }
  migration.onApplicationBootstrap();
  return { db, migration, schema, oldReader, newReader, project, digest, contract };
}
describe('REQ-UPG-006/008 — real business reads consume the bridge representation', () => {
  it('reads the renamed column through production project repository while the retained source reader stays usable', async () => {
    const f = fixture();
    expect(assertDefined(await f.oldReader.findById(f.project.id)).name).toBe('Original project');
    expect(f.migration.projectionReadEvidence()).toEqual([]);
    expect(assertDefined(await f.newReader.findById(f.project.id)).name).toBe('Original project');
    expect((await f.newReader.findAll())[0].id).toBe(f.project.id);
    expect(f.migration.projectionReadEvidence()).toMatchObject([
      {
        planDigest: f.digest,
        sourceTable: 'projects',
        targetTable: 'upg_shadow_project_display',
        sourceColumn: 'name',
        targetColumn: 'display_name',
        count: 2,
      },
    ]);
    expect(f.migration.schema()).toBe(f.schema); // Representation epoch is not a new committed Drizzle version.
  });
  it('withdraws a corrupt isolated new read and returns complete old authority without claiming a confirmed projection', async () => {
    const f = fixture();
    f.db.sqlite.prepare('UPDATE upg_shadow_project_display SET display_name=?').run('tampered');
    expect(assertDefined(await f.newReader.findById(f.project.id)).name).toBe('Original project');
    expect(
      f.db.sqlite.prepare('SELECT read_epoch,degraded FROM upgrade_online_migrations').get(),
    ).toEqual({ read_epoch: 0, degraded: 1 });
    expect(f.migration.projectionReadEvidence()).toEqual([]);
    expect(assertDefined(await f.oldReader.findById(f.project.id)).name).toBe('Original project');
  });
  it('isolates missing shadow structure while a healthy source row continues to be served', async () => {
    const f = fixture();
    f.db.sqlite.exec('DROP TABLE upg_shadow_project_display');
    expect(assertDefined(await f.newReader.findById(f.project.id)).name).toBe('Original project');
    expect(
      f.db.sqlite.prepare('SELECT read_epoch,degraded,reason FROM upgrade_online_migrations').get(),
    ).toEqual({ read_epoch: 0, degraded: 1, reason: 'SHADOW_READ_UNAVAILABLE' });
    expect(f.db.sqlite.pragma('quick_check', { simple: true })).toBe('ok');
  });
  it('executes semantic contraction, keeps public reads/name lookup on the new authority and preserves new CRUD', async () => {
    const f = fixture();
    await f.newReader.findAll();
    let checks = 0;
    expect(
      f.migration.activateProjectAuthority(f.contract, () => {
        checks++;
      }),
    ).toBe(1);
    expect(
      f.migration.clearLegacyProjectNames(f.contract, () => {
        checks++;
      }),
    ).toEqual({ cleared: 1, complete: true });
    expect(checks).toBeGreaterThanOrEqual(4);
    const physical = f.db.sqlite
      .prepare('SELECT name FROM projects WHERE id=?')
      .get(f.project.id) as { name: string };
    expect(physical.name).toMatch(/^~r[a-f0-9]{8}v0:[a-f0-9]{24}$/);
    expect(assertDefined(await f.newReader.findById(f.project.id)).name).toBe(f.project.name);
    expect(assertDefined(await f.newReader.findByName(f.project.name)).id).toBe(f.project.id);
    const created = Project.create({
      id: asProjectId('post-contract'),
      name: 'After cleanup',
      sourceType: 'empty',
      baselinePath: '/isolated/post-contract',
      now: NOW,
    });
    f.db.uow.run((tx) => f.newReader.saveSync(tx, created));
    expect(assertDefined(await f.newReader.findByName('After cleanup')).id).toBe(created.id);
    f.db.uow.run((tx) =>
      f.newReader.saveSync(
        tx,
        Project.create({
          id: created.id,
          name: 'Updated after cleanup',
          sourceType: 'empty',
          baselinePath: created.baselinePath,
          now: NOW,
        }),
      ),
    );
    expect(await f.newReader.findByName('After cleanup')).toBeNull();
    expect(assertDefined(await f.newReader.findByName('Updated after cleanup')).id).toBe(
      created.id,
    );
    f.db.uow.run((tx) => f.newReader.deleteSync(tx, created.id));
    expect(await f.newReader.findByName('Updated after cleanup')).toBeNull();
    expect(
      (
        f.db.sqlite
          .prepare('SELECT tombstone FROM upg_shadow_project_display WHERE row_key=?')
          .get(created.id) as { tombstone: number }
      ).tombstone,
    ).toBe(1);
    expect(f.migration.schema()).toBe(f.schema);
  });
  it('rejects duplicate new names transactionally and never falls back to old internal slots after authority changes', async () => {
    const f = fixture();
    f.migration.activateProjectAuthority(f.contract, () => undefined);
    f.migration.clearLegacyProjectNames(f.contract, () => undefined);
    const duplicate = Project.create({
      id: asProjectId('duplicate'),
      name: f.project.name,
      sourceType: 'empty',
      baselinePath: '/isolated/duplicate',
      now: NOW,
    });
    expect(() => f.db.uow.run((tx) => f.newReader.saveSync(tx, duplicate))).toThrow();
    expect(await f.newReader.findById(duplicate.id)).toBeNull();
    f.db.sqlite.exec('DROP TABLE upg_shadow_project_display');
    await expect(f.newReader.findAll()).rejects.toThrow();
    expect(() => f.db.uow.run((tx) => f.newReader.saveSync(tx, f.project))).toThrow();
    expect(
      (
        f.db.sqlite.prepare('SELECT read_epoch FROM upgrade_online_migrations').get() as {
          read_epoch: number;
        }
      ).read_epoch,
    ).toBe(2);
  });
  it('rolls back rejected authority/batches and preserves a legitimate name resembling the retired namespace', async () => {
    const f = fixture();
    let checks = 0;
    expect(() =>
      f.migration.activateProjectAuthority(f.contract, () => {
        if (++checks === 2) throw Error('ACTUAL_FENCE_EXPIRED');
      }),
    ).toThrow('ACTUAL_FENCE_EXPIRED');
    expect(
      (
        f.db.sqlite.prepare('SELECT read_epoch FROM upgrade_online_migrations').get() as {
          read_epoch: number;
        }
      ).read_epoch,
    ).toBe(1);
    expect((await f.newReader.findAll())[0].name).toBe(f.project.name);
    const resembling = '~r' + f.contract.planDigest.slice(7, 15) + 'v0:another-user';
    f.db.sqlite.prepare('UPDATE projects SET name=? WHERE id=?').run(resembling, f.project.id);
    f.db.sqlite
      .prepare('UPDATE upg_shadow_project_display SET display_name=? WHERE row_key=?')
      .run(resembling, f.project.id);
    f.db.sqlite.prepare('UPDATE upgrade_projection_changes SET projected=1').run();
    f.migration.activateProjectAuthority(f.contract, () => undefined);
    f.migration.clearLegacyProjectNames(f.contract, () => undefined);
    expect((await f.newReader.findAll())[0].name).toBe(resembling);
    expect(
      (f.db.sqlite.prepare('SELECT name FROM projects').get() as { name: string }).name,
    ).toContain('v1:');
  });
});
