import { upgradeRecord } from './upgrade-values';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Inject, Injectable, Optional, type OnModuleDestroy } from '@nestjs/common';
import Database from 'better-sqlite3';
import { z } from 'zod';
import { lstatSync, realpathSync, readFileSync } from 'node:fs';
import { dirname, join, isAbsolute, resolve } from 'node:path';
import { CLOCK, platformInstanceId, type Clock } from '@platform/shared-kernel';
import { SystemClock } from '../time/system-clock';
import { canonicalUpgrade, requireUpgrade, upgradeDigest } from './upgrade-trust';
import type { UpgradeStoreOptions, UpgradeLedgerAccess } from './upgrade-control-bridge';
import { UPGRADE_CONTROL_SCHEMA_VERSION } from './control-store-schema';

interface LedgerWork {
  epoch: number;
  legacy: boolean;
  active: boolean;
}
export interface LedgerFreezeReceipt {
  schemaVersion: 1;
  kind: 'legacy-control-admission-frozen';
  instanceId: string;
  operationId: string;
  commandId: string;
  specDigest: string;
  sourceConfirmedDigest: string;
  admissionRevision: number;
  legacyLedgerEpoch: number;
  frozenAt: number;
  businessWriterGeneration: number;
  businessWriterFence: number;
  receiptDigest: string;
}
const FrozenReceiptSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal('legacy-control-admission-frozen'),
    instanceId: z.string(),
    operationId: z.string().uuid(),
    commandId: z.string(),
    specDigest: z.string(),
    sourceConfirmedDigest: z.string(),
    admissionRevision: z.number().int().positive(),
    legacyLedgerEpoch: z.number().int().positive(),
    frozenAt: z.number().int().positive(),
    businessWriterGeneration: z.number().int().positive(),
    businessWriterFence: z.number().int().positive(),
    receiptDigest: z.string(),
  })
  .strict();
function parseConfiguration(text: string): { spec: unknown; signedManifest: unknown } {
  const value = upgradeRecord(JSON.parse(text));
  requireUpgrade(
    Object.hasOwn(value, 'spec') && Object.hasOwn(value, 'signedManifest'),
    'CONTROL_ATTACHMENT_CONFIG_INVALID',
  );
  return { spec: value.spec, signedManifest: value.signedManifest };
}
interface AttachmentRow {
  operation_id: string;
  spec_digest: string;
  phase: string;
  receipt: string;
  config: string;
  attach_config: string | null;
  attached_receipt: string | null;
}

/** The control ledger is replaceable; the business connection and its writer
 * are not. Original statements and asynchronous work retain their old epoch. */
@Injectable()
export class UpgradeLedgerConnection implements OnModuleDestroy, UpgradeLedgerAccess {
  private connection?: Database.Database;
  private businessConnection?: Database.Database;
  private instanceId = platformInstanceId();
  private epoch = 1;
  private closed = false;
  private readonly work = new AsyncLocalStorage<LedgerWork>();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly views = new WeakMap<
    Database.Database,
    { epoch: number; value: Database.Database }
  >();
  constructor(@Optional() @Inject(CLOCK) private readonly clock: Clock = new SystemClock()) {}

