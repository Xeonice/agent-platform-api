import 'reflect-metadata';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ConfirmedServiceReleaseSchema,
  UpgradeManifestSchema,
  type SignedUpgradeManifest,
} from '@platform/contracts';
import { fromEpochMs, type Clock } from '@platform/shared-kernel';
import {
  createConnection,
  runMigrations,
} from '../../../apps/api/src/platform/persistence/drizzle.connection';
import { fenceCoordinatorConnection } from '../../../apps/api/src/platform/persistence/coordinator-lease';
import { SqliteUnitOfWork } from '../../../apps/api/src/platform/persistence/unit-of-work.impl';
import { UpgradeStore } from '../../../apps/api/src/platform/upgrade/upgrade-store';
import {
  UpgradeOnlineMigration,
  OnlineMigrationPlanSchema,
} from '../../../apps/api/src/platform/upgrade/upgrade-online-migration';
import {
  canonicalUpgrade,
  freezeUpgradePlan,
  upgradeDigest,
} from '../../../apps/api/src/platform/upgrade/upgrade-trust';
import { useEnv } from '../../support/strict-ports';

// Real committed SQLite schema, writer/controller fences, actual immutable plan
// file/digest and production transaction hook. Package-verification receipts are
// explicit state-layer setup; this does not qualify a release or a native runtime.
const key = generateKeyPairSync('ed25519');
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
async function fixture(
  options: {
    maxWalBytes?: number;
    minFreeBytes?: number;
    migrationBatchMs?: number;
    rows?: number;
    leaseMs?: number;
    globalSchemaIncrement?: number;
    planPatch?: Record<string, unknown>;
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), 'upg-online-migration-'));
  const restore = useEnv({
    PLATFORM_INSTANCE_ID: 'online-migration-sqlite-fixture',
    UPGRADE_INSTALLER_ROOT: directory,
    COORDINATOR_GENERATION: undefined,
    COORDINATOR_WRITER_FENCE_VALID: undefined,
  });
  let now = Date.parse('2026-10-12T00:00:00Z');
  const clock: Clock = { now: () => fromEpochMs(now) };
  const connection = createConnection(join(directory, 'platform.db'));
  runMigrations(connection.db, connection.sqlite);
  const sqlite = fenceCoordinatorConnection(
    connection.sqlite,
    'online-migration-sqlite-fixture',
    clock,
    { next: () => randomUUID() },
  );
  cleanup.push(async () => {
    sqlite.close();
    restore();
    await rm(directory, { recursive: true, force: true });
  });
  const uow = new SqliteUnitOfWork(sqlite);
  sqlite.exec(
    'CREATE TABLE fixture_items(item_id TEXT PRIMARY KEY NOT NULL,value TEXT NOT NULL,count INTEGER NOT NULL,payload BLOB)',
  );
  const insert = sqlite.prepare('INSERT INTO fixture_items VALUES(?,?,?,?)');
  for (let i = 0; i < (options.rows ?? 3); i++)
    insert.run(String(i).padStart(5, '0'), `value-${i}`, i, Buffer.from([0, i % 256, 255]));
  const schema = (
    sqlite.prepare('SELECT count(*) AS n FROM __drizzle_migrations').get() as { n: number }
  ).n;
  const artifact = {
    artifactDigest: upgradeDigest({ scope: 'migration-state-fixture' }),
    inputFingerprint: upgradeDigest({ scope: 'input-fixture' }),
    sourceRevision: 'a'.repeat(40),
    protocol: { min: 1, max: 2 },
  };
  const current = ConfirmedServiceReleaseSchema.parse({
    releaseId: '0.2.0',
    activationGeneration: 1,
    activatedAt: clock.now().toISOString(),
    schema,
    channel: 'migration-state-only',
    components: {
      api: artifact,
      web: { ...artifact, webRevision: 'a'.repeat(40) },
      coordinator: artifact,
      installer: artifact,
    },
    commits: { project: 'a'.repeat(40), api: 'a'.repeat(40), web: 'a'.repeat(40) },
    productionWebBinding: 'http://127.0.0.1/state-fixture',
  });
  const store = new UpgradeStore(sqlite, clock, { next: () => randomUUID() });
  store.bootstrap(current);
  const migration = {
    schemaVersion: 1,
    kind: 'expand-shadow',
    fromSchema: schema,
    targetSchema: schema + (options.globalSchemaIncrement ?? 0),
    maxBatchRows: options.rows && options.rows > 100 ? 1000 : 2,
    oldRepresentationRetained: true,
    newSemanticsEnabled: false,
    projections: [
      {
        sourceTable: 'fixture_items',
        primaryKey: 'item_id',
        targetTable: 'upg_shadow_fixture_items',
        fields: [
          { name: 'renamed_value', type: 'text', source: 'value' },
          { name: 'count', type: 'integer', source: 'count' },
          { name: 'payload', type: 'blob', source: 'payload' },
          { name: 'bridge_marker', type: 'text', default: 'old-and-new-compatible' },
        ],
      },
    ],
    ...options.planPatch,
  };
  const migrationDigest = upgradeDigest(migration);
  const bytes = Buffer.from(canonicalUpgrade(migration));
  // The migration artifact bytes really exist at the fixed package-digest path.
  // Archive extraction/signature qualification are tested at their own boundary.
  const artifactRoot = join(directory, 'artifacts', migrationDigest.slice(7));
  await mkdir(artifactRoot, { recursive: true });
  const file = join(artifactRoot, 'upgrade-migration.json');
  await writeFile(file, bytes, { mode: 0o600 });
  const manifest = UpgradeManifestSchema.parse({
    schemaVersion: 2,
    releaseId: '0.2.1',
    channel: current.channel,
    publishedAt: clock.now().toISOString(),
    components: current.components,
    commits: current.commits,
    packages: [
      {
        platform: process.platform,
        arch: process.arch,
        name: 'migration-state-fixture',
        url: 'https://migration.invalid/fixture.tar',
        digest: migrationDigest,
        bytes: bytes.length,
        format: 'native-tar',
      },
    ],
    upgradePaths: [
      {
        fromRelease: current.releaseId,
        minSchema: schema,
        maxSchema: schema,
        targetSchema: schema,
        bridgeReleases: [],
        migrationPlanDigest: migrationDigest,
      },
    ],
    policy: {
      id: 'migration-state-only',
      weights: [1, 5, 25, 100],
      stageDurationMs: 60_000,
      minRequests: 100,
      observationFreshnessMs: 5000,
      probeHz: 10,
      requestDeadlineMs: 2000,
      attachDeadlineMs: 5000,
      softErrorDelta: 0.01,
      p95Ratio: 2,
      p95FloorMs: 1000,
      evaluationIntervalMs: 10_000,
      consecutiveEvaluations: 2,
      retentionMs: 60_000,
      migrationBatchMs: options.migrationBatchMs ?? 500,
      maxWalBytes: options.maxWalBytes ?? 64 * 1024 * 1024,
      minFreeBytes: options.minFreeBytes ?? 1,
      fallbacks: [
        {
          releaseId: current.releaseId,
          apiDigest: artifact.artifactDigest,
          webDigest: artifact.artifactDigest,
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
    signature: {
      algorithm: 'Ed25519',
      keyId: 'state-layer-only',
      value: sign(null, Buffer.from(canonicalUpgrade(manifest)), key.privateKey).toString('base64'),
    },
  };
  const plan = freezeUpgradePlan(envelope, current);
  const attempt = store.accept(
    'migration-state-test-actor',
    {
      requestId: randomUUID(),
      targetReleaseId: manifest.releaseId,
      targetDigest: envelope.manifestDigest,
      expectedActivationGeneration: 1,
    },
    envelope,
    plan,
  );
  const claim = store.claim(
    attempt.attemptId,
    'migration-state-controller',
    options.leaseMs ?? 30_000,
  );
  for (const step of plan.steps.filter((s) => s.kind === 'download' || s.kind === 'verify')) {
    const evidence = { scope: 'state-layer-package-precondition-only', step: step.stepId };
    store.commit(attempt.attemptId, {
      fence: claim.fence,
      generation: claim.generation,
      expectedSequence: store.attempt(attempt.attemptId).sequence,
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
  const runner = new UpgradeOnlineMigration(store);
  runner.onApplicationBootstrap();
  const execute = (
    action = 'prepare',
    checkpoint?: unknown,
    operationId = randomUUID(),
    fence = store.snapshot(attempt.attemptId).fence,
  ) =>
    runner.execute(attempt.attemptId, {
      action,
      operationId,
      planDigest: migrationDigest,
      fence,
      ...(checkpoint === undefined ? {} : { checkpoint }),
    });
  const complete = async () => {
    let result = await execute();
    for (let i = 0; result.complete !== true && i < 100; i++)
      result = await execute('batch', result.checkpoint);
    expect(result.complete).toBe(true);
    return result;
  };
  const structures = () =>
    sqlite.prepare("SELECT name FROM sqlite_master WHERE name='upg_shadow_fixture_items'").all();
  return {
    sqlite,
    // Corruption is injected outside the guarded application connection.
    breakOutbox: () => connection.sqlite.exec('DROP TABLE upgrade_projection_changes'),
    uow,
    store,
    runner,
    plan,
    migration,
    migrationDigest,
    file,
    id: attempt.attemptId,
    execute,
    complete,
    structures,
    advance: (ms: number) => {
      now += ms;
    },
    schema,
  };
}

describe('REQ-UPG-006/007/008 — actual online expand/bridge projection, transaction and budgets', () => {
  it('rejects a package claiming an unqualified global schema increment before any projection DDL or journal change', async () => {
    // The frozen accepted path remains the actual journal version. Neither a
    // signed package field nor a new representation read epoch can raise it.
    const f = await fixture({ globalSchemaIncrement: 1 });
    const structures = f.sqlite
      .prepare('SELECT type,name,sql FROM sqlite_master ORDER BY type,name')
      .all();
    const journal = f.sqlite.prepare('SELECT * FROM __drizzle_migrations').all();
    await expect(f.execute()).rejects.toThrow('MIGRATION_PLAN_CHANGED');
    expect(f.structures()).toEqual([]);
    expect(
      f.sqlite.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY type,name').all(),
    ).toEqual(structures);
    expect(f.sqlite.prepare('SELECT * FROM __drizzle_migrations').all()).toEqual(journal);
    expect(f.sqlite.prepare('SELECT count(*) AS n FROM fixture_items').get()).toEqual({ n: 3 });
    expect(f.runner.schema()).toBe(f.schema);
    expect(f.store.attempt(f.id).percent).toBeNull();
  });
  it.each(['wrong-existing-value', 'extra-live-row'])(
    'reconciliation detects %s instead of overwriting its own evidence and claiming healthy new reads',
    async (fault) => {
      const f = await fixture();
      let result = await f.execute();
      for (let i = 0; i < 20; i++) {
        const checkpoint = result.checkpoint;
        if (
          checkpoint &&
          typeof checkpoint === 'object' &&
          'phase' in checkpoint &&
          checkpoint.phase === 'reconcile'
        )
          break;
        result = await f.execute('batch', checkpoint);
      }
      if (fault === 'wrong-existing-value')
        f.sqlite
          .prepare('UPDATE upg_shadow_fixture_items SET renamed_value=? WHERE row_key=?')
          .run('unlogged incorrect new representation', '00000');
      else
        f.sqlite
          .prepare(
            'INSERT INTO upg_shadow_fixture_items(row_key,row_revision,tombstone,renamed_value,count) VALUES(?,?,?,?,?)',
          )
          .run('phantom-shadow-row', 0, 0, 'no original authority row', 9);
      let failure: unknown;
      for (let i = 0; i < 20 && result.complete !== true; i++) {
        try {
          result = await f.execute('batch', result.checkpoint);
        } catch (error) {
          failure = error;
          break;
        }
      }
      expect(failure).toBeInstanceOf(Error);
      expect(failure instanceof Error ? failure.message : '').toContain('MIGRATION_');
      expect(f.runner.metrics(f.id).readEpoch).toBe(0);
      expect(f.runner.schema()).toBe(f.schema);
      if (fault === 'wrong-existing-value')
        expect(
          f.sqlite
            .prepare('SELECT renamed_value FROM upg_shadow_fixture_items WHERE row_key=?')
            .get('00000'),
        ).toEqual({ renamed_value: 'unlogged incorrect new representation' });
      else
        expect(
          f.sqlite
            .prepare('SELECT tombstone FROM upg_shadow_fixture_items WHERE row_key=?')
            .get('phantom-shadow-row'),
        ).toEqual({ tombstone: 0 });
      expect(f.sqlite.prepare('SELECT count(*) AS n FROM fixture_items').get()).toEqual({ n: 3 });
    },
  );
  it('backfills bounded checkpoints while real original inserts, updates and deletes preserve dual representation and tombstones', async () => {
    const f = await fixture();
    let result = await f.execute();
    f.uow.run(() =>
      f.sqlite
        .prepare('UPDATE fixture_items SET value=?,count=? WHERE item_id=?')
        .run('updated after backfill', 9, '00000'),
    );
    f.uow.run(() => f.sqlite.prepare('DELETE FROM fixture_items WHERE item_id=?').run('00001'));
    f.uow.run(() =>
      f.sqlite
        .prepare('INSERT INTO fixture_items VALUES(?,?,?,?)')
        .run('00003', 'new while upgrading', 3, Buffer.from([255, 0])),
    );
    for (let i = 0; result.complete !== true && i < 100; i++)
      result = await f.execute('batch', result.checkpoint);
    expect(result).toMatchObject({
      complete: true,
      integrityValid: true,
      oldRepresentationRetained: true,
      newSemanticsEnabled: false,
      schema: f.schema,
    });
    expect(f.runner.metrics(f.id)).toMatchObject({
      known: true,
      differences: 0,
      readEpoch: 1,
      degraded: false,
    });
    expect(
      f.sqlite.prepare('SELECT item_id,value,count FROM fixture_items ORDER BY item_id').all(),
    ).toEqual([
      { item_id: '00000', value: 'updated after backfill', count: 9 },
      { item_id: '00002', value: 'value-2', count: 2 },
      { item_id: '00003', value: 'new while upgrading', count: 3 },
    ]);
    const shadow = f.sqlite
      .prepare(
        'SELECT row_key,renamed_value,count,tombstone,payload FROM upg_shadow_fixture_items ORDER BY row_key',
      )
      .all();
    expect(shadow).toEqual([
      {
        row_key: '00000',
        renamed_value: 'updated after backfill',
        count: 9,
        tombstone: 0,
        payload: Buffer.from([0, 0, 255]),
      },
      { row_key: '00001', renamed_value: null, count: null, tombstone: 1, payload: null },
      {
        row_key: '00002',
        renamed_value: 'value-2',
        count: 2,
        tombstone: 0,
        payload: Buffer.from([0, 2, 255]),
      },
      {
        row_key: '00003',
        renamed_value: 'new while upgrading',
        count: 3,
        tombstone: 0,
        payload: Buffer.from([255, 0]),
      },
    ]);
    expect(
      f.sqlite
        .prepare('SELECT count(*) AS n FROM upgrade_projection_changes WHERE projected=0')
        .get(),
    ).toEqual({ n: 0 });
    expect(f.store.confirmed()?.schema).toBe(f.schema);
    expect(f.store.attempt(f.id).percent).toBeNull();
  });

  it('lost batch acknowledgement returns the identical retained operation/checkpoint without doing work twice', async () => {
    const f = await fixture();
    const before = await f.execute();
    const operationId = randomUUID();
    const result = await f.execute('batch', before.checkpoint, operationId);
    const work = f.sqlite
      .prepare('SELECT completed_work,checkpoint FROM upgrade_online_migrations')
      .all();
    expect(await f.execute('batch', before.checkpoint, operationId)).toEqual(result);
    expect(
      f.sqlite.prepare('SELECT completed_work,checkpoint FROM upgrade_online_migrations').all(),
    ).toEqual(work);
    await expect(f.execute('batch', result.checkpoint, operationId)).rejects.toThrow(
      'MIGRATION_OPERATION_CONFLICT',
    );
    await expect(f.execute('batch', before.checkpoint)).rejects.toThrow(
      'MIGRATION_CHECKPOINT_CONFLICT',
    );
    expect(
      f.sqlite.prepare('SELECT completed_work,checkpoint FROM upgrade_online_migrations').all(),
    ).toEqual(work);
  });

  it('a missing shadow isolates only new projection/read epoch while original writes and durable outbox commit together', async () => {
    const f = await fixture();
    await f.complete();
    f.sqlite.exec('DROP TABLE upg_shadow_fixture_items');
    f.uow.run(() =>
      f.sqlite
        .prepare('UPDATE fixture_items SET value=? WHERE item_id=?')
        .run('authority write survives shadow loss', '00000'),
    );
    expect(
      f.sqlite.prepare('SELECT value FROM fixture_items WHERE item_id=?').get('00000'),
    ).toEqual({ value: 'authority write survives shadow loss' });
    expect(
      f.sqlite
        .prepare('SELECT row_key,projected FROM upgrade_projection_changes ORDER BY id')
        .all(),
    ).toEqual([{ row_key: '00000', projected: 0 }]);
    expect(f.runner.metrics(f.id)).toMatchObject({
      readEpoch: 0,
      degraded: true,
      oldRepresentationRetained: true,
      differences: 2,
    });
    const status = await f.execute('status');
    await f.execute('repair', status.checkpoint);
    let result = await f.execute('status');
    for (let i = 0; result.complete !== true && i < 100; i++)
      result = await f.execute('batch', result.checkpoint);
    expect(result.complete).toBe(true);
    expect(
      f.sqlite
        .prepare('SELECT renamed_value FROM upg_shadow_fixture_items WHERE row_key=?')
        .get('00000'),
    ).toEqual({ renamed_value: 'authority write survives shadow loss' });
    expect(f.runner.metrics(f.id)).toMatchObject({ readEpoch: 1, degraded: false, differences: 0 });
  });

  it('a broken outbox cannot report a successful original business transaction or silently lose a change', async () => {
    const f = await fixture();
    await f.complete();
    const original = f.sqlite
      .prepare('SELECT value FROM fixture_items WHERE item_id=?')
      .get('00000');
    expect(() => f.sqlite.exec('DROP TABLE upgrade_projection_changes')).toThrow('no such table');
    expect(
      f.sqlite.prepare("SELECT 1 FROM sqlite_master WHERE name='upgrade_projection_changes'").get(),
    ).toBeDefined();
    f.breakOutbox();
    expect(() =>
      f.uow.run(() =>
        f.sqlite
          .prepare('UPDATE fixture_items SET value=? WHERE item_id=?')
          .run('must roll back', '00000'),
      ),
    ).toThrow('no such table');
    expect(
      f.sqlite.prepare('SELECT value FROM fixture_items WHERE item_id=?').get('00000'),
    ).toEqual(original);
    expect(
      f.sqlite
        .prepare('SELECT renamed_value FROM upg_shadow_fixture_items WHERE row_key=?')
        .get('00000'),
    ).toEqual({ renamed_value: 'value-0' });
    expect(f.sqlite.pragma('quick_check', { simple: true })).toBe('ok');
  });

  it('exactly a full small batch of original writes is healthy once all durable changes were projected', async () => {
    const f = await fixture();
    await f.complete();
    f.uow.run(() => {
      f.sqlite.prepare('UPDATE fixture_items SET value=? WHERE item_id=?').run('first', '00000');
      f.sqlite.prepare('UPDATE fixture_items SET value=? WHERE item_id=?').run('second', '00002');
    });
    expect(
      f.sqlite
        .prepare('SELECT count(*) AS n FROM upgrade_projection_changes WHERE projected=0')
        .get(),
    ).toEqual({ n: 0 });
    expect(f.runner.metrics(f.id)).toMatchObject({ readEpoch: 1, degraded: false, differences: 0 });
  });

  it.each([
    { maxWalBytes: 1, code: 'MIGRATION_WAL_BUDGET' },
    { minFreeBytes: Number.MAX_SAFE_INTEGER, code: 'MIGRATION_DISK_BUDGET' },
  ])(
    'checks $code before creating shadow tables/triggers or committing a migration start',
    async ({ code, ...budget }) => {
      const f = await fixture(budget);
      await expect(f.execute()).rejects.toThrow(code);
      expect(f.structures()).toEqual([]);
      expect(f.sqlite.prepare('SELECT count(*) AS n FROM upgrade_online_migrations').get()).toEqual(
        { n: 0 },
      );
      expect(f.sqlite.prepare('SELECT count(*) AS n FROM fixture_items').get()).toEqual({ n: 3 });
    },
  );

  it('an expired controller after actual async plan reads cannot create migration structures under its old fence', async () => {
    const f = await fixture({ leaseMs: 500 });
    const pending = f.execute();
    f.advance(501);
    await expect(pending).rejects.toThrow('UPGRADE_FENCE_EXPIRED');
    expect(f.structures()).toEqual([]);
    expect(f.sqlite.prepare('SELECT count(*) AS n FROM upgrade_online_migrations').get()).toEqual({
      n: 0,
    });
  });

  it('batch time budget rollback keeps the original rows and initial cursor without a false completion receipt', async () => {
    const f = await fixture({ rows: 1000, migrationBatchMs: 1 });
    await expect(f.execute()).rejects.toThrow('MIGRATION_BATCH_BUDGET_EXCEEDED');
    expect(f.sqlite.prepare('SELECT count(*) AS n FROM fixture_items').get()).toEqual({ n: 1000 });
    expect(f.sqlite.prepare('SELECT count(*) AS n FROM upg_shadow_fixture_items').get()).toEqual({
      n: 0,
    });
    expect(
      f.sqlite.prepare('SELECT completed_work,read_epoch FROM upgrade_online_migrations').get(),
    ).toEqual({ completed_work: 0, read_epoch: 0 });
    expect(
      f.sqlite.prepare('SELECT count(*) AS n FROM upgrade_migration_operations').get(),
    ).toEqual({ n: 0 });
  });

  it('fixed plan tampering and insecure actual file permissions are rejected before authority writes', async () => {
    const f = await fixture();
    await writeFile(f.file, canonicalUpgrade({ ...f.migration, maxBatchRows: 3 }));
    await expect(f.execute()).rejects.toThrow('MIGRATION_PLAN_CHANGED');
    await writeFile(f.file, canonicalUpgrade(f.migration));
    await chmod(f.file, 0o666);
    await expect(f.execute()).rejects.toThrow('INSECURE_MIGRATION_PLAN');
    expect(f.structures()).toEqual([]);
  });

  it.each([
    { sql: 'DROP TABLE fixture_items' },
    { oldRepresentationRetained: false },
    { newSemanticsEnabled: true },
    { restoreLiveVolume: true },
  ])(
    'rejects destructive SQL/whole-volume/new-semantics commands rather than pretending a compatible migration',
    async (planPatch) => {
      const f = await fixture({ planPatch });
      expect(OnlineMigrationPlanSchema.safeParse(f.migration).success).toBe(false);
      await expect(f.execute()).rejects.toThrow();
      expect(f.structures()).toEqual([]);
      expect(f.sqlite.prepare('SELECT count(*) AS n FROM fixture_items').get()).toEqual({ n: 3 });
    },
  );
});
