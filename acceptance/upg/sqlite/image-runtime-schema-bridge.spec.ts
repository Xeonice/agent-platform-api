import { assertDefined } from '../../support/assert-defined';
import 'reflect-metadata';
import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { createServer, get } from 'node:http';
import { promisify } from 'node:util';
import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ConfirmedServiceReleaseSchema,
  UpgradeManifestSchema,
  type SignedUpgradeManifest,
} from '@platform/contracts';
import { fromEpochMs } from '@platform/shared-kernel';
import {
  createConnection,
  runMigrations,
} from '../../../apps/api/src/platform/persistence/drizzle.connection';
import {
  coordinatorWriterControl,
  fenceCoordinatorConnection,
} from '../../../apps/api/src/platform/persistence/coordinator-lease';
import { assertCoordinatorMigrationCompatibility } from '../../../apps/api/src/platform/persistence/coordinator-schema-compatibility';
import { preparedConnection } from '../../../apps/api/src/platform/persistence/prepared-connection';
import { UpgradeStore } from '../../../apps/api/src/platform/upgrade/upgrade-store';
import { UpgradeOnlineMigration } from '../../../apps/api/src/platform/upgrade/upgrade-online-migration';
import {
  freezeUpgradePlan,
  upgradeDigest,
} from '../../../apps/api/src/platform/upgrade/upgrade-trust';
import {
  IMAGE_RUNTIME_SCHEMA_PLAN as recipe,
  IMAGE_RUNTIME_SCHEMA_PLAN_DIGEST as recipeDigest,
} from '../../../apps/api/src/platform/upgrade/image-runtime-schema-plan';
import { imageRuntimeSchemaCommitted } from '../../../apps/api/src/platform/upgrade/image-runtime-schema-migration';
import * as integrity from '../../../apps/api/src/platform/upgrade/migration-database-integrity';
import { useEnv, stub } from '../../support/strict-ports';

