import 'reflect-metadata';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import {
  mkdtempSync,
  cpSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
  lstatSync,
  chmodSync,
  rmSync,
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { Test } from '@nestjs/testing';
import { Controller, Get, Inject } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { preparedConnection } from '../../../apps/api/src/platform/persistence/prepared-connection';
import { runMigrations } from '../../../apps/api/src/platform/persistence/drizzle.connection';
import { upgradeRecord } from '../../../apps/api/src/platform/upgrade/upgrade-values';
import { UpgradeStore } from '../../../apps/api/src/platform/upgrade/upgrade-store';
import { UpgradeLedgerConnection } from '../../../apps/api/src/platform/upgrade/upgrade-ledger-connection';
import { registerBusinessTransactionHook } from '../../../apps/api/src/platform/persistence/business-transaction-hooks';
import { UpgradeControlAttachment } from '../../../apps/api/src/platform/upgrade/upgrade-control-attachment';
import { UpgradeControlAttachmentController } from '../../../apps/api/src/platform/upgrade/upgrade-control-attachment.controller';
import { UpgradeLedgerAdmissionInterceptor } from '../../../apps/api/src/platform/upgrade/upgrade-ledger-admission.interceptor';
import { UpgradeInternalController } from '../../../apps/api/src/platform/upgrade/upgrade.controller';
import { UpgradeSecurity } from '../../../apps/api/src/platform/access-passcode/upgrade-security.service';
import { UpgradeService } from '../../../apps/api/src/platform/upgrade/upgrade-service';
import { CoordinatorHandoff } from '../../../apps/api/src/platform/upgrade/coordinator-handoff';
import { UpgradeRoleHandoffs } from '../../../apps/api/src/platform/upgrade/upgrade-role-handoffs';
import { UpgradeProjection } from '../../../apps/api/src/platform/upgrade/upgrade-projection';
import { UpgradeCatalog } from '../../../apps/api/src/platform/upgrade/upgrade-catalog';
import { UpgradeContractStore } from '../../../apps/api/src/platform/upgrade/upgrade-contract-store';
import { UpgradeContractService } from '../../../apps/api/src/platform/upgrade/upgrade-contract-service';
import type { UpgradeInspectionPort } from '../../../apps/api/src/platform/upgrade/upgrade-inspection.port';
import { UpgradeObserver } from '../../../apps/api/src/platform/upgrade/upgrade-observer';
import { UpgradeOnlineMigration } from '../../../apps/api/src/platform/upgrade/upgrade-online-migration';
import { CoordinatorRecovery } from '../../../apps/api/src/platform/upgrade/coordinator-recovery';
import { UPGRADE_CONTROL_SCHEMA_SQL } from '../../../apps/api/src/platform/upgrade/control-store-schema';
import {
  coordinatorWriterControl,
  fenceCoordinatorConnection,
} from '../../../apps/api/src/platform/persistence/coordinator-lease';
import {
  upgradeDigest,
  freezeUpgradePlan,
} from '../../../apps/api/src/platform/upgrade/upgrade-trust';
import { requiredUpgradeValue } from '../../../apps/api/src/platform/upgrade/upgrade-values';
import { planFixtureEnvelope, planFixtureSource } from '../../support/upgrade-plan-fixture';
import { deferred, stub, unused, useEnv } from '../../support/strict-ports';
import type { SignedUpgradeManifest } from '@platform/contracts';

const key = 'isolated-ledger-hot-attach-controller-key-32',
  instanceId = 'hot-attach-local';
const internal = { 'x-platform-internal-key': key, 'x-platform-instance-id': instanceId };
const BUSINESS_PROBE = Symbol('hot-attach-business-probe');
@Controller('hot-attach-business-probe')
class HotAttachBusinessProbe {
  constructor(@Inject(BUSINESS_PROBE) private readonly sqlite: Database.Database) {}
  @Get() read() {
    return this.sqlite.prepare('SELECT value FROM business_continuity_probe').all();
  }
}
const close: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const work of close.splice(0).reverse()) await work();
});
function producer<T>(input: unknown): T {
  const child = spawnSync(
    process.execPath,
    [resolve('acceptance/support/control-attachment-producer.mjs')],
    { input: JSON.stringify(input), encoding: 'utf8' },
  );
  if (child.status !== 0) throw Error(child.stderr || 'Actual JS fixture producer failed');
  return JSON.parse(child.stdout) as T;
}
async function fixture(options: { schema29?: boolean } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'upg-control-attach-')));
  close.push(() => rmSync(root, { recursive: true, force: true }));
  close.push(
    useEnv({
      PLATFORM_INSTANCE_ID: instanceId,
      PLATFORM_PROCESS_ROLE: undefined,
      PLATFORM_CONTROLLER_RPC_KEY: key,
      UPGRADE_CONTROL_DATABASE_PATH: undefined,
      PLATFORM_COORDINATOR_BINDING_PATH: undefined,
      MIGRATIONS_DIR: undefined,
      UPGRADE_CONTROL_ATTACH_FREEZE_PLAN_PATH: join(root, 'freeze.json'),
      UPGRADE_CONTROL_ATTACH_SPEC_PATH: join(root, 'attach.json'),
      UPGRADE_TRUST_ROOT_PATH: join(root, 'trust.json'),
      UPGRADE_CONTROL_ATTACH_SPEC_RAW_DIGEST: undefined,
      UPGRADE_CONTROL_ATTACH_FREEZE_PLAN_RAW_DIGEST: undefined,
    }),
  );
  const clock = { now: () => new Date() },
    businessPath = join(root, 'business.sqlite');
  const business = fenceCoordinatorConnection(new Database(businessPath), instanceId, clock, {
    next: randomUUID,
  });
  let migrationsFolder = resolve('drizzle');
  if (options.schema29) {
    migrationsFolder = join(root, 'schema29-prefix');
    cpSync(resolve('drizzle'), migrationsFolder, { recursive: true });
    const journalPath = join(migrationsFolder, 'meta', '_journal.json'),
      journal = upgradeRecord(JSON.parse(readFileSync(journalPath, 'utf8')));
    if (!Array.isArray(journal.entries)) throw Error('Original migration journal missing');
    journal.entries = journal.entries.slice(0, 29);
    writeFileSync(journalPath, JSON.stringify(journal), { mode: 0o600 });
    rmSync(join(migrationsFolder, '0029_upgrade_control_fast_path.sql'));
    process.env.MIGRATIONS_DIR = migrationsFolder;
  }
  migrate(drizzle(business), { migrationsFolder });
  close.push(() => {
    if (business.open) business.close();
  });
  business.exec('CREATE TABLE business_continuity_probe(value TEXT)');
  business.prepare("INSERT INTO business_continuity_probe VALUES('original')").run();
  const connection = new UpgradeLedgerConnection(clock),
    store = new UpgradeStore(business, clock, { next: randomUUID }, connection.options());
  const schema =
    business.prepare<unknown[], { n: number }>('SELECT count(*) n FROM __drizzle_migrations').get()
      ?.n ?? 0;
  const source = planFixtureSource(schema);
  source.components.installer.inputFingerprint = source.components.installer.artifactDigest;
  store.bootstrap(source);
  const manifest = {
    ...planFixtureEnvelope(source, '0.2.1').manifest,
    components: source.components,
  };
  const controlBody = {
    schemaVersion: 1 as const,
    kind: 'upgrade-control' as const,
    version: '0.2.1',
    protocolVersion: 1 as const,
    apiRevision: source.commits.api,
    projectRevision: source.commits.project,
    treeDigest: upgradeDigest({ isolatedTree: true }),
    executionEngineDigest: source.components.installer.artifactDigest,
  };
  const signedManifest = producer<SignedUpgradeManifest>({
    action: 'sign',
    root,
    instanceId,
    manifest: {
      ...manifest,
      controlPackage: {
        manifest: controlBody,
        manifestDigest: upgradeDigest(controlBody),
        package: {
          ...manifest.packages[0],
          name: 'isolated-control',
          digest: upgradeDigest({ isolatedControlTar: true }),
        },
      },
    },
  });
  const writer = coordinatorWriterControl(business),
    operationId = randomUUID();
  const plan = {
    schemaVersion: 1,
    kind: 'legacy-control-admission-freeze',
    instanceId,
    operationId,
    commandId: operationId + ':freeze',
    deadline: Date.now() + 30000,
    source: {
      activationGeneration: 1,
      confirmedDigest: upgradeDigest(source),
      businessWriterGeneration: writer.generation,
      businessWriterFence: writer.fence,
      schema,
    },
    target: {
      signedManifestDigest: signedManifest.manifestDigest,
      apiArtifactDigest: source.components.api.artifactDigest,
      coordinatorArtifactDigest: requiredUpgradeValue(source.components.coordinator).artifactDigest,
      projectRevision: source.commits.project,
      controlPackageDigest: upgradeDigest(controlBody),
    },
  };
  writeFileSync(join(root, 'freeze.json'), JSON.stringify({ spec: plan, signedManifest }), {
    mode: 0o600,
  });
  const service = new UpgradeControlAttachment(store, connection, business, clock);
  const security = { internal: UpgradeSecurity.prototype.internal };
  const module = await Test.createTestingModule({
    controllers: [UpgradeControlAttachmentController, UpgradeInternalController],
    providers: [
      { provide: UpgradeControlAttachment, useValue: service },
      { provide: UpgradeStore, useValue: store },
      { provide: UpgradeSecurity, useValue: security },
      { provide: UpgradeService, useValue: { store, security } },
      { provide: CoordinatorHandoff, useValue: {} },
      { provide: UpgradeRoleHandoffs, useValue: {} },
      { provide: UpgradeObserver, useValue: {} },
      { provide: UpgradeOnlineMigration, useValue: {} },
      { provide: CoordinatorRecovery, useValue: {} },
    ],
  }).compile();
  const app = module.createNestApplication({ logger: false });
  app.useGlobalInterceptors(
    new UpgradeLedgerAdmissionInterceptor(store, security as UpgradeSecurity),
  );
  await app.init();
  close.push(async () => {
    await app.close();
    connection.onModuleDestroy();
  });
  const freezeInput = { operationId, commandId: plan.commandId, specDigest: upgradeDigest(plan) };
  const freeze = () => service.freeze(freezeInput);
  const prepareAttach = () => {
    const controlPath = join(root, 'control.sqlite'),
      control = new Database(controlPath);
    control.exec(UPGRADE_CONTROL_SCHEMA_SQL);
    control.exec(
      'CREATE TABLE control_store_metadata(singleton INTEGER PRIMARY KEY,instance_id TEXT,schema_version INTEGER)',
    );
    control.prepare('INSERT INTO control_store_metadata VALUES(1,?,1)').run(instanceId);
    const controlStore = new UpgradeStore(
      control,
      clock,
      { next: randomUUID },
      { instanceId, independent: true },
    );
    controlStore.bootstrap(source);
    control.close();
    chmodSync(controlPath, 0o600);
    const stat = lstatSync(controlPath, { bigint: true });
    const spec = {
      schemaVersion: 1,
      kind: 'legacy-control-ledger-attach',
      instanceId,
      operationId,
      commandId: operationId + ':attach',
      epoch: 1,
      executorId: 'isolated-adoption-executor',
      deadline: plan.deadline,
      source: plan.source,
      target: plan.target,
      freezeReceiptDigest: requiredUpgradeValue(connection.frozenReceipt()).receiptDigest,
      controlDatabase: { path: controlPath, dev: String(stat.dev), ino: String(stat.ino) },
      settlement: { operationId, commandId: operationId + ':settlement' },
    };
    writeFileSync(join(root, 'attach.json'), JSON.stringify({ spec, signedManifest }), {
      mode: 0o600,
    });
    const actual = producer<{ specDigest: string; settlementResultDigest: string }>({
      action: 'reserve',
      root,
      spec,
      businessPath,
    });
    return { spec, input: { operationId, commandId: spec.commandId, ...actual }, controlPath };
  };
  return {
    root,
    business,
    businessPath,
    migrationsFolder,
    clock,
    writer,
    connection,
    store,
    service,
    plan,
    signedManifest,
    security,
    source,
    app,
    freezeInput,
    freeze,
    prepareAttach,
  };
}

