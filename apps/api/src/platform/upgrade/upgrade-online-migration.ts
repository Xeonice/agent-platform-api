import { Inject, Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { readFile, statfs, lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { CLOCK, type Clock } from '@platform/shared-kernel';
import { SystemClock } from '../time/system-clock';
import { UpgradeStore } from './upgrade-store';
import { canonicalUpgrade, requireUpgrade, upgradeDigest } from './upgrade-trust';
import { registerBusinessTransactionHook } from '../persistence/business-transaction-hooks';

const Identifier = z.string().regex(/^[a-z][a-z0-9_]{0,80}$/);
const Field = z
  .object({
    name: Identifier,
    type: z.enum(['text', 'integer', 'real', 'blob']),
    source: Identifier.optional(),
    default: z.union([z.string(), z.number().finite(), z.boolean(), z.null()]).optional(),
  })
  .strict();
/** Declarative expand/bridge only. No arbitrary SQL, destructive DDL or browser commands. */
export const OnlineMigrationPlanSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal('expand-shadow'),
    fromSchema: z.number().int().nonnegative(),
    targetSchema: z.number().int().nonnegative(),
    maxBatchRows: z.number().int().min(1).max(1000),
    oldRepresentationRetained: z.literal(true),
    newSemanticsEnabled: z.literal(false),
    projections: z
      .array(
        z
          .object({
            sourceTable: Identifier,
            primaryKey: Identifier,
            targetTable: Identifier.refine((v) => v.startsWith('upg_shadow_')),
            fields: z.array(Field).min(1).max(100),
          })
          .strict(),
      )
      .min(1)
      .max(32),
  })
  .strict();
type Plan = z.infer<typeof OnlineMigrationPlanSchema>;
type Json = Record<string, unknown>;
interface Row {
  plan_digest: string;
  attempt_id: string;
  plan: string;
  stage: string;
  checkpoint: string;
  completed_work: number;
  read_epoch: number;
  degraded: number;
  reason: string | null;
}
const q = (v: string) => '"' + v.replaceAll('"', '""') + '"';
const sqlValue = (v: unknown): string =>
  v === null
    ? 'NULL'
    : typeof v === 'number'
      ? String(v)
      : typeof v === 'boolean'
        ? String(Number(v))
        : "'" + String(v).replaceAll("'", "''") + "'";

