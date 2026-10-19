import { z } from 'zod';
import { UpgradePlanSchema } from '@platform/contracts';
import { requiredUpgradeValue, upgradeRecord } from './upgrade-values';
import { Inject, Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { readFile, lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { UpgradeContractPlan } from '@platform/contracts';
import { CLOCK, type Clock } from '@platform/shared-kernel';
import { SystemClock } from '../time/system-clock';
import { UpgradeStore } from './upgrade-store';
import { canonicalUpgrade, requireUpgrade, upgradeDigest } from './upgrade-trust';
import { registerBusinessTransactionHook } from '../persistence/business-transaction-hooks';
import { sqliteStorageObservation } from './sqlite-storage-budget';
import { IMAGE_RUNTIME_SCHEMA_PLAN_DIGEST } from './image-runtime-schema-plan';
import {
  executeImageRuntimeSchemaMigration,
  imageRuntimeSchemaMetrics,
} from './image-runtime-schema-migration';

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
const sqlValue = (v: unknown): string => {
  if (v === null) return 'NULL';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return String(Number(v));
  requireUpgrade(typeof v === 'string', 'SHADOW_VALUE_INVALID');
  return "'" + v.replaceAll("'", "''") + "'";
};

@Injectable()
export class UpgradeOnlineMigration implements OnApplicationBootstrap {
  private projecting = false;
  private readonly reads = new Map<
    string,
    {
      planDigest: string;
      sourceTable: string;
      targetTable: string;
      sourceColumn: string;
      targetColumn: string;
      count: number;
      lastReadAt: string;
    }
  >();
  private authorityRow(): Row | undefined {
    return this.store.sqlite
      .prepare<unknown[], Row>(
        'SELECT * FROM upgrade_online_migrations WHERE read_epoch=2 ORDER BY rowid DESC LIMIT 1',
      )
      .get();
  }
  projectNameAuthoritative(): boolean {
    return Boolean(this.authorityRow());
  }
  private authorityMapping() {
    const row = this.authorityRow();
    requireUpgrade(row, 'PROJECT_NAME_AUTHORITY_UNAVAILABLE');
    const projection = this.plan(row).projections.find(
      (p) => p.sourceTable === 'projects' && p.primaryKey === 'id',
    );
    const field = projection?.fields.find((f) => f.source === 'name' && f.type === 'text');
    requireUpgrade(projection && field, 'PROJECT_NAME_AUTHORITY_UNAVAILABLE');
    return { row, projection, field };
  }
  projectIdByName(name: string): string | null {
    const { projection, field } = this.authorityMapping();
    const row = this.store.sqlite
      .prepare<unknown[], { row_key: string }>(
        'SELECT row_key FROM ' +
          q(projection.targetTable) +
          ' WHERE ' +
          q(field.name) +
          '=? AND tombstone=0',
      )
      .get(name);
    return row?.row_key ?? null;
  }
  saveProjectName(id: string, name: string): string {
    requireUpgrade(this.store.sqlite.inTransaction, 'PROJECT_NAME_AUTHORITY_TRANSACTION_REQUIRED');
    requireUpgrade(
      Array.from(name).length >= 1 && Array.from(name).length <= 40 && !name.includes('\0'),
      'PROJECT_NAME_LENGTH_INVALID',
    );
    const { projection, field } = this.authorityMapping();
    this.store.sqlite
      .prepare(
        'INSERT INTO ' +
          q(projection.targetTable) +
          '(row_key,row_revision,tombstone,' +
          q(field.name) +
          ') VALUES(?,0,0,?) ON CONFLICT(row_key) DO UPDATE SET ' +
          q(field.name) +
          '=excluded.' +
          q(field.name) +
          ',tombstone=0',
      )
      .run(id, name);
    return this.projectAuthoritySlot(id);
  }
  private projectAuthoritySlot(id: string): string {
    const row = this.authorityRow();
    requireUpgrade(row, 'PROJECT_NAME_AUTHORITY_UNAVAILABLE');
    const checkpoint = upgradeRecord(JSON.parse(row.checkpoint));
    requireUpgrade(
      typeof checkpoint.authorityMarkerPrefix === 'string' &&
        /^~r[a-f0-9]{8}v[0-9]{1,2}:$/.test(checkpoint.authorityMarkerPrefix),
      'PROJECT_NAME_AUTHORITY_UNAVAILABLE',
    );
    return (
      checkpoint.authorityMarkerPrefix + (id ? upgradeDigest({ projectId: id }).slice(7, 31) : '')
    );
  }
  projectionReadEvidence() {
    return [...this.reads.values()].map((value) => ({ ...value }));
  }
  private readReceiptKey(planDigest: string): string | null {
    const code = process.env.PLATFORM_COORDINATOR_ACTUAL_DIGEST;
    return code && /^sha256:[a-f0-9]{64}$/.test(code)
      ? 'projection-read:' + planDigest + ':' + code
      : null;
  }
  private confirmedBusinessReads(planDigest: string): boolean {
    if (this.reads.get(planDigest)?.count) return true;
    const key = this.readReceiptKey(planDigest);
    if (!key) return false;
    const receipt = this.store.sqlite
      .prepare<unknown[], { result: string }>(
        'SELECT result FROM upgrade_migration_operations WHERE operation_id=?',
      )
      .get(key);
    if (!receipt) return false;
    const facts = upgradeRecord(JSON.parse(receipt.result));
    return (
      facts.planDigest === planDigest &&
      facts.coordinatorArtifactDigest === process.env.PLATFORM_COORDINATOR_ACTUAL_DIGEST &&
      Number(facts.count) > 0
    );
  }
  /** Qualified independent contract intent only. This does not alter Drizzle's global schema. */
  contractFacts(contract: UpgradeContractPlan) {
    const row = this.row(contract.expandPlanDigest);
    requireUpgrade(
      row?.stage === 'complete' && !row.degraded && row.read_epoch >= 1,
      'CONTRACT_EXPAND_UNCONFIRMED',
    );
    const projection = this.plan(row).projections.find(
      (p) =>
        p.sourceTable === 'projects' &&
        p.primaryKey === 'id' &&
        p.targetTable === contract.targetTable,
    );
    requireUpgrade(
      projection?.fields.length === 1 &&
        projection.fields[0].source === 'name' &&
        projection.fields[0].name === contract.nameColumn &&
        projection.fields[0].type === 'text',
      'CONTRACT_MAPPING_UNQUALIFIED',
    );
    const limited = this.store.sqlite
      .prepare('SELECT id FROM projects LIMIT ?')
      .all(contract.maxValidationRows + 1);
    requireUpgrade(
      limited.length <= contract.maxValidationRows,
      'CONTRACT_VALIDATION_BUDGET_EXCEEDED',
    );
    const targetCount = this.store.sqlite
      .prepare('SELECT row_key FROM ' + q(contract.targetTable) + ' WHERE tombstone=0 LIMIT ?')
      .all(contract.maxValidationRows + 1);
    requireUpgrade(
      targetCount.length <= contract.maxValidationRows,
      'CONTRACT_VALIDATION_BUDGET_EXCEEDED',
    );
    const missing = this.store.sqlite
      .prepare(
        'SELECT p.id FROM projects p LEFT JOIN ' +
          q(contract.targetTable) +
          ' s ON s.row_key=p.id WHERE s.row_key IS NULL OR s.tombstone<>0 OR typeof(s.' +
          q(contract.nameColumn) +
          ")<>'text'" +
          (row.read_epoch < 2 ? ' OR s.' + q(contract.nameColumn) + '<>p.name' : '') +
          ' LIMIT 1',
      )
      .get();
    const extra = this.store.sqlite
      .prepare(
        'SELECT s.row_key FROM ' +
          q(contract.targetTable) +
          ' s LEFT JOIN projects p ON p.id=s.row_key WHERE s.tombstone=0 AND p.id IS NULL LIMIT 1',
      )
      .get();
    const pending = this.store.sqlite
      .prepare(
        'SELECT 1 FROM upgrade_projection_changes WHERE plan_digest=? AND projected=0 LIMIT 1',
      )
      .get(contract.expandPlanDigest);
    const duplicate = this.store.sqlite
      .prepare(
        'SELECT ' +
          q(contract.nameColumn) +
          ' FROM ' +
          q(contract.targetTable) +
          ' WHERE tombstone=0 GROUP BY ' +
          q(contract.nameColumn) +
          ' HAVING count(*)>1 LIMIT 1',
      )
      .get();
    requireUpgrade(
      !missing && !extra && !pending && !duplicate,
      'CONTRACT_REPRESENTATION_UNCONFIRMED',
    );
    return {
      complete: true as const,
      readEpoch: row.read_epoch,
      totalRows: limited.length,
      newReadsConfirmed: this.confirmedBusinessReads(row.plan_digest),
    };
  }
  activateProjectAuthority(contract: UpgradeContractPlan, assertAuthority: () => void): number {
    return this.store.sqlite
      .transaction(() => {
        assertAuthority();
        const began = this.clock.now().getTime(),
          facts = this.contractFacts(contract);
        if (facts.readEpoch >= 2) return facts.totalRows;
        const competing = this.store.sqlite
          .prepare('SELECT plan_digest FROM upgrade_online_migrations WHERE read_epoch=2')
          .get();
        requireUpgrade(!competing, 'CONTRACT_AUTHORITY_CONFLICT');
        // Preserve arbitrary user names, including strings resembling an old
        // placeholder. Persist an empty internal namespace before ownership changes.
        let marker: string | undefined;
        for (let candidate = 0; candidate < 32; candidate++) {
          const prefix = '~r' + contract.planDigest.slice(7, 15) + 'v' + String(candidate) + ':';
          if (
            !this.store.sqlite
              .prepare('SELECT 1 FROM projects WHERE substr(name,1,?)=? LIMIT 1')
              .get(prefix.length, prefix)
          ) {
            marker = prefix;
            break;
          }
        }
        requireUpgrade(marker, 'CONTRACT_RESERVED_NAMESPACE_UNAVAILABLE');
        const before = requiredUpgradeValue(this.row(contract.expandPlanDigest));
        const checkpoint = {
          ...upgradeRecord(JSON.parse(before.checkpoint)),
          authorityMarkerPrefix: marker,
        };
        this.store.sqlite.exec(
          'CREATE UNIQUE INDEX ' +
            q('upg_name_authority_' + contract.planDigest.slice(7, 23)) +
            ' ON ' +
            q(contract.targetTable) +
            '(' +
            q(contract.nameColumn) +
            ') WHERE tombstone=0',
        );
        this.store.sqlite
          .prepare(
            'UPDATE upgrade_online_migrations SET read_epoch=2,checkpoint=? WHERE plan_digest=? AND read_epoch=1',
          )
          .run(canonicalUpgrade(checkpoint), contract.expandPlanDigest);
        requireUpgrade(
          this.clock.now().getTime() - began <= contract.batchBudgetMs,
          'CONTRACT_BATCH_BUDGET_EXCEEDED',
        );
        assertAuthority();
        return facts.totalRows;
      })
      .immediate();
  }
  clearLegacyProjectNames(contract: UpgradeContractPlan, assertAuthority: () => void) {
    return this.store.sqlite
      .transaction(() => {
        assertAuthority();
        const began = this.clock.now().getTime();
        requireUpgrade(
          this.authorityRow()?.plan_digest === contract.expandPlanDigest,
          'CONTRACT_NEW_AUTHORITY_REQUIRED',
        );
        this.contractFacts(contract);
        const all = this.store.sqlite
          .prepare<unknown[], { id: string; name: string }>(
            'SELECT id,name FROM projects ORDER BY id LIMIT ?',
          )
          .all(contract.maxValidationRows + 1);
        requireUpgrade(
          all.length <= contract.maxValidationRows,
          'CONTRACT_VALIDATION_BUDGET_EXCEEDED',
        );
        const rows = all
          .filter((row) => row.name !== this.projectAuthoritySlot(row.id))
          .slice(0, contract.maxBatchRows);
        const update = this.store.sqlite.prepare('UPDATE projects SET name=? WHERE id=?');
        for (const row of rows) update.run(this.projectAuthoritySlot(row.id), row.id);
        this.projectCommittedChanges();
        requireUpgrade(
          this.clock.now().getTime() - began <= contract.batchBudgetMs,
          'CONTRACT_BATCH_BUDGET_EXCEEDED',
        );
        assertAuthority();
        return {
          cleared: rows.length,
          complete:
            rows.length ===
            all.filter((row) => row.name !== this.projectAuthoritySlot(row.id)).length,
        };
      })
      .immediate();
  }
  /** The new Coordinator's production ProjectRepository consumes the confirmed
   * renamed field. Source A continues to read the retained authority column.
   * These are real SQL reads, not a private read_epoch success assertion. */
  projectedProjectName(id: string, authoritativeName: string): string | undefined {
    const authority = this.authorityRow();
    if (authority) requireUpgrade(!authority.degraded, 'PROJECT_NAME_AUTHORITY_UNCONFIRMED');
    const rows = authority
      ? [authority]
      : this.store.sqlite
          .prepare<unknown[], Row>(
            "SELECT * FROM upgrade_online_migrations WHERE read_epoch=1 AND degraded=0 AND stage='complete' ORDER BY rowid DESC",
          )
          .all();
    for (const row of rows) {
      const plan = this.plan(row),
        projection = plan.projections.find(
          (p) => p.sourceTable === 'projects' && p.primaryKey === 'id',
        );
      const field = projection?.fields.find((f) => f.source === 'name' && f.type === 'text');
      if (!projection || !field) continue;
      let actual: Json | undefined;
      try {
        actual = this.store.sqlite
          .prepare<unknown[], Json>(
            'SELECT ' +
              q(field.name) +
              ',"tombstone" FROM ' +
              q(projection.targetTable) +
              ' WHERE row_key=?',
          )
          .get(id);
      } catch (error) {
        if (row.read_epoch >= 2) throw error;
        // Only the independently rebuildable shadow is allowed to degrade. A
        // corrupt shared DB or loss of the authoritative read is never success.
        if (!(
          error &&
          typeof error === 'object' &&
          'code' in error &&
          error.code === 'SQLITE_ERROR'
        ))
          throw error;
        this.store.sqlite.prepare('SELECT name FROM projects WHERE id=?').get(id);
        this.store.sqlite
          .prepare(
            "UPDATE upgrade_online_migrations SET read_epoch=0,degraded=1,reason='SHADOW_READ_UNAVAILABLE' WHERE plan_digest=?",
          )
          .run(row.plan_digest);
        return undefined;
      }
      if (
        !actual ||
        Number(actual.tombstone) !== 0 ||
        typeof actual[field.name] !== 'string' ||
        (row.read_epoch < 2 && actual[field.name] !== authoritativeName)
      ) {
        requireUpgrade(row.read_epoch < 2, 'PROJECT_NAME_AUTHORITY_UNCONFIRMED');
        this.store.sqlite
          .prepare(
            "UPDATE upgrade_online_migrations SET read_epoch=0,degraded=1,reason='SHADOW_READ_UNCONFIRMED' WHERE plan_digest=?",
          )
          .run(row.plan_digest);
        return undefined;
      }
      const prior = this.reads.get(row.plan_digest);
      const receiptKey = this.readReceiptKey(row.plan_digest);
      if (
        receiptKey &&
        process.env.PLATFORM_PROCESS_ROLE === 'coordinator' &&
        process.env.COORDINATOR_WRITER_FENCE_VALID === 'true'
      ) {
        // A real business reader leaves a bounded, non-sensitive receipt. This
        // survives restart without altering migration checkpoint/CAS semantics.
        const requestDigest = upgradeDigest({
          kind: 'projection-read',
          planDigest: row.plan_digest,
          coordinatorArtifactDigest: process.env.PLATFORM_COORDINATOR_ACTUAL_DIGEST,
        });
        const before = this.store.sqlite
          .prepare<unknown[], { request_digest: string; result: string }>(
            'SELECT request_digest,result FROM upgrade_migration_operations WHERE operation_id=?',
          )
          .get(receiptKey);
        requireUpgrade(
          !before || before.request_digest === requestDigest,
          'PROJECTION_READ_RECEIPT_CONFLICT',
        );
        const count = 1;
        const result = {
          planDigest: row.plan_digest,
          coordinatorArtifactDigest: process.env.PLATFORM_COORDINATOR_ACTUAL_DIGEST,
          count,
          observedAt: this.clock.now().toISOString(),
        };
        if (!before)
          this.store.sqlite
            .prepare(
              'INSERT INTO upgrade_migration_operations(operation_id,request_digest,result) VALUES(?,?,?) ON CONFLICT(operation_id) DO UPDATE SET result=excluded.result',
            )
            .run(receiptKey, requestDigest, canonicalUpgrade(result));
      }
      this.reads.set(row.plan_digest, {
        planDigest: row.plan_digest,
        sourceTable: 'projects',
        targetTable: projection.targetTable,
        sourceColumn: 'name',
        targetColumn: field.name,
        count: (prior?.count ?? 0) + 1,
        lastReadAt: this.clock.now().toISOString(),
      });
      const currentName = actual[field.name];
      requireUpgrade(typeof currentName === 'string', 'PROJECT_NAME_AUTHORITY_UNCONFIRMED');
      return currentName;
    }
    requireUpgrade(!authority, 'PROJECT_NAME_AUTHORITY_UNAVAILABLE');
    return undefined;
  }
  constructor(
    private readonly store: UpgradeStore,
    @Inject(CLOCK) private readonly clock: Clock = new SystemClock(),
  ) {}
  onApplicationBootstrap(): void {
    registerBusinessTransactionHook(this.store.sqlite, () => {
      this.projectCommittedChanges();
    });
  }
  schema(): number {
    const count = requiredUpgradeValue(
      this.store.sqlite
        .prepare<
          unknown[],
          {
            n: number;
          }
        >('SELECT count(*) n FROM __drizzle_migrations')
        .get(),
    ).n;
    // A representation read epoch is not a committed global SQL migration.
    return count;
  }
  private row(digest: string): Row | undefined {
    return this.store.sqlite
      .prepare<unknown[], Row>('SELECT * FROM upgrade_online_migrations WHERE plan_digest=?')
      .get(digest);
  }
  private plan(row: Row): Plan {
    const plan = OnlineMigrationPlanSchema.parse(JSON.parse(row.plan));
    requireUpgrade(upgradeDigest(plan) === row.plan_digest, 'MIGRATION_PLAN_CORRUPT');
    return plan;
  }
  private validate(plan: Plan): void {
    requireUpgrade(plan.targetSchema === this.schema(), 'GLOBAL_SCHEMA_MIGRATION_UNQUALIFIED');
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
        .prepare<unknown[], Json>('PRAGMA table_info(' + q(projection.sourceTable) + ')')
        .all();
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
        .prepare<unknown[], Json>('PRAGMA table_info(' + q(p.sourceTable) + ')')
        .all();
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
            String(Number(event === 'DELETE')) +
            '); END',
        );
      }
    }
  }
  private projected(p: Plan['projections'][number], payload: string | null): unknown[] {
    const object = payload ? upgradeRecord(JSON.parse(payload)) : {};
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
      if (f.type === 'text') {
        requireUpgrade(
          typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean',
          'SHADOW_VALUE_INVALID',
        );
        return String(value);
      }
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
    const mode = this.row(upgradeDigest(_plan));
    if (mode && mode.read_epoch >= 2 && p.sourceTable === 'projects') {
      const field = p.fields.find((f) => f.source === 'name');
      requireUpgrade(field, 'PROJECT_NAME_AUTHORITY_UNCONFIRMED');
      const current = this.store.sqlite
        .prepare<unknown[], Json>(
          'SELECT ' + q(field.name) + ' FROM ' + q(p.targetTable) + ' WHERE row_key=?',
        )
        .get(key);
      requireUpgrade(
        current && typeof current[field.name] === 'string',
        'PROJECT_NAME_AUTHORITY_UNCONFIRMED',
      );
      values[fields.indexOf(field.name)] = current[field.name];
    }
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
        .prepare<unknown[], Row>(
          "SELECT * FROM upgrade_online_migrations WHERE stage NOT IN ('contracted')",
        )
        .all();
      for (const row of rows) {
        const plan = this.plan(row);
        const changes = this.store.sqlite
          .prepare<unknown[], Json>(
            'SELECT * FROM upgrade_projection_changes WHERE plan_digest=? AND projected=0 ORDER BY id LIMIT ?',
          )
          .all(row.plan_digest, plan.maxBatchRows);
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
              z.string().nullable().parse(c.payload),
              Number(c.tombstone),
            );
            this.store.sqlite
              .prepare('UPDATE upgrade_projection_changes SET projected=1 WHERE id=?')
              .run(c.id);
          }
          this.store.sqlite.exec('RELEASE upg_projection');
          const pending = requiredUpgradeValue(
            this.store.sqlite
              .prepare<unknown[], { n: number }>(
                'SELECT count(*) n FROM upgrade_projection_changes WHERE plan_digest=? AND projected=0',
              )
              .get(row.plan_digest),
          ).n;
          if (pending > 0) {
            requireUpgrade(row.read_epoch < 2, 'PROJECT_NAME_AUTHORITY_BACKLOG');
            this.store.sqlite
              .prepare(
                "UPDATE upgrade_online_migrations SET read_epoch=0,degraded=1,reason='PROJECTION_BACKLOG' WHERE plan_digest=?",
              )
              .run(row.plan_digest);
          }
        } catch (error) {
          this.store.sqlite.exec('ROLLBACK TO upg_projection');
          this.store.sqlite.exec('RELEASE upg_projection');
          if (row.read_epoch >= 2) throw error;
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
    const attempt = this.store.ledgerSqlite
      .prepare<unknown[], { plan: string }>('SELECT plan FROM upgrade_attempts WHERE attempt_id=?')
      .get(id);
    if (
      attempt &&
      UpgradePlanSchema.parse(JSON.parse(attempt.plan)).migrationPath.migrationPlanDigest ===
        IMAGE_RUNTIME_SCHEMA_PLAN_DIGEST
    )
      return imageRuntimeSchemaMetrics(this.store.sqlite);
    const row = this.store.sqlite
      .prepare<unknown[], Row>('SELECT * FROM upgrade_online_migrations WHERE attempt_id=?')
      .get(id);
    if (!row)
      return {
        known: false,
        differences: 0,
        oldRepresentationRetained: false,
        readEpoch: 0,
        degraded: false,
      };
    const pending = requiredUpgradeValue(
      this.store.sqlite
        .prepare<unknown[], { n: number }>(
          'SELECT count(*) n FROM upgrade_projection_changes WHERE plan_digest=? AND projected=0',
        )
        .get(row.plan_digest),
    ).n;
    return {
      known: true,
      differences: pending + Number(row.degraded !== 0),
      oldRepresentationRetained: row.read_epoch < 2 && this.plan(row).oldRepresentationRetained,
      readEpoch: row.read_epoch,
      degraded: row.degraded !== 0,
    };
  }
  async execute(id: string, input: Json): Promise<Json> {
    const fence = Number(input.fence);
    this.store.assertControllerFence(id, fence);
    const snapshot = this.store.snapshot(id),
      digest = snapshot.plan.migrationPath.migrationPlanDigest;
    if (digest === IMAGE_RUNTIME_SCHEMA_PLAN_DIGEST)
      return executeImageRuntimeSchemaMigration(this.store, id, input);
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
      .prepare<unknown[], { request_digest: string; result: string }>(
        'SELECT request_digest,result FROM upgrade_migration_operations WHERE operation_id=?',
      )
      .get(input.operationId);
    if (prior) {
      requireUpgrade(prior.request_digest === requestDigest, 'MIGRATION_OPERATION_CONFLICT');
      return upgradeRecord(JSON.parse(prior.result));
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
    const storage = await sqliteStorageObservation(this.store.sqlite);
    requireUpgrade(storage.availableBytes >= policy.minFreeBytes, 'MIGRATION_DISK_BUDGET');
    requireUpgrade(storage.walBytes <= policy.maxWalBytes, 'MIGRATION_WAL_BUDGET');
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
      row = requiredUpgradeValue(this.row(digest));
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
      this.plan(row); // Revalidate the signed retention invariant before adopting its old data.
      requireUpgrade(
        this.store.step(id, 'package-verify').applied &&
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
            .run(id, this.clock.now().getTime(), digest, requiredUpgradeValue(row).attempt_id);
          requireUpgrade(update.changes === 1, 'MIGRATION_ADOPTION_CONFLICT');
        })
        .immediate();
      row = requiredUpgradeValue(this.row(digest));
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
          row = requiredUpgradeValue(this.row(digest));
        }
        let checkpoint = z
            .object({ projection: z.number(), cursor: z.string().nullable(), phase: z.string() })
            .parse(JSON.parse(requiredUpgradeValue(row).checkpoint)),
          completed = requiredUpgradeValue(row).completed_work;
        if (checkpoint.phase === 'backfill' || checkpoint.phase === 'reconcile') {
          const p = plan.projections.at(checkpoint.projection);
          if (p) {
            const records = this.store.sqlite
              .prepare<unknown[], Json>(
                'SELECT * FROM ' +
                  q(p.sourceTable) +
                  ' WHERE (? IS NULL OR CAST(' +
                  q(p.primaryKey) +
                  ' AS TEXT)>?) ORDER BY CAST(' +
                  q(p.primaryKey) +
                  ' AS TEXT) LIMIT ?',
              )
              .all(checkpoint.cursor, checkpoint.cursor, plan.maxBatchRows);
            let count = 0;
            for (const record of records) {
              const key = String(record[p.primaryKey]);
              const serial = Object.fromEntries(
                Object.entries(record).map(([k, v]) => [
                  k,
                  Buffer.isBuffer(v) ? v.toString('hex').toUpperCase() : v,
                ]),
              );
              const change = requiredUpgradeValue(
                this.store.sqlite
                  .prepare<unknown[], { revision: number }>(
                    'SELECT coalesce(max(id),0) revision FROM upgrade_projection_changes WHERE plan_digest=? AND projection=? AND row_key=?',
                  )
                  .get(digest, p.targetTable, key),
              );
              if (checkpoint.phase === 'backfill')
                this.apply(plan, p, key, change.revision, canonicalUpgrade(serial), 0);
              else {
                const actual = this.store.sqlite
                  .prepare<unknown[], Json>(
                    'SELECT * FROM ' + q(p.targetTable) + ' WHERE row_key=?',
                  )
                  .get(key);
                const expected = this.projected(p, canonicalUpgrade(serial));
                const normalized = (value: unknown) =>
                  Buffer.isBuffer(value) ? { hex: value.toString('hex') } : value;
                requireUpgrade(
                  actual?.tombstone === 0 &&
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
          const p = plan.projections.at(checkpoint.projection);
          if (p) {
            const shadow = this.store.sqlite
              .prepare<unknown[], Json>(
                'SELECT row_key,tombstone FROM ' +
                  q(p.targetTable) +
                  ' WHERE (? IS NULL OR row_key>?) ORDER BY row_key LIMIT ?',
              )
              .all(checkpoint.cursor, checkpoint.cursor, plan.maxBatchRows);
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
          const pending = requiredUpgradeValue(
            this.store.sqlite
              .prepare<unknown[], { n: number }>(
                'SELECT count(*) n FROM upgrade_projection_changes WHERE plan_digest=? AND projected=0',
              )
              .get(digest),
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