describe('fixed hot Control ledger attachment — real SQLite/Nest and actual JS passive reservation', () => {
  it('freezes durably then atomically attaches readonly without releasing the real business writer', async () => {
    const f = await fixture();
    await request(f.app.getHttpServer())
      .get('/internal/upgrades/pending')
      .set(internal)
      .expect(200);
    const result = await request(f.app.getHttpServer())
      .post('/internal/upgrade-control-attachment/freeze')
      .set(internal)
      .send(f.freezeInput)
      .expect(201);
    expect(result.body).toMatchObject({
      kind: 'legacy-control-admission-frozen',
      localLegacyWorkSettled: true,
      controlActivated: false,
    });
    await request(f.app.getHttpServer())
      .get('/internal/upgrades/pending')
      .set(internal)
      .expect(409);
    const a = f.prepareAttach(),
      writerBefore = { generation: f.writer.generation, fence: f.writer.fence };
    const attached = await request(f.app.getHttpServer())
      .post('/internal/upgrade-control-attachment/attach')
      .set(internal)
      .send(a.input)
      .expect(201);
    expect(attached.body).toMatchObject({
      readonly: true,
      controlActivated: false,
      authorizesEntryMutation: false,
      businessWriter: writerBefore,
    });
    expect(f.store.ledgerReadonly).toBe(true);
    expect(f.store.ledgerSqlite.readonly).toBe(true);
    expect(() =>
      f.store.ledgerSqlite.prepare('UPDATE upgrade_instances SET ready=0').run(),
    ).toThrow();
    f.business.prepare("INSERT INTO business_continuity_probe VALUES('after')").run();
    expect(f.business.prepare('SELECT value FROM business_continuity_probe').all()).toHaveLength(2);
    expect(() => f.writer.assert()).not.toThrow();
    expect(await f.service.attach(a.input)).toEqual(attached.body);
    const status = await request(f.app.getHttpServer())
      .get('/internal/upgrade-control-attachment')
      .set(internal)
      .expect(200);
    expect(status.body.attachment).toMatchObject({
      phase: 'attached',
      attachSpecDigest: a.input.specDigest,
      attachedReceipt: attached.body,
      resultDigest: upgradeDigest(attached.body),
    });
    expect(() => f.service.attach({ ...a.input, commandId: 'wrong-original' })).toThrow(
      'CONTROL_ATTACHMENT_INTENT_CONFLICT',
    );
    const restarted = new UpgradeLedgerConnection(f.clock);
    new UpgradeStore(f.business, f.clock, { next: randomUUID }, restarted.options());
    close.push(() => restarted.onModuleDestroy());
    expect(restarted.readonly).toBe(true);
    expect(restarted.attachmentStatus()).toEqual(status.body.attachment);
    const control = new Database(a.controlPath, { readonly: true });
    expect(control.prepare('SELECT mode FROM control_authority').get()).toEqual({
      mode: 'passive',
    });
    control.close();
  });
  it('authenticates before freeze rejection and cannot replace the fixed source/target/path through HTTP', async () => {
    const f = await fixture();
    await request(f.app.getHttpServer())
      .post('/internal/upgrade-control-attachment/freeze')
      .send(f.freezeInput)
      .expect(403);
    await expect(
      f.service.freeze({ ...f.freezeInput, specDigest: upgradeDigest({ wrong: true }) }),
    ).rejects.toThrow('CONTROL_ATTACHMENT_INTENT_CONFLICT');
    expect(f.connection.frozen).toBe(false);
    expect(
      f.business
        .prepare("SELECT name FROM sqlite_master WHERE name='upgrade_control_attachment'")
        .get(),
    ).toBeUndefined();
    await f.freeze();
    await request(f.app.getHttpServer()).get('/internal/upgrades/pending').expect(403);
    const a = f.prepareAttach();
    await expect(
      f.service.attach({ ...a.input, settlementResultDigest: upgradeDigest({ wrong: true }) }),
    ).rejects.toThrow('LEGACY_CONTROL_SETTLEMENT_RECEIPT_REQUIRED');
    expect(f.store.ledgerReadonly).toBe(false);
  });
  it('keeps original async/statement capabilities in the old epoch and waits for actual completion', async () => {
    const f = await fixture(),
      blocked = deferred<void>(),
      entered = deferred<void>();
    close.push(() => blocked.resolve());
    const original = f.store.runLedgerWork(async () => {
      const statement = f.store.ledgerSqlite.prepare(
        'SELECT ready FROM upgrade_instances WHERE instance_id=?',
      );
      entered.resolve();
      await blocked.promise;
      expect(() => f.store.assertControlAdmissionAvailable()).toThrow(
        'LEGACY_CONTROL_ADMISSION_FROZEN',
      );
      return statement.get(instanceId);
    });
    await entered.promise;
    const frozen = f.freeze();
    let settled = false;
    void frozen.then(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(f.connection.frozen).toBe(true));
    expect(settled).toBe(false);
    expect(f.connection.legacyWorkSnapshot().active).toBe(1);
    expect(() => f.store.runLedgerWork(() => f.store.pending())).toThrow(
      'LEGACY_CONTROL_ADMISSION_FROZEN',
    );
    blocked.resolve();
    expect(await original).toEqual({ ready: 1 });
    await frozen;
    const chained = f.store.ledgerSqlite.prepare('UPDATE upgrade_instances SET ready=?').bind(0),
      database = chained.database,
      stale = f.store.ledgerSqlite.prepare('SELECT ready FROM upgrade_instances'),
      queued = f.store.captureLedgerWork(() => f.store.instance());
    expect(() =>
      f.store.ledgerSqlite.prepare('SELECT ready FROM upgrade_instances').iterate(),
    ).toThrow('CONTROL_LEDGER_LAZY_CURSOR_UNSUPPORTED');
    const a = f.prepareAttach();
    await f.service.attach(a.input);
    expect(() => chained.run()).toThrow('CONTROL_LEDGER_EPOCH_SUPERSEDED');
    expect(() => database.prepare('SELECT 1')).toThrow('CONTROL_LEDGER_EPOCH_SUPERSEDED');
    expect(() => stale.get()).toThrow('CONTROL_LEDGER_EPOCH_SUPERSEDED');
    expect(() => queued()).toThrow('CONTROL_LEDGER_EPOCH_SUPERSEDED');
    expect(f.store.controlCapabilities()).toMatchObject({ controlFastPath: 1 });
  });
  it('refuses a new original intent from an HTTP-era task that was already waiting when freeze closed admission', async () => {
    const f = await fixture(),
      gate = deferred<void>(),
      plan = freezeUpgradePlan(f.signedManifest, f.source);
    close.push(() => gate.resolve());
    const original = f.store.runLedgerWork(async () => {
      await gate.promise;
      return f.store.accept(
        'inflight-original-request',
        {
          requestId: randomUUID(),
          targetReleaseId: f.signedManifest.manifest.releaseId,
          targetDigest: f.signedManifest.manifestDigest,
          expectedActivationGeneration: 1,
        },
        f.signedManifest,
        plan,
      );
    });
    const rejected = expect(original).rejects.toThrow('LEGACY_CONTROL_ADMISSION_FROZEN');
    const frozen = f.freeze();
    await vi.waitFor(() => expect(f.connection.frozen).toBe(true));
    gate.resolve();
    await rejected;
    await frozen;
    expect(f.store.pending().attempts).toHaveLength(0);
    expect(f.connection.legacyWorkSnapshot().active).toBe(0);
  });
  it('keeps the whole asynchronous projection contract read in its original ledger work scope', async () => {
    const f = await fixture(),
      gate = deferred<{ authority: 'legacy'; availablePlan: null; attempt: null }>();
    let entered = 0;
    const projection = new UpgradeProjection(
      f.store,
      stub<UpgradeCatalog>({ refresh: async () => undefined }, 'explicit metadata refresh port'),
      stub<UpgradeInspectionPort>({}, 'unqualified physical observation port'),
      f.clock,
      stub<UpgradeContractService>(
        {
          status: () => {
            entered++;
            return gate.promise;
          },
        },
        'explicit asynchronous contract read port',
      ),
    );
    close.push(() => projection.onModuleDestroy());
    close.push(() => gate.resolve({ authority: 'legacy', availablePlan: null, attempt: null }));
    projection.schedule();
    await vi.waitFor(() => expect(entered).toBe(1));
    expect(f.connection.legacyWorkSnapshot().active).toBeGreaterThan(0);
    const value = { authority: 'legacy' as const, availablePlan: null, attempt: null };
    gate.resolve(value);
    await vi.waitFor(() => expect(projection.view().contract).toEqual(value));
    await vi.waitFor(() => expect(f.connection.legacyWorkSnapshot().active).toBe(0));
  });
  it('preserves the real business transaction hook before freeze and after readonly attachment', async () => {
    const f = await fixture();
    let committed = 0;
    expect(f.store.sqlite).toBe(f.business);
    registerBusinessTransactionHook(f.store.sqlite, () => {
      committed++;
    });
    f.business.prepare("INSERT INTO business_continuity_probe VALUES('before-freeze')").run();
    expect(committed).toBe(1);
    await f.freeze();
    const frozenBaseline = committed;
    f.business.prepare("INSERT INTO business_continuity_probe VALUES('frozen-control')").run();
    expect(committed).toBe(frozenBaseline + 1);
    const a = f.prepareAttach();
    await f.service.attach(a.input);
    const attachedBaseline = committed;
    f.business.prepare("INSERT INTO business_continuity_probe VALUES('attached-control')").run();
    expect(committed).toBe(attachedBaseline + 1);
    expect(() => f.writer.assert()).not.toThrow();
  });
  it('returns HTTP409 for the original freeze timeout while preserving the durable scope and actual pending Promise', async () => {
    const f = await fixture(),
      gate = deferred<void>();
    close.push(() => gate.resolve());
    const plan = { ...f.plan, deadline: Date.now() + 500 },
      input = { ...f.freezeInput, specDigest: upgradeDigest(plan) };
    writeFileSync(
      join(f.root, 'freeze.json'),
      JSON.stringify({ spec: plan, signedManifest: f.signedManifest }),
      { mode: 0o600 },
    );
    let executions = 0;
    const original = f.store.runLedgerWork(async () => {
      executions++;
      await gate.promise;
      return f.store.instance();
    });
    const response = await request(f.app.getHttpServer())
      .post('/internal/upgrade-control-attachment/freeze')
      .set(internal)
      .send(input)
      .expect(409);
    expect(response.body.code).toBe('LEGACY_CONTROL_WORK_NOT_SETTLED');
    expect(executions).toBe(1);
    expect(f.connection.legacyWorkSnapshot()).toMatchObject({
      admissionClosed: true,
      active: 1,
      epoch: 1,
    });
    const receipt = f.connection.frozenReceipt();
    expect(receipt?.specDigest).toBe(input.specDigest);
    await request(f.app.getHttpServer())
      .post('/internal/upgrade-control-attachment/freeze')
      .set(internal)
      .send(input)
      .expect(409);
    expect(f.connection.frozenReceipt()).toEqual(receipt);
    expect(f.business.prepare('SELECT count(*) n FROM upgrade_control_attachment').get()).toEqual({
      n: 1,
    });
    expect(f.store.ledgerReadonly).toBe(false);
    expect(() => f.writer.assert()).not.toThrow();
    gate.resolve();
    expect(await original).toMatchObject({ ready: 1 });
    expect(executions).toBe(1);
    expect(f.connection.legacyWorkSnapshot().active).toBe(0);
  });
  it('uses actual schema29 fallback for the old accept/claim/renew/commit protocol and rejects unsupported fast RPCs', async () => {
    const f = await fixture({ schema29: true }),
      plan = freezeUpgradePlan(f.signedManifest, f.source);
    expect(f.source.schema).toBe(29);
    expect(f.store.controlCapabilities()).toEqual({ progressEvidenceReference: 1 });
    expect(f.business.pragma('table_info(upgrade_attempts)')).not.toContainEqual(
      expect.objectContaining({ name: 'plan_digest' }),
    );
    expect(f.business.pragma('table_info(upgrade_steps)')).not.toContainEqual(
      expect.objectContaining({ name: 'evidence_digest' }),
    );
    const attempt = f.store.accept(
        'schema29-old-controller',
        {
          requestId: randomUUID(),
          targetReleaseId: f.signedManifest.manifest.releaseId,
          targetDigest: f.signedManifest.manifestDigest,
          expectedActivationGeneration: 1,
        },
        f.signedManifest,
        plan,
      ),
      claim = f.store.claim(attempt.attemptId, 'schema29-old-controller', 30000),
      step = plan.steps[0],
      evidence = { scope: 'local-schema29-legacy-commit-only' },
      command = {
        fence: claim.fence,
        generation: claim.generation,
        expectedSequence: f.store.attempt(attempt.attemptId).sequence,
        eventId: randomUUID(),
        kind: 'step-applied' as const,
        payload: {
          stepId: step.stepId,
          completedWork: step.totalWork,
          evidence,
          receiptDigest: upgradeDigest(evidence),
        },
      };
    expect(f.store.snapshot(attempt.attemptId).plan.planDigest).toBe(plan.planDigest);
    expect(f.store.renew(attempt.attemptId, claim.fence, 'schema29-old-controller').fence).toBe(
      claim.fence,
    );
    f.store.commit(attempt.attemptId, command);
    expect(f.store.snapshot(attempt.attemptId).appliedSteps.map((s) => s.stepId)).toContain(
      step.stepId,
    );
    expect(() => f.store.authorityCheck(attempt.attemptId, claim.fence, claim.generation)).toThrow(
      'UPGRADE_CONTROL_METADATA_UNKNOWN',
    );
    expect(() =>
      f.store.leaseRenew(
        attempt.attemptId,
        claim.fence,
        claim.generation,
        'schema29-old-controller',
      ),
    ).toThrow('UPGRADE_CONTROL_METADATA_UNKNOWN');
    expect(() =>
      f.store.progressCheckpoint(attempt.attemptId, claim.fence, claim.generation),
    ).toThrow('UPGRADE_CONTROL_METADATA_UNKNOWN');
    expect(() => f.store.commitReceipt(attempt.attemptId, command)).toThrow(
      'UPGRADE_CONTROL_METADATA_UNKNOWN',
    );
  });
  it('prepares against the real 29-prefix without applying migration30, then freezes and attaches full independent control metadata', async () => {
    const f = await fixture({ schema29: true });
    runMigrations(drizzle(f.business), f.business);
    const prepared = preparedConnection(f.businessPath, instanceId);
    try {
      expect(
        prepared.connection.sqlite.prepare('SELECT count(*) n FROM __drizzle_migrations').get(),
      ).toEqual({ n: 29 });
    } finally {
      prepared.connection.sqlite.close();
    }
    await f.freeze();
    const a = f.prepareAttach();
    await f.service.attach(a.input);
    expect(f.business.prepare('SELECT count(*) n FROM __drizzle_migrations').get()).toEqual({
      n: 29,
    });
    expect(f.business.pragma('table_info(upgrade_steps)')).not.toContainEqual(
      expect.objectContaining({ name: 'evidence_digest' }),
    );
    expect(f.store.controlCapabilities()).toMatchObject({ controlFastPath: 1 });
    expect(() => f.writer.assert()).not.toThrow();
  });
  it('boots a real new Nest lifecycle after durable freeze without attaching, while the reopened business writer serves HTTP', async () => {
    const f = await fixture();
    await f.freeze();
    await f.app.close();
    f.connection.onModuleDestroy();
    f.business.close();
    const business = fenceCoordinatorConnection(new Database(f.businessPath), instanceId, f.clock, {
      next: randomUUID,
    });
    close.push(() => {
      if (business.open) business.close();
    });
    const connection = new UpgradeLedgerConnection(f.clock),
      store = new UpgradeStore(business, f.clock, { next: randomUUID }, connection.options());
    close.push(() => connection.onModuleDestroy());
    expect(connection.frozen).toBe(true);
    expect(connection.readonly).toBe(false);
    const catalog = unused<UpgradeCatalog>('frozen legacy catalog'),
      inspector = unused<UpgradeInspectionPort>('frozen legacy inspector'),
      security = f.security as UpgradeSecurity,
      contracts = new UpgradeContractService(
        new UpgradeContractStore(store, f.clock, { next: randomUUID }),
        unused('frozen contract business'),
        inspector,
        security,
        f.clock,
      ),
      upgrades = new UpgradeService(store, catalog, security, inspector, f.clock),
      projection = new UpgradeProjection(store, catalog, inspector, f.clock),
      recovery = new CoordinatorRecovery(
        store,
        unused('frozen recovery inspector'),
        unused('frozen migrations'),
        unused('frozen applications'),
        unused('frozen task pump'),
        unused('frozen automations'),
        unused('frozen provisions'),
        unused('frozen clones'),
        unused('frozen events'),
        unused('frozen tasks'),
        unused('frozen terminals'),
        unused('frozen Owners'),
        f.clock,
      ),
      attachment = new UpgradeControlAttachment(store, connection, business, f.clock);
    const module = await Test.createTestingModule({
      controllers: [
        HotAttachBusinessProbe,
        UpgradeControlAttachmentController,
        UpgradeInternalController,
      ],
      providers: [
        { provide: BUSINESS_PROBE, useValue: business },
        { provide: UpgradeControlAttachment, useValue: attachment },
        { provide: UpgradeService, useValue: upgrades },
        { provide: UpgradeProjection, useValue: projection },
        { provide: UpgradeContractService, useValue: contracts },
        { provide: CoordinatorRecovery, useValue: recovery },
        { provide: UpgradeSecurity, useValue: security },
        { provide: CoordinatorHandoff, useValue: {} },
        { provide: UpgradeRoleHandoffs, useValue: {} },
        { provide: UpgradeObserver, useValue: {} },
        { provide: UpgradeOnlineMigration, useValue: {} },
      ],
    }).compile();
    const app = module.createNestApplication({ logger: false });
    app.useGlobalInterceptors(new UpgradeLedgerAdmissionInterceptor(store, security));
    close.push(async () => {
      await app.close();
    });
    const lifecycle = useEnv({
      PLATFORM_PROCESS_ROLE: 'coordinator',
      COORDINATOR_WRITER_FENCE_VALID: 'true',
    });
    close.push(lifecycle);
    await app.init();
    await request(app.getHttpServer()).get('/hot-attach-business-probe').expect(200);
    await request(app.getHttpServer()).get('/internal/upgrades/pending').set(internal).expect(409);
    const status = await request(app.getHttpServer())
      .get('/internal/upgrade-control-attachment')
      .set(internal)
      .expect(200);
    expect(status.body).toMatchObject({ admissionClosed: true, readonly: false, active: 0 });
    expect(status.body.businessWriter.generation).toBeGreaterThan(f.writer.generation);
    business.prepare("INSERT INTO business_continuity_probe VALUES('after-restart')").run();
    expect(() => coordinatorWriterControl(business).assert()).not.toThrow();
  });
  it('uses only fixed adoption input names next to the existing configured Coordinator binding', async () => {
    const f = await fixture(),
      directory = join(f.root, 'bindings', 'control-adoption');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    process.env.PLATFORM_COORDINATOR_BINDING_PATH = join(f.root, 'bindings', 'coordinator.json');
    delete process.env.UPGRADE_CONTROL_ATTACH_FREEZE_PLAN_PATH;
    writeFileSync(
      join(directory, 'freeze.json'),
      JSON.stringify({ spec: f.plan, signedManifest: f.signedManifest }),
      { mode: 0o600 },
    );
    await f.freeze();
    const a = f.prepareAttach();
    writeFileSync(
      join(directory, 'attach.json'),
      JSON.stringify({ spec: a.spec, signedManifest: f.signedManifest }),
      { mode: 0o600 },
    );
    delete process.env.UPGRADE_CONTROL_ATTACH_SPEC_PATH;
    await expect(f.service.attach(a.input)).resolves.toMatchObject({
      readonly: true,
      controlActivated: false,
    });
  });
  it('rejects active authority, changed passive lease and changed fixed command before cutting the ledger', async () => {
    for (const mutation of [
      "UPDATE control_authority SET mode='active'",
      "UPDATE control_authority SET holder_id='foreign'",
      "UPDATE control_commands SET executor_id='foreign' WHERE step_id='isolated-legacy-settlement'",
      "UPDATE control_commands SET state='unknown' WHERE step_id='legacy-control-ledger-attach'",
    ]) {
      const f = await fixture();
      await f.freeze();
      const a = f.prepareAttach(),
        control = new Database(a.controlPath);
      control.exec(mutation);
      control.close();
      await expect(f.service.attach(a.input)).rejects.toThrow();
      expect(f.store.ledgerReadonly).toBe(false);
      expect(() => f.writer.assert()).not.toThrow();
    }
  });
});