// Actual SQLite/journal, old-writer fencing and immutable package-plan boundary.
// These state-layer tests do not claim native Guest or release qualification.
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture(options: { verified?: boolean; minFreeBytes?: number } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'image-runtime-schema-bridge-'));
  const sourceMigrations = join(directory, 'source-migrations');
  await cp(resolve('drizzle'), sourceMigrations, { recursive: true });
  const journal = JSON.parse(
    await readFile(join(sourceMigrations, 'meta/_journal.json'), 'utf8'),
  ) as {
    entries: { tag: string; when: number; idx: number; version: string; breakpoints: boolean }[];
  };
  journal.entries = journal.entries.slice(0, 28);
  await writeFile(join(sourceMigrations, 'meta/_journal.json'), JSON.stringify(journal));
  const restore = useEnv({
    PLATFORM_INSTANCE_ID: 'image-runtime-schema-state-fixture',
    MIGRATIONS_DIR: sourceMigrations,
    UPGRADE_INSTALLER_ROOT: directory,
    COORDINATOR_GENERATION: undefined,
    COORDINATOR_WRITER_FENCE_VALID: undefined,
  });
  const filename = join(directory, 'business.db');
  const connection = createConnection(filename);
  runMigrations(connection.db, connection.sqlite);
  let time = Date.parse('2026-10-17T12:00:00Z');
  const clock = { now: () => fromEpochMs(time) };
  const sqlite = fenceCoordinatorConnection(
    connection.sqlite,
    'image-runtime-schema-state-fixture',
    clock,
    { next: () => randomUUID() },
  );
  cleanup.push(async () => {
    sqlite.close();
    restore();
    await rm(directory, { recursive: true, force: true });
  });
  sqlite
    .prepare('INSERT INTO images(id,name,is_builtin,created_at) VALUES(?,?,?,?)')
    .run('image-old', 'registry.invalid/old', 1, time);
  sqlite
    .prepare(
      'INSERT INTO image_manifests(id,image_id,version,base_image,digest,entrypoint_contract,supported_runtimes,resource_defaults,labels_required,registered_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
    )
    .run(
      'manifest-old',
      'image-old',
      'v1',
      'base',
      'sha256:old-digest',
      '{}',
      '["codex"]',
      '{}',
      '[]',
      time,
    );
  // This exact prepared SELECT/INSERT shape represents the retained schema-28
  // image writer; the new column's default keeps it valid after migration.
  const oldRead = sqlite.prepare('SELECT id,digest,is_active FROM image_manifests ORDER BY id');
  const oldInsert = sqlite.prepare(
    'INSERT INTO image_manifests(id,image_id,version,base_image,digest,entrypoint_contract,supported_runtimes,resource_defaults,labels_required,registered_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
  );
  const component = {
    artifactDigest: upgradeDigest({ role: 'state-fixture' }),
    inputFingerprint: upgradeDigest({ input: 'state-fixture' }),
    sourceRevision: 'a'.repeat(40),
    protocol: { min: 1, max: 1 },
  };
  const current = ConfirmedServiceReleaseSchema.parse({
    releaseId: '0.3.12-bridge.1',
    activationGeneration: 1,
    activatedAt: clock.now().toISOString(),
    schema: 28,
    channel: 'state-fixture',
    components: {
      api: component,
      web: { ...component, webRevision: 'a'.repeat(40) },
      coordinator: component,
      owner: component,
      installer: component,
    },
    commits: { project: 'a'.repeat(40), api: 'a'.repeat(40), web: 'a'.repeat(40) },
    productionWebBinding: 'http://127.0.0.1/state-fixture',
  });
  const store = new UpgradeStore(sqlite, clock, { next: () => randomUUID() });
  store.bootstrap(current);
  const targetRoot = join(directory, 'artifacts', recipeDigest.slice(7));
  await mkdir(targetRoot, { recursive: true });
  const file = join(targetRoot, 'upgrade-migration.json');
  await writeFile(file, JSON.stringify(recipe), { mode: 0o600 });
  await cp(sourceMigrations, join(targetRoot, 'api/drizzle'), { recursive: true });
  journal.entries.push({
    idx: 28,
    version: '6',
    when: recipe.migrationTimestamp,
    tag: recipe.migrationTag,
    breakpoints: true,
  });
  await writeFile(join(targetRoot, 'api/drizzle/meta/_journal.json'), JSON.stringify(journal));
  const sql = "ALTER TABLE `image_manifests` ADD `runtime_versions` text DEFAULT '{}' NOT NULL;";
  await writeFile(join(targetRoot, 'api/drizzle', recipe.migrationTag + '.sql'), sql);
  const manifest = UpgradeManifestSchema.parse({
    schemaVersion: 2,
    releaseId: '0.3.12-experiment.1',
    channel: current.channel,
    publishedAt: clock.now().toISOString(),
    components: current.components,
    commits: current.commits,
    packages: [
      {
        platform: process.platform,
        arch: process.arch,
        name: 'state-fixture.tgz',
        url: 'https://fixture.invalid/state-fixture.tgz',
        digest: recipeDigest,
        bytes: 1000,
        format: 'native-tar',
      },
    ],
    upgradePaths: [
      {
        fromRelease: current.releaseId,
        minSchema: 28,
        maxSchema: 29,
        targetSchema: 29,
        bridgeReleases: [],
        migrationPlanDigest: recipeDigest,
      },
    ],
    policy: {
      id: 'state-fixture',
      weights: [1, 5, 25, 100],
      stageDurationMs: 60000,
      minRequests: 100,
      observationFreshnessMs: 5000,
      probeHz: 10,
      requestDeadlineMs: 2000,
      attachDeadlineMs: 5000,
      softErrorDelta: 0.01,
      p95Ratio: 2,
      p95FloorMs: 1000,
      evaluationIntervalMs: 10000,
      consecutiveEvaluations: 2,
      retentionMs: 60000,
      migrationBatchMs: 500,
      maxWalBytes: 64 * 1024 * 1024,
      minFreeBytes: options.minFreeBytes ?? 1,
      fallbacks: [
        {
          releaseId: current.releaseId,
          apiDigest: component.artifactDigest,
          webDigest: component.artifactDigest,
          rehearsed: false,
        },
      ],
      stopUserResources: false,
      restoreLiveVolume: false,
      contractInUpgrade: false,
    },
    evidence: [],
  });
  const envelope: SignedUpgradeManifest = {
    manifest,
    manifestDigest: upgradeDigest(manifest),
    signature: { algorithm: 'Ed25519', keyId: 'state-layer-only', value: 'state-layer-only' },
  };
  const plan = freezeUpgradePlan(envelope, current);
  const accepted = store.accept(
    'state-layer-test',
    {
      requestId: randomUUID(),
      targetReleaseId: manifest.releaseId,
      targetDigest: envelope.manifestDigest,
      expectedActivationGeneration: 1,
    },
    envelope,
    plan,
  );
  const claim = store.claim(accepted.attemptId, 'state-layer-controller', 30000);
  if (options.verified !== false) {
    for (const step of plan.steps.filter(
      (entry) => entry.kind === 'download' || entry.kind === 'verify',
    )) {
      const evidence = { scope: 'state-layer-precondition-only' };
      store.commit(accepted.attemptId, {
        fence: claim.fence,
        generation: claim.generation,
        expectedSequence: store.attempt(accepted.attemptId).sequence,
        eventId: randomUUID(),
        kind: 'step-applied',
        payload: {
          stepId: step.stepId,
          completedWork: step.totalWork,
          evidence,
          receiptDigest: upgradeDigest(evidence),
        },
      });
    }
  }
  const runner = new UpgradeOnlineMigration(store);
  const execute = (action = 'prepare', fence = claim.fence) =>
    runner.execute(accepted.attemptId, {
      action,
      operationId: randomUUID(),
      planDigest: recipeDigest,
      fence,
    });
  const schema = () =>
    (sqlite.prepare('SELECT count(*) n FROM __drizzle_migrations').get() as { n: number }).n;
  return {
    directory,
    filename,
    sourceMigrations,
    sqlite,
    store,
    runner,
    execute,
    schema,
    file,
    targetRoot,
    current,
    envelope,
    plan,
    oldRead,
    oldInsert,
    clock,
    advance: (ms: number) => {
      time += ms;
    },
  };
}