@Injectable()
export class UpgradeOnlineMigration implements OnApplicationBootstrap {
  private projecting = false;
  constructor(
    private readonly store: UpgradeStore,
    @Inject(CLOCK) private readonly clock: Clock = new SystemClock(),
  ) {}
  onApplicationBootstrap(): void {
    registerBusinessTransactionHook(this.store.sqlite, () => this.projectCommittedChanges());
  }
  schema(): number {
    const count = (
      this.store.sqlite.prepare('SELECT count(*) n FROM __drizzle_migrations').get() as {
        n: number;
      }
    ).n;
    const exists = this.store.sqlite
      .prepare("SELECT 1 FROM sqlite_master WHERE name='upgrade_schema_epochs'")
      .get();
    if (!exists) return count;
    return Math.max(
      count,
      Number(
        (
          this.store.sqlite
            .prepare('SELECT schema_version FROM upgrade_schema_epochs WHERE singleton=1')
            .get() as { schema_version: number } | undefined
        )?.schema_version ?? 0,
      ),
    );
  }
  private row(digest: string): Row | undefined {
    return this.store.sqlite
      .prepare('SELECT * FROM upgrade_online_migrations WHERE plan_digest=?')
      .get(digest) as Row | undefined;
  }
  private plan(row: Row): Plan {
    const plan = OnlineMigrationPlanSchema.parse(JSON.parse(row.plan));
    requireUpgrade(upgradeDigest(plan) === row.plan_digest, 'MIGRATION_PLAN_CORRUPT');
    return plan;
  }
  private validate(plan: Plan): void {
    const targets = new Set<string>();
    for (const projection of plan.projections) {
      requireUpgrade(
        !projection.sourceTable.startsWith('upgrade_') &&
          !projection.sourceTable.startsWith('upg_shadow_') &&
          !projection.sourceTable.startsWith('platform_'),
        'MIGRATION_SOURCE_FORBIDDEN',
      );
      requireUpgrade(!targets.has(projection.targetTable), 'DUPLICATE_PROJECTION');
      targets.add(projection.targetTable);
      const columns = this.store.sqlite
        .prepare('PRAGMA table_info(' + q(projection.sourceTable) + ')')
        .all() as Json[];
      requireUpgrade(
        columns.filter((c) => Number(c.pk) > 0).length === 1 &&
          columns.some((c) => c.name === projection.primaryKey && Number(c.pk) === 1),
        'SINGLE_PRIMARY_KEY_REQUIRED',
      );
      const names = new Set<string>();
      for (const field of projection.fields) {
        requireUpgrade(
          !['row_key', 'row_revision', 'tombstone'].includes(field.name) && !names.has(field.name),
          'PROJECTION_FIELD_CONFLICT',
        );
        names.add(field.name);
        requireUpgrade(
          Boolean(field.source) !== (field.default !== undefined),
          'PROJECTION_MAPPING_REQUIRED',
        );
        if (field.source)
          requireUpgrade(
            columns.some((c) => c.name === field.source),
            'PROJECTION_SOURCE_UNKNOWN',
          );
      }
    }
  }
  private structures(plan: Plan, digest: string): void {
    for (const p of plan.projections) {
      this.store.sqlite.exec(
        'CREATE TABLE IF NOT EXISTS ' +
          q(p.targetTable) +
          '(row_key TEXT PRIMARY KEY NOT NULL,row_revision INTEGER NOT NULL,tombstone INTEGER NOT NULL,' +
          p.fields.map((f) => q(f.name) + ' ' + f.type.toUpperCase()).join(',') +
          ')',
      );
      const columns = this.store.sqlite
        .prepare('PRAGMA table_info(' + q(p.sourceTable) + ')')
        .all() as Json[];
      const json = columns
        .flatMap((c) => [
          sqlValue(c.name),
          String(c.type).toUpperCase().includes('BLOB')
            ? 'CASE WHEN NEW.' +
              q(String(c.name)) +
              ' IS NULL THEN NULL ELSE hex(NEW.' +
              q(String(c.name)) +
              ') END'
            : 'NEW.' + q(String(c.name)),
        ])
        .join(',');
      for (const event of ['INSERT', 'UPDATE', 'DELETE']) {
        const name =
          'upg_change_' + digest.slice(7, 23) + '_' + p.sourceTable + '_' + event.toLowerCase();
        this.store.sqlite.exec(
          'CREATE TRIGGER IF NOT EXISTS ' +
            q(name) +
            ' AFTER ' +
            event +
            ' ON ' +
            q(p.sourceTable) +
            ' BEGIN INSERT INTO upgrade_projection_changes(plan_digest,projection,row_key,payload,tombstone) VALUES(' +
            sqlValue(digest) +
            ',' +
            sqlValue(p.targetTable) +
            ',CAST(' +
            (event === 'DELETE' ? 'OLD.' : 'NEW.') +
            q(p.primaryKey) +
            ' AS TEXT),' +
            (event === 'DELETE' ? 'NULL' : 'json_object(' + json + ')') +
            ',' +
            Number(event === 'DELETE') +
            '); END',
        );
      }
    }
  }
  private projected(p: Plan['projections'][number], payload: string | null): unknown[] {
    const object = payload ? (JSON.parse(payload) as Json) : {};
    return p.fields.map((f) => {
      const value = f.source ? object[f.source] : f.default;
      if (value == null) return null;
      if (f.type === 'blob') {
        requireUpgrade(
          typeof value === 'string' && /^(?:[a-fA-F0-9]{2})*$/.test(value),
          'SHADOW_VALUE_INVALID',
        );
        return Buffer.from(value, 'hex');
      }
      if (f.type === 'text') return String(value);
      const number = Number(value);
      requireUpgrade(
        Number.isFinite(number) && (f.type !== 'integer' || Number.isSafeInteger(number)),
        'SHADOW_VALUE_INVALID',
      );
      return number;
    });
  }
  private apply(
    _plan: Plan,
    p: Plan['projections'][number],
    key: string,
    revision: number,
    payload: string | null,
    tombstone: number,
  ): void {
    const fields = ['row_key', 'row_revision', 'tombstone', ...p.fields.map((f) => f.name)];
    const values = [key, revision, tombstone, ...this.projected(p, payload)];
    this.store.sqlite
      .prepare(
        'INSERT INTO ' +
          q(p.targetTable) +
          '(' +
          fields.map(q).join(',') +
          ') VALUES(' +
          fields.map(() => '?').join(',') +
          ') ON CONFLICT(row_key) DO UPDATE SET ' +
          fields
            .slice(1)
            .map((f) => q(f) + '=excluded.' + q(f))
            .join(',') +
          ' WHERE excluded.row_revision>=' +
          q(p.targetTable) +
          '.row_revision',
      )
      .run(...values);
  }
  /** Outbox creation is part of the authority write. Pure shadow failure may isolate the projection, never the authority/outbox commit. */
  private projectCommittedChanges(): void {
    if (this.projecting) return;
    this.projecting = true;
    try {
      const rows = this.store.sqlite
        .prepare("SELECT * FROM upgrade_online_migrations WHERE stage NOT IN ('contracted')")
        .all() as Row[];
      for (const row of rows) {
        const plan = this.plan(row);
        const changes = this.store.sqlite
          .prepare(
            'SELECT * FROM upgrade_projection_changes WHERE plan_digest=? AND projected=0 ORDER BY id LIMIT ?',
          )
          .all(row.plan_digest, plan.maxBatchRows) as Json[];
        if (!changes.length) continue;
        this.store.sqlite.exec('SAVEPOINT upg_projection');
        try {
          for (const c of changes) {
            const projection = plan.projections.find((p) => p.targetTable === c.projection);
            requireUpgrade(projection, 'SHADOW_MAPPING_UNKNOWN');
            this.apply(
              plan,
              projection,
              String(c.row_key),
              Number(c.id),
              c.payload as string | null,
              Number(c.tombstone),
            );
            this.store.sqlite
              .prepare('UPDATE upgrade_projection_changes SET projected=1 WHERE id=?')
              .run(c.id);
          }
          this.store.sqlite.exec('RELEASE upg_projection');
          const pending = (
            this.store.sqlite
              .prepare(
                'SELECT count(*) n FROM upgrade_projection_changes WHERE plan_digest=? AND projected=0',
              )
              .get(row.plan_digest) as { n: number }
          ).n;
          if (pending > 0) {
            this.store.sqlite
              .prepare(
                "UPDATE upgrade_online_migrations SET read_epoch=0,degraded=1,reason='PROJECTION_BACKLOG' WHERE plan_digest=?",
              )
              .run(row.plan_digest);
          }
        } catch (error) {
          this.store.sqlite.exec('ROLLBACK TO upg_projection');
          this.store.sqlite.exec('RELEASE upg_projection');
          const code =
            error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
          const isolated = [
            'SQLITE_ERROR',
            'SQLITE_CONSTRAINT',
            'SHADOW_VALUE_INVALID',
            'SHADOW_MAPPING_UNKNOWN',
          ].some((c) => code.startsWith(c));
          if (!isolated) throw error;
          // Only this safe expand bridge can degrade. No irreversible semantics
          // are enabled, old rows and the durable pending changes remain intact.
          this.store.sqlite
            .prepare(
              'UPDATE upgrade_online_migrations SET read_epoch=0,degraded=1,reason=? WHERE plan_digest=?',
            )
            .run('SHADOW_PROJECTION_ISOLATED', row.plan_digest);
        }
      }
    } finally {
      this.projecting = false;
    }
  }
  metrics(id: string): {
    known: boolean;
    differences: number;
    oldRepresentationRetained: boolean;
    readEpoch: number;
    degraded: boolean;
  } {
    const row = this.store.sqlite
      .prepare('SELECT * FROM upgrade_online_migrations WHERE attempt_id=?')
      .get(id) as Row | undefined;
    if (!row)
      return {
        known: false,
        differences: 0,
        oldRepresentationRetained: false,
        readEpoch: 0,
        degraded: false,
      };
    const pending = (
      this.store.sqlite
        .prepare(
          'SELECT count(*) n FROM upgrade_projection_changes WHERE plan_digest=? AND projected=0',
        )
        .get(row.plan_digest) as { n: number }
    ).n;
    return {
      known: true,
      differences: pending + Number(row.degraded !== 0),
      oldRepresentationRetained: this.plan(row).oldRepresentationRetained,
      readEpoch: row.read_epoch,
      degraded: row.degraded !== 0,
    };
  }
  async execute(id: string, input: Json): Promise<Json> {
    const fence = Number(input.fence);
    this.store.assertControllerFence(id, fence);
    const snapshot = this.store.snapshot(id),
      digest = snapshot.plan.migrationPath.migrationPlanDigest;
    requireUpgrade(
      digest &&
        input.planDigest === digest &&
        typeof input.operationId === 'string' &&
        ['prepare', 'batch', 'status', 'repair'].includes(String(input.action)),
      'FIXED_MIGRATION_COMMAND_REQUIRED',
    );
    const requestDigest = upgradeDigest({
      attemptId: id,
      action: input.action,
      planDigest: digest,
      checkpoint: input.checkpoint ?? null,
    });
    const prior = this.store.sqlite
      .prepare(
        'SELECT request_digest,result FROM upgrade_migration_operations WHERE operation_id=?',
      )
      .get(input.operationId) as { request_digest: string; result: string } | undefined;
    if (prior) {
      requireUpgrade(prior.request_digest === requestDigest, 'MIGRATION_OPERATION_CONFLICT');
      return JSON.parse(prior.result) as Json;
    }
    let row = this.row(digest);
    if (input.action === 'status')
      return row
        ? {
            commitKnown: true,
            checkpoint: JSON.parse(row.checkpoint),
            completedWork: row.completed_work,
            complete: row.stage === 'complete',
            integrityValid: this.store.sqlite.pragma('quick_check', { simple: true }) === 'ok',
            budgetExceeded: false,
            metrics: this.metrics(id),
          }
        : { definitelyNotApplied: true };
    const root = process.env.UPGRADE_INSTALLER_ROOT;
    requireUpgrade(root, 'INSTALLER_ROOT_REQUIRED');
    const policy = snapshot.plan.policy;
    const fs = await statfs(root);
    requireUpgrade(
      Number(fs.bavail) * Number(fs.bsize) >= policy.minFreeBytes,
      'MIGRATION_DISK_BUDGET',
    );
    const wal = await lstat(this.store.sqlite.name + '-wal').catch(() => null);
    requireUpgrade((wal?.size ?? 0) <= policy.maxWalBytes, 'MIGRATION_WAL_BUDGET');
    if (!row) {
      requireUpgrade(
        input.action === 'prepare' && this.store.step(id, 'package-verify').applied,
        'MIGRATION_PACKAGE_NOT_VERIFIED',
      );
      const path = resolve(
        join(root, 'artifacts', snapshot.plan.package.digest.slice(7), 'upgrade-migration.json'),
      );
      const s = await lstat(path);
      requireUpgrade(
        s.isFile() && !s.isSymbolicLink() && (s.mode & 0o022) === 0,
        'INSECURE_MIGRATION_PLAN',
      );
      const plan = OnlineMigrationPlanSchema.parse(JSON.parse(await readFile(path, 'utf8')));
      requireUpgrade(
        upgradeDigest(plan) === digest &&
          plan.targetSchema === snapshot.plan.migrationPath.targetSchema &&
          plan.fromSchema === this.schema(),
        'MIGRATION_PLAN_CHANGED',
      );
      this.validate(plan);
      this.store.sqlite
        .transaction(() => {
          this.store.assertControllerFence(id, fence);
          this.structures(plan, digest);
          this.store.sqlite
            .prepare(
              'INSERT INTO upgrade_online_migrations(plan_digest,attempt_id,plan,stage,checkpoint,updated_at) VALUES(?,?,?,?,?,?)',
            )
            .run(
              digest,
              id,
              canonicalUpgrade(plan),
              'backfill',
              canonicalUpgrade({ projection: 0, cursor: null, phase: 'backfill' }),
              this.clock.now().getTime(),
            );
        })
        .immediate();
      row = this.row(digest)!;
    }
    if (row.attempt_id !== id) {
      const previous = this.store.snapshot(row.attempt_id);
      requireUpgrade(
        ['deferred', 'failed', 'reverted', 'candidate-rejected'].includes(previous.attempt.state) &&
          previous.leaseExpiresAt === 0 &&
          previous.controllerId === null &&
          this.store.latest()?.attemptId === id,
        'MIGRATION_OWNED_BY_OTHER_ATTEMPT',
      );
      requireUpgrade(
        this.store.step(id, 'package-verify').applied &&
          this.plan(row).oldRepresentationRetained &&
          snapshot.plan.migrationPath.minSchema <= this.schema() &&
          snapshot.plan.migrationPath.maxSchema >= this.schema(),
        'MIGRATION_ADOPTION_UNQUALIFIED',
      );
      this.store.sqlite
        .transaction(() => {
          this.store.assertControllerFence(id, fence);
          const update = this.store.sqlite
            .prepare(
              'UPDATE upgrade_online_migrations SET attempt_id=?,updated_at=? WHERE plan_digest=? AND attempt_id=?',
            )
            .run(id, this.clock.now().getTime(), digest, row!.attempt_id);
          requireUpgrade(update.changes === 1, 'MIGRATION_ADOPTION_CONFLICT');
        })
        .immediate();
      row = this.row(digest)!;
    }
    const plan = this.plan(row);
    if (input.action !== 'prepare')
      requireUpgrade(
        canonicalUpgrade(input.checkpoint ?? null) === row.checkpoint,
        'MIGRATION_CHECKPOINT_CONFLICT',
      );
    const started = this.clock.now().getTime();
    const result = this.store.sqlite
      .transaction(() => {
        this.store.assertControllerFence(id, fence);
        if (input.action === 'repair') {
          this.structures(plan, digest);
          this.store.sqlite
            .prepare(
              "UPDATE upgrade_online_migrations SET stage='backfill',checkpoint=?,read_epoch=0,degraded=0,reason=NULL WHERE plan_digest=?",
            )
            .run(canonicalUpgrade({ projection: 0, cursor: null, phase: 'backfill' }), digest);
          row = this.row(digest)!;
        }
        let checkpoint = JSON.parse(row!.checkpoint) as {
            projection: number;
            cursor: string | null;
            phase: string;
          },
          completed = row!.completed_work;
        if (checkpoint.phase === 'backfill' || checkpoint.phase === 'reconcile') {
          const p = plan.projections[checkpoint.projection];
          if (p) {
            const records = this.store.sqlite
              .prepare(
                'SELECT * FROM ' +
                  q(p.sourceTable) +
                  ' WHERE (? IS NULL OR CAST(' +
                  q(p.primaryKey) +
                  ' AS TEXT)>?) ORDER BY CAST(' +
                  q(p.primaryKey) +
                  ' AS TEXT) LIMIT ?',
              )
              .all(checkpoint.cursor, checkpoint.cursor, plan.maxBatchRows) as Json[];
            let count = 0;
            for (const record of records) {
              const key = String(record[p.primaryKey]);
              const serial = Object.fromEntries(
                Object.entries(record).map(([k, v]) => [
                  k,
                  Buffer.isBuffer(v) ? v.toString('hex').toUpperCase() : v,
                ]),
              );
              const change = this.store.sqlite
                .prepare(
                  'SELECT coalesce(max(id),0) revision FROM upgrade_projection_changes WHERE plan_digest=? AND projection=? AND row_key=?',
                )
                .get(digest, p.targetTable, key) as { revision: number };
              if (checkpoint.phase === 'backfill')
                this.apply(plan, p, key, change.revision, canonicalUpgrade(serial), 0);
              else {
                const actual = this.store.sqlite
                  .prepare('SELECT * FROM ' + q(p.targetTable) + ' WHERE row_key=?')
                  .get(key) as Json | undefined;
                const expected = this.projected(p, canonicalUpgrade(serial));
                const normalized = (value: unknown) =>
                  Buffer.isBuffer(value) ? { hex: value.toString('hex') } : value;
                requireUpgrade(
                  actual &&
                    actual.tombstone === 0 &&
                    Number(actual.row_revision) >= change.revision &&
                    p.fields.every(
                      (f, i) =>
                        canonicalUpgrade(normalized(actual[f.name])) ===
                        canonicalUpgrade(normalized(expected[i])),
                    ),
                  'MIGRATION_RECONCILIATION_DIFFERENCE',
                );
              }
              checkpoint.cursor = key;
              completed++;
              count++;
              if (this.clock.now().getTime() - started >= Math.max(1, policy.migrationBatchMs / 2))
                break;
            }
            if (count === records.length && records.length < plan.maxBatchRows) {
              checkpoint.projection++;
              checkpoint.cursor = null;
            }
          }
          if (checkpoint.projection >= plan.projections.length) {
            checkpoint = {
              projection: 0,
              cursor: null,
              phase: checkpoint.phase === 'backfill' ? 'reconcile' : 'reconcile-deletions',
            };
          }
        } else if (checkpoint.phase === 'reconcile-deletions') {
          const p = plan.projections[checkpoint.projection];
          if (p) {
            const shadow = this.store.sqlite
              .prepare(
                'SELECT row_key,tombstone FROM ' +
                  q(p.targetTable) +
                  ' WHERE (? IS NULL OR row_key>?) ORDER BY row_key LIMIT ?',
              )
              .all(checkpoint.cursor, checkpoint.cursor, plan.maxBatchRows) as Json[];
            let count = 0;
            for (const item of shadow) {
              const exists = this.store.sqlite
                .prepare(
                  'SELECT 1 FROM ' +
                    q(p.sourceTable) +
                    ' WHERE CAST(' +
                    q(p.primaryKey) +
                    ' AS TEXT)=?',
                )
                .get(item.row_key);
              requireUpgrade(
                exists ? item.tombstone === 0 : item.tombstone === 1,
                'MIGRATION_DELETE_RECONCILIATION_DIFFERENCE',
              );
              checkpoint.cursor = String(item.row_key);
              completed++;
              count++;
              if (this.clock.now().getTime() - started >= Math.max(1, policy.migrationBatchMs / 2))
                break;
            }
            if (count === shadow.length && shadow.length < plan.maxBatchRows) {
              checkpoint.projection++;
              checkpoint.cursor = null;
            }
          }
          if (checkpoint.projection >= plan.projections.length)
            checkpoint = { projection: 0, cursor: null, phase: 'read-switch' };
        } else if (checkpoint.phase === 'read-switch') {
          this.projectCommittedChanges();
          const pending = (
            this.store.sqlite
              .prepare(
                'SELECT count(*) n FROM upgrade_projection_changes WHERE plan_digest=? AND projected=0',
              )
              .get(digest) as { n: number }
          ).n;
          requireUpgrade(
            pending === 0 && !this.row(digest)?.degraded,
            'MIGRATION_RECONCILIATION_UNCONFIRMED',
          );
          this.store.sqlite
            .prepare(
              'INSERT INTO upgrade_schema_epochs VALUES(1,?) ON CONFLICT(singleton) DO UPDATE SET schema_version=excluded.schema_version',
            )
            .run(plan.targetSchema);
          this.store.sqlite
            .prepare('UPDATE upgrade_online_migrations SET read_epoch=1 WHERE plan_digest=?')
            .run(digest);
          checkpoint.phase = 'complete';
        }
        requireUpgrade(
          this.clock.now().getTime() - started < policy.migrationBatchMs,
          'MIGRATION_BATCH_BUDGET_EXCEEDED',
        );
        this.store.sqlite
          .prepare(
            'UPDATE upgrade_online_migrations SET stage=?,checkpoint=?,completed_work=?,updated_at=? WHERE plan_digest=?',
          )
          .run(
            checkpoint.phase === 'complete' ? 'complete' : checkpoint.phase,
            canonicalUpgrade(checkpoint),
            completed,
            this.clock.now().getTime(),
            digest,
          );
        const result = {
          commitKnown: true,
          checkpoint,
          completedWork: completed,
          complete: checkpoint.phase === 'complete',
          integrityValid: this.store.sqlite.pragma('quick_check', { simple: true }) === 'ok',
          budgetExceeded: false,
          oldRepresentationRetained: true,
          newSemanticsEnabled: false,
          schema: this.schema(),
          metrics: this.metrics(id),
        };
        this.store.sqlite
          .prepare('INSERT INTO upgrade_migration_operations VALUES(?,?,?)')
          .run(input.operationId, requestDigest, canonicalUpgrade(result));
        return result;
      })
      .immediate();
    this.store.assertControllerFence(id, fence);
    return result;
  }
}