  options(): UpgradeStoreOptions {
    const path = process.env.UPGRADE_CONTROL_DATABASE_PATH;
    if (path && !this.connection) this.connection = this.openReadonly(path, this.instanceId);
    return { instanceId: this.instanceId, ledgerAccess: this };
  }
  bindBusiness(sqlite: Database.Database, instanceId: string): void {
    requireUpgrade(
      !this.businessConnection || this.businessConnection === sqlite,
      'CONTROL_BUSINESS_CONNECTION_CHANGED',
    );
    requireUpgrade(instanceId === this.instanceId, 'CONTROL_SCHEMA_OR_INSTANCE_MISMATCH');
    this.businessConnection = sqlite;
    const exists = sqlite
      .prepare("SELECT 1 FROM sqlite_master WHERE name='upgrade_control_attachment'")
      .get();
    if (!exists) return;
    const row = sqlite
      .prepare<unknown[], AttachmentRow>(
        'SELECT * FROM upgrade_control_attachment WHERE instance_id=?',
      )
      .get(instanceId);
    if (!row) return;
    this.closed = true;
    requireUpgrade(
      row.phase === 'frozen' || row.phase === 'attached',
      'CONTROL_ATTACHMENT_RECEIPT_CORRUPT',
    );
    this.frozenReceipt();
    requireUpgrade(
      row.phase !== 'frozen' || !this.connection,
      'CONTROL_ATTACHMENT_INTENT_CONFLICT',
    );
    if (row.phase === 'attached') {
      const configured = this.readConfiguredIntent();
      requireUpgrade(
        canonicalUpgrade(configured) === row.attach_config,
        'CONTROL_ATTACHMENT_CONFIG_CHANGED',
      );
      const spec = z
        .object({
          controlDatabase: z
            .object({ path: z.string(), dev: z.string(), ino: z.string() })
            .strict(),
        })
        .passthrough()
        .parse(configured.spec);
      if (this.connection) {
        requireUpgrade(
          this.connection.name === spec.controlDatabase.path,
          'CONTROL_ATTACHMENT_CONFIG_CHANGED',
        );
        this.assertFileIdentity(spec.controlDatabase.path, spec.controlDatabase);
      } else
        this.connection = this.openReadonly(
          spec.controlDatabase.path,
          instanceId,
          spec.controlDatabase,
        );
      this.epoch = 2;
    }
  }
  get readonly(): boolean {
    return this.connection !== undefined;
  }
  get frozen(): boolean {
    return this.closed;
  }
  private assertEpoch(epoch = this.epoch): void {
    const context = this.work.getStore();
    requireUpgrade(
      epoch === this.epoch && (!context || (context.active && context.epoch === this.epoch)),
      'CONTROL_LEDGER_EPOCH_SUPERSEDED',
    );
  }
  private view(sqlite: Database.Database): Database.Database {
    this.assertEpoch();
    const found = this.views.get(sqlite);
    if (found?.epoch === this.epoch) return found.value;
    const epoch = this.epoch;
    const check = (write = false) => {
      this.assertEpoch(epoch);
      if (write && !this.readonly && this.closed) {
        const context = this.work.getStore();
        requireUpgrade(context?.active && context.legacy, 'LEGACY_CONTROL_ADMISSION_FROZEN');
      }
    };
    const value = new Proxy(sqlite, {
      get: (target, key) => {
        if (key === 'prepare')
          return (...args: Parameters<Database.Database['prepare']>) => {
            check();
            const statement = target.prepare(...args);
            const guardedStatement: Database.Statement = {
              get database() {
                return value;
              },
              get source() {
                return statement.source;
              },
              get reader() {
                return statement.reader;
              },
              get readonly() {
                return statement.readonly;
              },
              get busy() {
                return statement.busy;
              },
              run(...values: unknown[]) {
                check(!statement.readonly);
                return statement.run(...values);
              },
              get(...values: unknown[]) {
                check(!statement.readonly);
                return statement.get(...values);
              },
              all(...values: unknown[]) {
                check(!statement.readonly);
                return statement.all(...values);
              },
              iterate() {
                // A live cursor prevents the durable SQLite freeze/CAS write.
                // Control readers use bounded get/all; business retains its raw
                // fenced connection and its ordinary iterator semantics.
                check();
                requireUpgrade(false, 'CONTROL_LEDGER_LAZY_CURSOR_UNSUPPORTED');
              },
              bind(...values: unknown[]) {
                check();
                statement.bind(...values);
                return guardedStatement;
              },
              pluck(toggle?: boolean) {
                check();
                statement.pluck(toggle);
                return guardedStatement;
              },
              expand(toggle?: boolean) {
                check();
                statement.expand(toggle);
                return guardedStatement;
              },
              raw(toggle?: boolean) {
                check();
                statement.raw(toggle);
                return guardedStatement;
              },
              safeIntegers(toggle?: boolean) {
                check();
                statement.safeIntegers(toggle);
                return guardedStatement;
              },
              columns() {
                check();
                return statement.columns();
              },
            };
            return guardedStatement;
          };
        const method: unknown = Reflect.get(target, key);
        if (typeof method !== 'function') return method;
        return (...args: unknown[]) => {
          check(key === 'exec' || key === 'transaction' || key === 'pragma');
          const result: unknown = Reflect.apply(method, target, args);
          if (key !== 'transaction' || typeof result !== 'function') return result;
          return new Proxy(
            (...values: unknown[]) => {
              check(true);
              const output: unknown = Reflect.apply(result, target, values);
              return output;
            },
            {
              get: (_tx, name) => {
                if (name === 'database') return value;
                const call: unknown = Reflect.get(result, name);
                return typeof call === 'function'
                  ? (...values: unknown[]) => {
                      check(true);
                      const output: unknown = Reflect.apply(call, result, values);
                      return output;
                    }
                  : call;
              },
            },
          );
        };
      },
    });
    this.views.set(sqlite, { epoch, value });
    return value;
  }
  ledger(sqlite: Database.Database): Database.Database {
    return this.view(this.connection ?? sqlite);
  }
  business(sqlite: Database.Database): Database.Database {
    // Business transaction hooks are keyed by the original fenced connection.
    // Only control ledger capabilities are replaceable/epoch-wrapped.
    this.assertEpoch();
    return sqlite;
  }
  assertWritable(): void {
    this.assertEpoch();
    requireUpgrade(!this.readonly, 'CONTROL_LEDGER_READONLY');
    const parent = this.work.getStore();
    requireUpgrade(
      !this.closed || (parent?.active && parent.legacy),
      'LEGACY_CONTROL_ADMISSION_FROZEN',
    );
  }
  run<T>(work: () => T): T {
    this.assertEpoch();
    const parent = this.work.getStore();
    requireUpgrade(
      !this.closed || this.readonly || (parent?.active && parent.legacy),
      'LEGACY_CONTROL_ADMISSION_FROZEN',
    );
    const token: LedgerWork = { epoch: this.epoch, legacy: !this.readonly, active: true };
    let result: T;
    try {
      result = this.work.run(token, work);
    } catch (error) {
      token.active = false;
      throw error;
    }
    if (result && typeof (result as { then?: unknown }).then === 'function') {
      const original = Promise.resolve(result);
      if (token.legacy) this.pending.add(original);
      void original.then(
        () => {
          token.active = false;
          this.pending.delete(original);
        },
        () => {
          token.active = false;
          this.pending.delete(original);
        },
      );
    } else token.active = false;
    return result;
  }
  capture<T>(work: () => T): () => T {
    const epoch = this.epoch;
    return () => {
      this.assertEpoch(epoch);
      return this.run(work);
    };
  }
  async awaitLegacySettled(deadline: number): Promise<void> {
    requireUpgrade(this.closed, 'LEGACY_CONTROL_ADMISSION_NOT_FROZEN');
    while (this.pending.size) {
      const remaining = deadline - this.clock.now().getTime();
      requireUpgrade(remaining > 0, 'LEGACY_CONTROL_WORK_NOT_SETTLED');
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.allSettled([...this.pending]),
          new Promise<never>((_ok, fail) => {
            timer = setTimeout(() => {
              fail(
                Object.assign(new Error('LEGACY_CONTROL_WORK_NOT_SETTLED'), {
                  code: 'LEGACY_CONTROL_WORK_NOT_SETTLED',
                }),
              );
            }, remaining);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
  }
  legacyWorkSnapshot(): { admissionClosed: boolean; active: number; epoch: number } {
    return { admissionClosed: this.closed, active: this.pending.size, epoch: this.epoch };
  }
  freeze(
    receipt: Omit<LedgerFreezeReceipt, 'receiptDigest'>,
    config: unknown,
  ): LedgerFreezeReceipt {
    requireUpgrade(this.businessConnection && !this.readonly, 'LEGACY_CONTROL_LEDGER_REQUIRED');
    const sqlite = this.businessConnection;
    sqlite.exec(
      'CREATE TABLE IF NOT EXISTS upgrade_control_attachment(instance_id TEXT PRIMARY KEY,operation_id TEXT NOT NULL,spec_digest TEXT NOT NULL,phase TEXT NOT NULL,receipt TEXT NOT NULL,config TEXT NOT NULL,attach_config TEXT,attached_receipt TEXT,attached_at INTEGER)',
    );
    const prior = sqlite
      .prepare<unknown[], AttachmentRow>(
        'SELECT * FROM upgrade_control_attachment WHERE instance_id=?',
      )
      .get(this.instanceId);
    if (prior) {
      requireUpgrade(
        prior.operation_id === receipt.operationId &&
          prior.spec_digest === receipt.specDigest &&
          prior.config === canonicalUpgrade(config),
        'CONTROL_ATTACHMENT_INTENT_CONFLICT',
      );
      this.closed = true;
      return FrozenReceiptSchema.parse(JSON.parse(prior.receipt));
    }
    const result = { ...receipt, receiptDigest: upgradeDigest(receipt) };
    sqlite
      .prepare("INSERT INTO upgrade_control_attachment VALUES(?,?,?,'frozen',?,?,NULL,NULL,NULL)")
      .run(
        this.instanceId,
        receipt.operationId,
        receipt.specDigest,
        canonicalUpgrade(result),
        canonicalUpgrade(config),
      );
    this.closed = true;
    return result;
  }
  frozenReceipt(): LedgerFreezeReceipt | null {
    const sqlite = this.businessConnection;
    if (
      !sqlite?.prepare("SELECT 1 FROM sqlite_master WHERE name='upgrade_control_attachment'").get()
    )
      return null;
    const row = sqlite
      .prepare<unknown[], { receipt: string }>(
        'SELECT receipt FROM upgrade_control_attachment WHERE instance_id=?',
      )
      .get(this.instanceId);
    if (!row) return null;
    const result = FrozenReceiptSchema.parse(JSON.parse(row.receipt));
    const { receiptDigest, ...facts } = result;
    requireUpgrade(upgradeDigest(facts) === receiptDigest, 'CONTROL_ATTACHMENT_RECEIPT_CORRUPT');
    return result;
  }
  frozenConfiguration(): { spec: unknown; signedManifest: unknown } | null {
    const row = this.businessConnection
      ?.prepare<unknown[], { config: string }>(
        'SELECT config FROM upgrade_control_attachment WHERE instance_id=?',
      )
      .get(this.instanceId);
    return row ? parseConfiguration(row.config) : null;
  }
  attachmentStatus(): {
    phase: string;
    attachSpecDigest: string | null;
    attachedReceipt: Record<string, unknown> | null;
    resultDigest: string | null;
  } | null {
    if (!this.businessConnection || !this.closed) return null;
    const row = this.businessConnection
      .prepare<unknown[], AttachmentRow>(
        'SELECT * FROM upgrade_control_attachment WHERE instance_id=?',
      )
      .get(this.instanceId);
    if (!row) return null;
    const config = row.attach_config ? parseConfiguration(row.attach_config) : null;
    const receipt = row.attached_receipt ? upgradeRecord(JSON.parse(row.attached_receipt)) : null;
    return {
      phase: row.phase,
      attachSpecDigest: config ? upgradeDigest(config.spec) : null,
      attachedReceipt: receipt,
      resultDigest: receipt ? upgradeDigest(receipt) : null,
    };
  }
  attachedReceipt(specDigest: string): Record<string, unknown> | null {
    if (!this.businessConnection || !this.closed) return null;
    const row = this.businessConnection
      .prepare<unknown[], AttachmentRow>(
        'SELECT * FROM upgrade_control_attachment WHERE instance_id=?',
      )
      .get(this.instanceId);
    if (row?.phase !== 'attached') return null;
    const config = row.attach_config ? parseConfiguration(row.attach_config) : null;
    requireUpgrade(
      config !== null && upgradeDigest(config.spec) === specDigest && row.attached_receipt,
      'CONTROL_ATTACHMENT_INTENT_CONFLICT',
    );
    return upgradeRecord(JSON.parse(row.attached_receipt));
  }
  attach(
    candidate: Database.Database,
    freezePlanDigest: string,
    config: unknown,
    receipt: Record<string, unknown>,
  ): void {
    requireUpgrade(
      this.businessConnection && this.closed && !this.readonly && this.pending.size === 0,
      'LEGACY_CONTROL_WORK_NOT_SETTLED',
    );
    const change = this.businessConnection
      .prepare(
        "UPDATE upgrade_control_attachment SET phase='attached',attach_config=?,attached_receipt=?,attached_at=? WHERE instance_id=? AND spec_digest=? AND phase='frozen'",
      )
      .run(
        canonicalUpgrade(config),
        canonicalUpgrade(receipt),
        this.clock.now().getTime(),
        this.instanceId,
        freezePlanDigest,
      );
    requireUpgrade(change.changes === 1, 'CONTROL_ATTACHMENT_CAS_CHANGED');
    this.connection = candidate;
    this.epoch++;
  }
  assertFileIdentity(path: string, identity: { dev: string; ino: string }): void {
    const stat = lstatSync(path, { bigint: true });
    requireUpgrade(
      stat.isFile() &&
        !stat.isSymbolicLink() &&
        stat.nlink === 1n &&
        (stat.mode & 0o077n) === 0n &&
        realpathSync(path) === path &&
        String(stat.dev) === identity.dev &&
        String(stat.ino) === identity.ino &&
        (!process.getuid || stat.uid === BigInt(process.getuid()) || stat.uid === 0n),
      'CONTROL_LEDGER_IDENTITY_CHANGED',
    );
  }
  openReadonly(
    path: string,
    instanceId: string,
    identity?: { dev: string; ino: string },
  ): Database.Database {
    requireUpgrade(isAbsolute(path) && resolve(path) === path, 'CONTROL_LEDGER_PATH_INVALID');
    const stat = lstatSync(path, { bigint: true });
    requireUpgrade(
      stat.isFile() &&
        !stat.isSymbolicLink() &&
        stat.nlink === 1n &&
        (stat.mode & 0o077n) === 0n &&
        realpathSync(path) === path &&
        (!process.getuid || stat.uid === BigInt(process.getuid()) || stat.uid === 0n) &&
        (!identity || (String(stat.dev) === identity.dev && String(stat.ino) === identity.ino)),
      'CONTROL_LEDGER_INSECURE',
    );
    const sqlite = new Database(path, { readonly: true, fileMustExist: true });
    try {
      const opened = lstatSync(path, { bigint: true });
      requireUpgrade(
        opened.dev === stat.dev &&
          opened.ino === stat.ino &&
          opened.isFile() &&
          !opened.isSymbolicLink(),
        'CONTROL_LEDGER_IDENTITY_CHANGED',
      );
      sqlite.pragma('query_only = ON');
      const metadata = sqlite
        .prepare<unknown[], { instance_id: string; schema_version: number }>(
          'SELECT instance_id,schema_version FROM control_store_metadata WHERE singleton=1',
        )
        .get();
      requireUpgrade(
        sqlite.readonly &&
          sqlite.pragma('query_only', { simple: true }) === 1 &&
          metadata?.instance_id === instanceId &&
          metadata.schema_version === UPGRADE_CONTROL_SCHEMA_VERSION,
        'CONTROL_SCHEMA_OR_INSTANCE_MISMATCH',
      );
      return sqlite;
    } catch (error) {
      sqlite.close();
      throw error;
    }
  }
  readConfiguredIntent(): { spec: unknown; signedManifest: unknown } {
    return this.readConfigured(
      'UPGRADE_CONTROL_ATTACH_SPEC_PATH',
      'UPGRADE_CONTROL_ATTACH_SPEC_RAW_DIGEST',
    );
  }
  readConfiguredFreeze(): { spec: unknown; signedManifest: unknown } {
    return this.readConfigured(
      'UPGRADE_CONTROL_ATTACH_FREEZE_PLAN_PATH',
      'UPGRADE_CONTROL_ATTACH_FREEZE_PLAN_RAW_DIGEST',
    );
  }
  private readConfigured(
    pathKey: string,
    digestKey: string,
  ): { spec: unknown; signedManifest: unknown } {
    const binding = process.env.PLATFORM_COORDINATOR_BINDING_PATH;
    const fallback =
      binding && isAbsolute(binding) && resolve(binding) === binding
        ? join(
            dirname(binding),
            'control-adoption',
            pathKey === 'UPGRADE_CONTROL_ATTACH_FREEZE_PLAN_PATH' ? 'freeze.json' : 'attach.json',
          )
        : undefined;
    const path = process.env[pathKey] ?? fallback,
      rawDigest = process.env[digestKey];
    requireUpgrade(
      path && isAbsolute(path) && resolve(path) === path,
      'CONTROL_ATTACHMENT_NOT_CONFIGURED',
    );
    const stat = lstatSync(path);
    requireUpgrade(
      stat.isFile() &&
        !stat.isSymbolicLink() &&
        (stat.mode & 0o077) === 0 &&
        stat.size <= 1048576 &&
        realpathSync(path) === path &&
        (!process.getuid || stat.uid === process.getuid() || stat.uid === 0),
      'CONTROL_ATTACHMENT_CONFIG_INSECURE',
    );
    const bytes = readFileSync(path);
    requireUpgrade(
      !rawDigest || upgradeDigest(bytes.toString('utf8')) === rawDigest,
      'CONTROL_ATTACHMENT_CONFIG_CHANGED',
    );
    return parseConfiguration(bytes.toString('utf8'));
  }

  onModuleDestroy(): void {
    this.connection?.close();
  }
}