describe('REQ-UPG-006/007/008 — fixed schema-28 bridge for image CLI metadata', () => {
  it('commits the exact DDL and journal atomically while the retained writer keeps its old statements and data', async () => {
    const f = await fixture();
    expect(upgradeDigest(recipe)).toBe(recipeDigest);
    expect(
      createHash('sha256')
        .update(await readFile(join(f.targetRoot, 'api/drizzle', recipe.migrationTag + '.sql')))
        .digest('hex'),
    ).toBe(recipe.migrationHash);
    expect(f.plan.steps.map((step) => step.kind)).toEqual([
      'download',
      'verify',
      'migration',
      'activation',
    ]);
    expect(await f.execute('status')).toEqual({ definitelyNotApplied: true });
    const before = f.oldRead.all();
    expect(await f.execute()).toMatchObject({
      complete: true,
      commitKnown: true,
      integrityValid: true,
      budgetExceeded: false,
    });
    expect(f.schema()).toBe(29);
    expect(f.oldRead.all()).toEqual(before);
    f.oldInsert.run(
      'manifest-after',
      'image-old',
      'v2',
      'base',
      'sha256:after',
      '{}',
      '[]',
      '{}',
      '[]',
      f.clock.now().getTime(),
    );
    expect(
      f.sqlite.prepare('SELECT id,runtime_versions FROM image_manifests ORDER BY id').all(),
    ).toEqual([
      { id: 'manifest-after', runtime_versions: '{}' },
      { id: 'manifest-old', runtime_versions: '{}' },
    ]);
    expect(imageRuntimeSchemaCommitted(f.sqlite)).toBe(true);
    expect(await f.execute()).toMatchObject({ complete: true });
    expect(await f.execute('status')).toMatchObject({ complete: true });
    expect(f.schema()).toBe(29);
    expect(f.runner.metrics(assertDefined(f.store.latest()).attemptId)).toMatchObject({
      known: true,
      differences: 0,
      oldRepresentationRetained: true,
      degraded: false,
    });
  });
  it('rejects every other global migration path, including a forged recipe, broad source range and schema 30', async () => {
    const f = await fixture();
    for (const patch of [
      { migrationPlanDigest: upgradeDigest({ unsafe: true }) },
      { maxSchema: 30 },
      { minSchema: 27 },
      { targetSchema: 30 },
      { migrationPlanDigest: null },
    ]) {
      const manifest = {
        ...f.envelope.manifest,
        upgradePaths: [{ ...assertDefined(f.envelope.manifest.upgradePaths[0]), ...patch }],
      };
      expect(() => freezeUpgradePlan({ ...f.envelope, manifest }, f.current)).toThrow(
        'GLOBAL_SCHEMA_MIGRATION_UNQUALIFIED',
      );
    }
  });
  it('refuses changed recipe or target migration bytes before modifying data or the journal', async () => {
    const f = await fixture();
    await writeFile(f.file, JSON.stringify({ ...recipe, sql: 'DROP TABLE image_manifests' }));
    await expect(f.execute()).rejects.toThrow('GLOBAL_SCHEMA_RECIPE_CHANGED');
    expect(f.schema()).toBe(28);
    await writeFile(f.file, JSON.stringify(recipe));
    await writeFile(
      join(f.targetRoot, 'api/drizzle', recipe.migrationTag + '.sql'),
      'DROP TABLE image_manifests;',
    );
    await expect(f.execute()).rejects.toThrow('GLOBAL_SCHEMA_TARGET_JOURNAL_CHANGED');
    expect(f.schema()).toBe(28);
    expect(f.oldRead.all()).toHaveLength(1);
  });
  it('requires actual package receipt, controller fence, writer fence and disk budget before DDL', async () => {
    const unverified = await fixture({ verified: false });
    await expect(unverified.execute()).rejects.toThrow('MIGRATION_PACKAGE_NOT_VERIFIED');
    expect(unverified.schema()).toBe(28);
    const f = await fixture({ minFreeBytes: Number.MAX_SAFE_INTEGER });
    await expect(f.execute()).rejects.toThrow('MIGRATION_DISK_BUDGET');
    expect(f.schema()).toBe(28);
    await expect(f.execute('prepare', -1)).rejects.toThrow();
    expect(f.schema()).toBe(28);
  });
  it('rolls back both DDL and journal if the atomic receipt cannot commit', async () => {
    const f = await fixture();
    f.sqlite.exec(
      "CREATE TRIGGER reject_global_receipt BEFORE INSERT ON upgrade_migration_operations BEGIN SELECT RAISE(ABORT,'receipt-write-fault'); END;",
    );
    await expect(f.execute()).rejects.toThrow('receipt-write-fault');
    expect(f.schema()).toBe(28);
    expect(
      (f.sqlite.prepare('PRAGMA table_info(image_manifests)').all() as { name: string }[]).some(
        (c) => c.name === 'runtime_versions',
      ),
    ).toBe(false);
    expect(f.oldRead.all()).toHaveLength(1);
    f.sqlite.exec('DROP TRIGGER reject_global_receipt');
    expect(await f.execute()).toMatchObject({ complete: true });
  });
  it('permits a schema-28 cold/prepared bridge after committed expansion, then rejects tampered or future journals', async () => {
    const f = await fixture();
    await f.execute();
    expect(() => assertCoordinatorMigrationCompatibility(f.sqlite, 28)).not.toThrow();
    const prepared = preparedConnection(f.filename, 'image-runtime-schema-state-fixture');
    expect(
      prepared.connection.sqlite.prepare('SELECT count(*) n FROM image_manifests').get(),
    ).toEqual({ n: 1 });
    coordinatorWriterControl(f.sqlite).release();
    const adopted = prepared.activate();
    expect(adopted).toBeGreaterThan(1);
    prepared.connection.sqlite
      .prepare('UPDATE image_manifests SET is_active=0 WHERE id=?')
      .run('manifest-old');
    expect(
      prepared.connection.sqlite.prepare('SELECT is_active FROM image_manifests').get(),
    ).toEqual({ is_active: 0 });
    prepared.connection.sqlite
      .prepare('UPDATE __drizzle_migrations SET hash=? WHERE created_at=?')
      .run('forged', recipe.migrationTimestamp);
    expect(() => assertCoordinatorMigrationCompatibility(prepared.connection.sqlite, 28)).toThrow(
      'ONLINE_MIGRATION_REQUIRED',
    );
    prepared.connection.sqlite
      .prepare('UPDATE __drizzle_migrations SET hash=? WHERE created_at=?')
      .run(recipe.migrationHash, recipe.migrationTimestamp);
    prepared.connection.sqlite
      .prepare('INSERT INTO __drizzle_migrations(hash,created_at) VALUES(?,?)')
      .run('future-schema', recipe.migrationTimestamp + 1);
    expect(() => assertCoordinatorMigrationCompatibility(prepared.connection.sqlite, 28)).toThrow(
      'ONLINE_MIGRATION_REQUIRED',
    );
    prepared.connection.sqlite.close();
  });
  it('reopens a committed schema-29 database through the actual schema-28 Coordinator connection in a fresh process', async () => {
    const f = await fixture();
    await f.execute();
    coordinatorWriterControl(f.sqlite).release();
    // Fresh source loader avoids depending on build outputs: CI tests execute
    // before build. The child still runs the actual platform connection code.
    const entry = resolve('apps/api/src/platform/persistence/platform.module.ts');
    const child = await promisify(execFile)(
      process.execPath,
      [
        '-e',
        `
      const fs=require('node:fs'),Module=require('node:module'),ts=require('typescript');
      const path=require('node:path'),root=process.cwd();
      const aliases=Object.fromEntries(['shared-kernel','contracts','project','automation','sandbox','terminal','credential','runtime','image'].map(name=>['@platform/'+name,path.join(root,'packages', ['shared-kernel','contracts'].includes(name)?name:'modules/'+name,'src/index.ts')]));
      const resolveOriginal=Module._resolveFilename;
      Module._resolveFilename=function(spec,parent,...options){return resolveOriginal.call(this,aliases[spec]||spec,parent,...options)};
      require.extensions['.ts']=function(module,file){module._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,experimentalDecorators:true,emitDecoratorMetadata:true,esModuleInterop:true}}).outputText,file)};
      const {platformConnection}=require(process.argv[1]);
      const c=platformConnection();
      c.sqlite.prepare('UPDATE image_manifests SET is_active=0 WHERE id=?').run('manifest-old');
      const row=c.sqlite.prepare('SELECT runtime_versions,is_active FROM image_manifests').get();
      if(row.runtime_versions!=='{}'||row.is_active!==0)throw Error('bridge-data');
      c.sqlite.close();process.stdout.write('cold-bridge-passed');
    `,
        entry,
      ],
      {
        env: {
          ...process.env,
          PLATFORM_PROCESS_ROLE: 'coordinator',
          DATABASE_URL: f.filename,
          PLATFORM_INSTANCE_ID: 'image-runtime-schema-state-fixture',
          MIGRATIONS_DIR: f.sourceMigrations,
        },
        timeout: 15000,
      },
    );
    expect(child.stdout).toBe('cold-bridge-passed');
    expect(f.schema()).toBe(29);
    expect(f.sqlite.prepare('SELECT is_active FROM image_manifests').get()).toEqual({
      is_active: 0,
    });
  });
  it('rejects unrecorded column additions and a superseded old writer, retaining data after preparation failure', async () => {
    const f = await fixture();
    coordinatorWriterControl(f.sqlite).release();
    await expect(f.execute()).rejects.toThrow('COORDINATOR_WRITER_FENCE_EXPIRED');
    expect(f.schema()).toBe(28);
    coordinatorWriterControl(f.sqlite).reacquire();
    f.sqlite.exec("ALTER TABLE image_manifests ADD runtime_versions text DEFAULT '{}' NOT NULL");
    await expect(f.execute()).rejects.toThrow('GLOBAL_SCHEMA_BASELINE_CHANGED');
    expect(imageRuntimeSchemaCommitted(f.sqlite)).toBe(false);
    expect(f.schema()).toBe(28);
    expect(f.oldRead.all()).toHaveLength(1);
  });
  it('refuses unrelated foreign-key corruption before acquiring the migration write transaction', async () => {
    const f = await fixture();
    f.sqlite.exec(
      'CREATE TABLE integrity_parent(id INTEGER PRIMARY KEY);' +
        'CREATE TABLE integrity_child(parent_id INTEGER REFERENCES integrity_parent(id));' +
        'PRAGMA foreign_keys=OFF; INSERT INTO integrity_child VALUES(7); PRAGMA foreign_keys=ON;',
    );
    await expect(f.execute()).rejects.toMatchObject({ code: 'GLOBAL_SCHEMA_INTEGRITY_FAILED' });
    expect(f.schema()).toBe(28);
    expect(imageRuntimeSchemaCommitted(f.sqlite)).toBe(false);
    expect(f.oldRead.all()).toHaveLength(1);
  });
  it('rolls back scoped integrity failure with the real DDL, journal and receipt', async () => {
    const f = await fixture();
    f.sqlite.exec(
      'PRAGMA foreign_keys=OFF;' +
        "CREATE TRIGGER break_image_fk AFTER INSERT ON __drizzle_migrations BEGIN UPDATE image_manifests SET image_id='missing-parent'; END;",
    );
    await expect(f.execute()).rejects.toThrow('GLOBAL_SCHEMA_INTEGRITY_FAILED');
    expect(f.schema()).toBe(28);
    expect(imageRuntimeSchemaCommitted(f.sqlite)).toBe(false);
    expect(f.sqlite.prepare('SELECT image_id FROM image_manifests').get()).toEqual({
      image_id: 'image-old',
    });
    expect(
      (f.sqlite.prepare('PRAGMA table_xinfo(image_manifests)').all() as { name: string }[]).some(
        (column) => column.name === 'runtime_versions',
      ),
    ).toBe(false);
  });
  it('still rolls back a real write batch exceeding 500 ms, including receipt work', async () => {
    const f = await fixture();
    f.sqlite.function('slow_receipt_fixture', () => {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 525);
      return 1;
    });
    f.sqlite.exec(
      'CREATE TRIGGER delay_receipt BEFORE INSERT ON upgrade_migration_operations BEGIN SELECT slow_receipt_fixture(); END;',
    );
    expect(f.plan.policy.migrationBatchMs).toBe(500);
    await expect(f.execute()).rejects.toThrow('MIGRATION_BATCH_BUDGET');
    expect(f.schema()).toBe(28);
    expect(imageRuntimeSchemaCommitted(f.sqlite)).toBe(false);
    expect(f.oldRead.all()).toHaveLength(1);
  });
  it('preserves a committed expansion after failed global postcheck and rechecks idempotent status', async () => {
    const f = await fixture();
    f.sqlite.exec(
      'CREATE TABLE integrity_parent(id INTEGER PRIMARY KEY);' +
        'CREATE TABLE integrity_child(parent_id INTEGER REFERENCES integrity_parent(id));' +
        'PRAGMA foreign_keys=OFF;' +
        'CREATE TRIGGER break_global_fk AFTER INSERT ON upgrade_migration_operations BEGIN INSERT INTO integrity_child VALUES(7); END;',
    );
    await expect(f.execute()).rejects.toThrow('GLOBAL_SCHEMA_INTEGRITY_FAILED');
    expect(f.schema()).toBe(29);
    expect(imageRuntimeSchemaCommitted(f.sqlite)).toBe(true);
    await expect(f.execute('status')).rejects.toThrow('GLOBAL_SCHEMA_INTEGRITY_FAILED');
    f.sqlite.exec('DROP TRIGGER break_global_fk; DELETE FROM integrity_child;');
    expect(await f.execute('status')).toMatchObject({ complete: true, integrityValid: true });
    expect(await f.execute()).toMatchObject({ complete: true, integrityValid: true });
    expect(f.schema()).toBe(29);
    expect(f.oldRead.all()).toHaveLength(1);
  });
  it('rechecks controller and writer authority after asynchronous integrity verification', async () => {
    const f = await fixture();
    const verify = integrity.verifyMigrationDatabaseIntegrity;
    vi.spyOn(integrity, 'verifyMigrationDatabaseIntegrity').mockImplementationOnce(
      async (sqlite) => {
        await verify(sqlite);
        f.advance(31_000);
      },
    );
    await expect(f.execute()).rejects.toThrow(/FENCE_EXPIRED/);
    expect(f.schema()).toBe(28);
    expect(imageRuntimeSchemaCommitted(f.sqlite)).toBe(false);
  });
  it('does not acknowledge a committed expansion using a fence that expired during the postcheck', async () => {
    const f = await fixture();
    const verify = integrity.verifyMigrationDatabaseIntegrity;
    vi.spyOn(integrity, 'verifyMigrationDatabaseIntegrity')
      .mockImplementationOnce(verify)
      .mockImplementationOnce(async (sqlite) => {
        await verify(sqlite);
        f.advance(31_000);
      });
    await expect(f.execute()).rejects.toThrow(/FENCE_EXPIRED/);
    expect(f.schema()).toBe(29);
    expect(imageRuntimeSchemaCommitted(f.sqlite)).toBe(true);
    expect(f.oldRead.all()).toHaveLength(1);
  });
  it('keeps HTTP and event-loop callbacks responsive during a real unrelated-history scan', async () => {
    const f = await fixture();
    f.sqlite.exec('CREATE TABLE unrelated_history(id INTEGER PRIMARY KEY,payload BLOB NOT NULL)');
    f.sqlite.transaction(() => {
      const insert = f.sqlite.prepare(
        'INSERT INTO unrelated_history(payload) VALUES(zeroblob(131072))',
      );
      for (let index = 0; index < 256; index++) insert.run();
    })();
    const server = createServer((_request, response) => response.end('healthy'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const address = server.address();
    if (!address || typeof address === 'string') throw Error('test-listener-missing');
    let finished = false;
    const pending = integrity.verifyMigrationDatabaseIntegrity(f.sqlite).then(() => {
      finished = true;
    });
    const response = await new Promise<string>((resolve, reject) => {
      get('http://127.0.0.1:' + address.port, (incoming) => {
        let body = '';
        incoming.setEncoding('utf8');
        incoming.on('data', (part: string) => (body += part));
        incoming.on('end', () => resolve(body));
      }).on('error', reject);
    });
    expect(response).toBe('healthy');
    expect(finished).toBe(false);
    await pending;
    expect(f.plan.policy.migrationBatchMs).toBe(500);
    expect(await f.execute()).toMatchObject({ complete: true, integrityValid: true });
  });
  it('fails closed on a real corrupt database worker without exporting database error details', async () => {
    const f = await fixture();
    const corrupt = join(f.directory, 'corrupt.db');
    await writeFile(corrupt, Buffer.alloc(8192, 0xff));
    await expect(
      integrity.verifyMigrationDatabaseIntegrity(stub<Database.Database>({ name: corrupt })),
    ).rejects.toMatchObject({ code: 'GLOBAL_SCHEMA_INTEGRITY_UNAVAILABLE' });
    await expect(
      integrity.verifyMigrationDatabaseIntegrity(
        stub<Database.Database>({
          name: join(f.directory, 'missing-private-path.db'),
        }),
      ),
    ).rejects.toMatchObject({
      code: 'GLOBAL_SCHEMA_INTEGRITY_UNAVAILABLE',
      message: 'GLOBAL_SCHEMA_INTEGRITY_UNAVAILABLE',
    });
    expect(f.schema()).toBe(28);
  });
  it('terminates an expired independent integrity worker instead of leaving a read transaction running', async () => {
    const f = await fixture();
    const realTimeout = globalThis.setTimeout;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const result = expect(
      integrity.verifyMigrationDatabaseIntegrity(f.sqlite),
    ).rejects.toMatchObject({ code: 'GLOBAL_SCHEMA_INTEGRITY_TIMEOUT' });
    for (let turn = 0; turn < 100 && vi.getTimerCount() === 0; turn++)
      await new Promise<void>((resolve) => realTimeout(resolve, 1));
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(20_000);
    await result;
    vi.useRealTimers();
    expect(f.schema()).toBe(28);
    expect(f.sqlite.pragma('quick_check', { simple: true })).toBe('ok');
  });
});
