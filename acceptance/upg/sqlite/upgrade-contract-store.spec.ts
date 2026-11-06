import { assertDefined } from '../../support/assert-defined';
import 'reflect-metadata';
import { randomUUID, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ConfirmedServiceReleaseSchema,
  UpgradeManifestSchema,
  UpgradeContractPlanSchema,
  type ConfirmedServiceRelease,
  type SignedUpgradeManifest,
  type UpgradeContractRequest,
} from '@platform/contracts';
import { fromEpochMs, type Clock } from '@platform/shared-kernel';
import {
  createConnection,
  runMigrations,
  type Connection,
} from '../../../apps/api/src/platform/persistence/drizzle.connection';
import {
  UpgradeStore,
  type UpgradeCommit,
} from '../../../apps/api/src/platform/upgrade/upgrade-store';
import { UpgradeContractStore } from '../../../apps/api/src/platform/upgrade/upgrade-contract-store';
import {
  canonicalUpgrade,
  freezeUpgradePlan,
  upgradeDigest,
} from '../../../apps/api/src/platform/upgrade/upgrade-trust';
import { useEnv } from '../../support/strict-ports';
import Database from 'better-sqlite3';
import { UpgradeContractBusiness } from '../../../apps/api/src/platform/upgrade/upgrade-contract-business';
import {
  UpgradeOnlineMigration,
  OnlineMigrationPlanSchema,
} from '../../../apps/api/src/platform/upgrade/upgrade-online-migration';
import { createUpgradeControlStores } from '../../../apps/api/src/platform/upgrade/control-store-factory';
import { withContractRequest } from '../../../apps/api/src/platform/upgrade/upgrade-contract-control';
import {
  fenceCoordinatorConnection,
  coordinatorWriterControl,
} from '../../../apps/api/src/platform/persistence/coordinator-lease';

// Real committed SQLite and production ledgers. The signed manifest/receipts
// here are explicit STATE-layer input, never trusted/native qualification proof.
let connection: Connection,
  upgrades: UpgradeStore,
  contracts: UpgradeContractStore,
  root = '';
let now = Date.parse('2026-10-12T05:00:00Z'),
  restore = () => {};
const clock: Clock = { now: () => fromEpochMs(now) },
  ids = { next: () => randomUUID() };
const signing = generateKeyPairSync('ed25519');
function current(releaseId = '0.2.0', activationGeneration = 1): ConfirmedServiceRelease {
  const artifact = {
    artifactDigest: upgradeDigest({ scope: 'contract-store-only' }),
    inputFingerprint: upgradeDigest({ input: 'state-only' }),
    sourceRevision: 'a'.repeat(40),
    protocol: { min: 1, max: 2 },
  };
  return ConfirmedServiceReleaseSchema.parse({
    releaseId,
    activationGeneration,
    activatedAt: clock.now().toISOString(),
    schema: (
      connection.sqlite.prepare('SELECT count(*) n FROM __drizzle_migrations').get() as {
        n: number;
      }
    ).n,
    channel: 'contract-state-only',
    components: {
      api: artifact,
      coordinator: artifact,
      installer: artifact,
      web: { ...artifact, webRevision: 'a'.repeat(40) },
    },
    commits: { project: 'a'.repeat(40), api: 'a'.repeat(40), web: 'a'.repeat(40) },
    productionWebBinding: 'http://127.0.0.1/state-only',
  });
}
function envelope(source = current(), releaseId = '0.2.1'): SignedUpgradeManifest {
  const artifact = source.components.api;
  const manifest = UpgradeManifestSchema.parse({
    schemaVersion: 2,
    releaseId,
    channel: source.channel,
    publishedAt: clock.now().toISOString(),
    components: source.components,
    commits: source.commits,
    packages: [
      {
        platform: process.platform,
        arch: process.arch,
        name: 'contract-state-only.tgz',
        url: 'https://state.invalid/archive.tgz',
        digest: upgradeDigest({ scope: 'state-only-package' }),
        bytes: 1,
        format: 'native-tar',
      },
    ],
    upgradePaths: [
      {
        fromRelease: source.releaseId,
        minSchema: source.schema,
        maxSchema: source.schema,
        targetSchema: source.schema,
        bridgeReleases: [],
        migrationPlanDigest: null,
      },
    ],
    policy: {
      id: 'contract-store-only',
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
      migrationBatchMs: 50,
      maxWalBytes: 67108864,
      minFreeBytes: 1,
      fallbacks: [
        {
          releaseId: source.releaseId,
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
  return {
    manifest,
    manifestDigest: upgradeDigest(manifest),
    signature: {
      algorithm: 'Ed25519',
      keyId: 'state-only',
      value: sign(null, Buffer.from(canonicalUpgrade(manifest)), signing.privateKey).toString(
        'base64',
      ),
    },
  };
}
function fixed() {
  const facts = {
    schemaVersion: 1,
    kind: 'project-name-contract',
    expandPlanDigest: upgradeDigest({ scope: 'state-only-expand' }),
    targetTable: 'upg_shadow_projects',
    nameColumn: 'display_name',
    artifactInputFingerprint: current().components.api.inputFingerprint,
    rollbackWindowMs: 60000,
    maxValidationRows: 1000,
    maxBatchRows: 2,
    batchBudgetMs: 50,
    minFreeBytes: 1,
    maxWalBytes: 67108864,
    preserveUserResources: true,
    rollbackToLegacy: false,
  };
  const plan = UpgradeContractPlanSchema.parse({ ...facts, planDigest: upgradeDigest(facts) });
  return {
    plan,
    signedManifest: envelope(),
    expandAttemptId: randomUUID(),
    readers: [],
    eligibility: { scope: 'state-layer-only' },
  };
}
function command(planDigest = fixed().plan.planDigest): UpgradeContractRequest {
  return {
    requestId: randomUUID(),
    targetPlanDigest: planDigest,
    expectedActivationGeneration: upgrades.instance().activation_generation,
    acknowledgeRollbackClosure: true,
  };
}
function accept(actor = 'actor-a', input = command(), floor = 0) {
  return contracts.accept(actor, input, fixed(), floor);
}
function upgrade() {
  const source = assertDefined(upgrades.confirmed()),
    signed = envelope(source, '0.2.1'),
    plan = freezeUpgradePlan(signed, source);
  const intent = upgrades.accept(
    'state-upgrade-actor',
    {
      requestId: randomUUID(),
      targetReleaseId: signed.manifest.releaseId,
      targetDigest: signed.manifestDigest,
      expectedActivationGeneration: source.activationGeneration,
    },
    signed,
    plan,
  );
  upgrades.claim(intent.attemptId, 'state-controller', 30000);
  return intent.attemptId;
}
function event(
  id: string,
  kind: UpgradeCommit['kind'],
  payload: Record<string, unknown>,
): UpgradeCommit {
  const snapshot = upgrades.snapshot(id);
  return {
    eventId: randomUUID(),
    fence: snapshot.fence,
    generation: snapshot.attempt.generation,
    expectedSequence: snapshot.attempt.sequence,
    kind,
    payload,
  };
}
function activate(id: string) {
  for (const step of upgrades.plan(id).steps) {
    const evidence = { scope: 'state-only-not-native', step: step.stepId };
    upgrades.commit(
      id,
      event(id, 'step-applied', {
        stepId: step.stepId,
        completedWork: step.totalWork ?? 1,
        evidence,
        receiptDigest: upgradeDigest(evidence),
      }),
    );
  }
  upgrades.commit(id, event(id, 'activation-confirmed', {}), current('0.2.1', 2));
}
function count() {
  return (
    connection.sqlite
      .prepare("SELECT count(*) n FROM platform_operations WHERE role='project-name-contract'")
      .get() as { n: number }
  ).n;
}
function contractBusinessFixture() {
  const migrationPlan = OnlineMigrationPlanSchema.parse({
    schemaVersion: 1,
    kind: 'expand-shadow',
    fromSchema: current().schema,
    targetSchema: current().schema,
    maxBatchRows: 2,
    oldRepresentationRetained: true,
    newSemanticsEnabled: false,
    projections: [
      {
        sourceTable: 'projects',
        primaryKey: 'id',
        targetTable: 'upg_shadow_projects',
        fields: [{ name: 'display_name', source: 'name', type: 'text' }],
      },
    ],
  });
  const digest = upgradeDigest(migrationPlan);
  connection.sqlite
    .prepare("INSERT INTO upgrade_online_migrations VALUES(?,?,?,'complete',?,3,1,0,NULL,?)")
    .run(
      digest,
      'state-fixture-expand',
      canonicalUpgrade(migrationPlan),
      canonicalUpgrade({ phase: 'complete' }),
      now,
    );
  connection.sqlite.exec(
    'CREATE TABLE upg_shadow_projects(row_key TEXT PRIMARY KEY,row_revision INTEGER,tombstone INTEGER,display_name TEXT)',
  );
  for (let n = 0; n < 3; n++) {
    connection.sqlite
      .prepare(
        "INSERT INTO projects(id,name,source_type,clone_status,baseline_path,created_at,updated_at) VALUES(?,?,'empty','ready',?,?,?)",
      )
      .run(
        'p' + String(n),
        'Name ' + String(n),
        '/isolated/contract-project-' + String(n),
        now,
        now,
      );
    connection.sqlite
      .prepare('INSERT INTO upg_shadow_projects VALUES(?,1,0,?)')
      .run('p' + String(n), 'Name ' + String(n));
  }
  const { planDigest: _oldDigest, ...facts } = fixed().plan,
    spec = { ...facts, expandPlanDigest: digest, batchBudgetMs: 1000 };
  const plan = UpgradeContractPlanSchema.parse({ ...spec, planDigest: upgradeDigest(spec) });
  return { ...fixed(), plan };
}
beforeEach(() => {
  now = Date.parse('2026-10-12T05:00:00Z');
  root = mkdtempSync(join(tmpdir(), 'upg-contract-ledger-'));
  restore = useEnv({ PLATFORM_INSTANCE_ID: 'contract-ledger-test-instance' });
  connection = createConnection(join(root, 'platform.sqlite'));
  runMigrations(connection.db, connection.sqlite);
  upgrades = new UpgradeStore(connection.sqlite, clock, ids);
  upgrades.bootstrap(current());
  contracts = new UpgradeContractStore(upgrades, clock, ids);
});
afterEach(() => {
  connection.sqlite.close();
  restore();
  rmSync(root, { recursive: true, force: true });
});
describe('UPG actual SQLite independent semantic contract intent and authority', () => {
  it('commits actual semantic effects, durable command receipt and legacy control progress atomically; replay cannot clear twice', () => {
    const fixedInput = contractBusinessFixture();
    let record = contracts.accept(
      'state-actor',
      command(fixedInput.plan.planDigest),
      fixedInput,
      0,
    );
    record = contracts.save(record, {
      state: 'retiring-readers',
      stage: 'state fixture reader gate',
    });
    const business = new UpgradeContractBusiness(
      contracts,
      new UpgradeOnlineMigration(upgrades, clock),
      undefined as never,
      clock,
    );
    expect(() =>
      business.activate(record, () => {
        throw new Error('fixture progress transaction failed');
      }),
    ).toThrow('fixture progress transaction failed');
    expect(
      connection.sqlite.prepare('SELECT read_epoch FROM upgrade_online_migrations').get(),
    ).toEqual({ read_epoch: 1 });
    expect(
      business.lookup(
        record.attempt.contractAttemptId,
        record.attempt.contractAttemptId + ':activate',
      ),
    ).toBeNull();
    business.activate(record, (total) => {
      record = contracts.save(record, {
        state: 'authority-active',
        stage: 'activated',
        totalRows: total,
      });
    });
    const clearRecord = record,
      clearCommand = {
        action: 'clear' as const,
        contractAttemptId: record.attempt.contractAttemptId,
        fence: record.fence,
        expectedSequence: record.attempt.sequence,
        commandId: record.attempt.contractAttemptId + ':clear:' + String(record.attempt.sequence),
      };
    business.clear(record, (batch) => {
      record = contracts.save(record, {
        state: batch.complete ? 'completed' : 'clearing',
        stage: 'clear actual batch',
        completedRows: record.attempt.completedRows + batch.cleared,
      });
    });
    const once = connection.sqlite.prepare('SELECT id,name FROM projects ORDER BY id').all(),
      receipt = business.lookup(clearRecord.attempt.contractAttemptId, clearCommand.commandId);
    expect(business.execute(clearCommand)).toEqual(receipt);
    expect(connection.sqlite.prepare('SELECT id,name FROM projects ORDER BY id').all()).toEqual(
      once,
    );
    expect(record.attempt.completedRows).toBe(2);
    business.clear(record, (batch) => {
      record = contracts.save(record, {
        state: batch.complete ? 'completed' : 'clearing',
        stage: 'clear final actual batch',
        completedRows: record.attempt.completedRows + batch.cleared,
      });
    });
    expect(record.attempt).toMatchObject({ state: 'completed', completedRows: 3 });
    expect(
      connection.sqlite
        .prepare('SELECT display_name FROM upg_shadow_projects ORDER BY row_key')
        .all(),
    ).toEqual([{ display_name: 'Name 0' }, { display_name: 'Name 1' }, { display_name: 'Name 2' }]);
  });
  it('keeps fixed contract fence separate from a reclaimed global epoch in an actual independent ledger', () => {
    const fixedInput = contractBusinessFixture(),
      control = new Database(join(root, 'independent-control.db'));
    const controlStores = createUpgradeControlStores({
      sqlite: control,
      instanceId: upgrades.instanceId,
      clock,
      ids,
      claimGuard: () => null,
      dataFormatGuard: () => {},
    });
    controlStores.store.bootstrap(current());
    let record = controlStores.contracts.accept(
      'state-actor',
      command(fixedInput.plan.planDigest),
      fixedInput,
      0,
    );
    record = controlStores.contracts.save(record, {
      state: 'retiring-readers',
      stage: 'qualified state fixture',
    });
    const epoch = record.fence + 100,
      id = record.attempt.contractAttemptId;
    control.exec(
      'CREATE TABLE control_authority(instance_id TEXT PRIMARY KEY,epoch INTEGER,operation_id TEXT,kind TEXT,mode TEXT,holder_id TEXT,lease_expires_at INTEGER); CREATE TABLE control_contract_authority(contract_attempt_id TEXT PRIMARY KEY,instance_id TEXT,intent_fence INTEGER,epoch INTEGER,executor_id TEXT,sequence INTEGER,claimed_at INTEGER,updated_at INTEGER)',
    );
    control
      .prepare("INSERT INTO control_authority VALUES(?,?,?,'contract','active','executor-a',?)")
      .run(upgrades.instanceId, epoch, id, now + 30000);
    control
      .prepare('INSERT INTO control_contract_authority VALUES(?,?,?,?,?,1,?,?)')
      .run(id, upgrades.instanceId, record.fence, epoch, 'executor-a', now, now);
    const reader = new Database(join(root, 'independent-control.db'), { readonly: true });
    const restoreWriter = useEnv({
      COORDINATOR_GENERATION: undefined,
      COORDINATOR_WRITER_FENCE_VALID: undefined,
    });
    const fenced = fenceCoordinatorConnection(connection.sqlite, upgrades.instanceId, clock, ids),
      participant = new UpgradeStore(fenced, clock, ids, {
        instanceId: upgrades.instanceId,
        readonly: true,
        ledgerSqlite: reader,
      });
    const participantContracts = new UpgradeContractStore(participant, clock, ids),
      business = new UpgradeContractBusiness(
        participantContracts,
        new UpgradeOnlineMigration(participant, clock),
        undefined as never,
        clock,
      );
    const privateRequest = (value: number) => ({
      headers: { 'x-platform-contract-id': id, 'x-platform-control-epoch': String(value) },
    });
    const apply = {
      action: 'activate' as const,
      contractAttemptId: id,
      fence: record.fence,
      expectedSequence: record.attempt.sequence,
      commandId: id + ':activate',
    };
    try {
      expect(() => business.execute(apply)).toThrow('CONTRACT_CONTROL_AUTHORITY_REQUIRED');
      const receipt = withContractRequest(
        privateRequest(epoch),
        participantContracts,
        clock,
        id,
        () => business.execute(apply),
      );
      expect(receipt.fence).toBe(record.fence);
      expect(
        connection.sqlite
          .prepare(
            "SELECT fence,request_digest FROM platform_operations WHERE role='schema-contract-admission'",
          )
          .get(),
      ).toEqual({ fence: epoch, request_digest: String(record.fence) });
      control.prepare("UPDATE control_authority SET epoch=epoch+1,holder_id='executor-b'").run();
      control
        .prepare(
          "UPDATE control_contract_authority SET epoch=epoch+1,executor_id='executor-b',sequence=sequence+1",
        )
        .run();
      expect(
        withContractRequest(privateRequest(epoch + 1), participantContracts, clock, id, () =>
          business.execute(apply),
        ),
      ).toEqual(receipt);
      expect(() =>
        withContractRequest(privateRequest(epoch), participantContracts, clock, id, () =>
          business.execute(apply),
        ),
      ).toThrow('CONTRACT_CONTROL_AUTHORITY_EXPIRED_OR_SUPERSEDED');
      expect(() =>
        withContractRequest(privateRequest(epoch + 1), participantContracts, clock, id, () =>
          business.execute({ ...apply, expectedSequence: apply.expectedSequence + 1 }),
        ),
      ).toThrow('CONTRACT_BUSINESS_COMMAND_CONFLICT');
      control.prepare("UPDATE control_authority SET kind='recovery'").run();
      expect(() =>
        withContractRequest(privateRequest(epoch + 1), participantContracts, clock, id, () =>
          business.execute(apply),
        ),
      ).toThrow('CONTRACT_CONTROL_AUTHORITY_EXPIRED_OR_SUPERSEDED');
      expect(
        control.prepare("SELECT name FROM sqlite_master WHERE name='projects'").get(),
      ).toBeUndefined();
    } finally {
      coordinatorWriterControl(fenced).release();
      restoreWriter();
      reader.close();
      control.close();
    }
  });
  it('same actor/request/payload is one intent, actor lookups are isolated and changed payload is rejected', () => {
    const input = command(),
      first = accept('actor-a', input);
    expect(accept('actor-a', input).attempt.contractAttemptId).toBe(
      first.attempt.contractAttemptId,
    );
    expect(contracts.lookup('actor-a', input.requestId)).toEqual(first.attempt);
    expect(() => contracts.lookup('actor-b', input.requestId)).toThrow(
      'CONTRACT_REQUEST_NOT_FOUND',
    );
    expect(() =>
      accept('actor-a', { ...input, targetPlanDigest: upgradeDigest({ changed: true }) }),
    ).toThrow('CONTRACT_REQUEST_PAYLOAD_CONFLICT');
    expect(() => accept('actor-b', input)).toThrow('INSTANCE_OPERATION_ACTIVE');
    expect(count()).toBe(1);
  });
  it('activation CAS and actual active upgrade reject before reserving another operation', () => {
    expect(() => accept('actor-a', { ...command(), expectedActivationGeneration: 0 })).toThrow(
      'CONTRACT_ACTIVATION_CONFLICT',
    );
    const id = upgrade();
    expect(() => accept()).toThrow('INSTANCE_OPERATION_ACTIVE');
    expect(count()).toBe(0);
    expect(upgrades.attempt(id).state).toBe('accepted');
  });
  it('an active contract blocks an ordinary upgrade rather than running contraction inside installation', () => {
    const accepted = accept();
    expect(() => upgrade()).toThrow('INSTANCE_CONTRACT_ACTIVE');
    expect(upgrades.latest()).toBeNull();
    expect(contracts.latest()?.attempt.contractAttemptId).toBe(accepted.attempt.contractAttemptId);
  });
  it('a higher contract fence revokes the old successful upgrade controller without changing historical success', () => {
    const id = upgrade();
    activate(id);
    const previous = upgrades.snapshot(id),
      history = connection.sqlite
        .prepare('SELECT * FROM upgrade_events WHERE attempt_id=? ORDER BY sequence')
        .all(id);
    const accepted = accept('contract-user', command(), previous.fence + 4);
    expect(accepted.fence).toBeGreaterThan(previous.fence);
    expect(() => upgrades.claim(id, 'late-old-controller', 30000)).toThrow(
      'UPGRADE_AUTHORITY_SUPERSEDED',
    );
    expect(() => upgrades.renew(id, previous.fence, 'state-controller')).toThrow();
    expect(upgrades.attempt(id)).toMatchObject({ state: 'activation-confirmed', percent: 100 });
    expect(
      connection.sqlite
        .prepare('SELECT * FROM upgrade_events WHERE attempt_id=? ORDER BY sequence')
        .all(id),
    ).toEqual(history);
    expect(
      contracts.assertFence(accepted.attempt.contractAttemptId, accepted.fence).attempt,
    ).toEqual(accepted.attempt);
  });
  it('checkpoint and sequence survive a real database reopen; a stale executor cannot overwrite newer progress', () => {
    const first = accept();
    const saved = contracts.save(
      first,
      { state: 'clearing', stage: 'real persisted batch', completedRows: 2, totalRows: 4 },
      {
        checkpoint: 'row-key-2',
        retirementReceipts: { readerA: { observedStopped: true, scope: 'state-only' } },
      },
    );
    expect(() => contracts.save(first, { completedRows: 1 })).toThrow('CONTRACT_SEQUENCE_CONFLICT');
    connection.sqlite.close();
    connection = createConnection(join(root, 'platform.sqlite'));
    upgrades = new UpgradeStore(connection.sqlite, clock, ids);
    contracts = new UpgradeContractStore(upgrades, clock, ids);
    expect(contracts.snapshot(first.attempt.contractAttemptId)).toEqual(saved);
    expect(contracts.lookup(first.actorId, first.command.requestId)).toEqual(saved.attempt);
    expect(count()).toBe(1);
  });
  it.each(['completed', 'deferred', 'failed', 'unknown'] as const)(
    'terminal %s does not execute again or reserve a new intent by query',
    (state) => {
      const first = accept(),
        terminal = contracts.save(first, { state, stage: 'terminal state-layer result' });
      expect(contracts.active()).toEqual([]);
      expect(() => contracts.save(terminal, { state: 'clearing' })).toThrow(
        'CONTRACT_TERMINAL_INTENT',
      );
      expect(contracts.lookup(first.actorId, first.command.requestId).state).toBe(state);
      expect(accept(first.actorId, first.command).attempt.contractAttemptId).toBe(
        first.attempt.contractAttemptId,
      );
      expect(count()).toBe(1);
    },
  );
  it('clock rollback orders independent explicit intents by durable fence, fencing the earlier completed attempt', () => {
    const first = accept();
    contracts.save(first, { state: 'completed', stage: 'complete state-layer result' });
    now -= 86400000;
    const second = accept('explicit-second-user', command(), first.fence);
    expect(second.fence).toBeGreaterThan(first.fence);
    expect(Date.parse(second.attempt.acceptedAt)).toBeLessThan(
      Date.parse(first.attempt.acceptedAt),
    );
    expect(contracts.latest()?.attempt.contractAttemptId).toBe(second.attempt.contractAttemptId);
    expect(() => contracts.assertFence(first.attempt.contractAttemptId, first.fence)).toThrow(
      'CONTRACT_FENCE_SUPERSEDED',
    );
    expect(count()).toBe(2);
  });
  it('immutable signed fixed plan corruption is detected instead of silently resuming an altered checkpoint', () => {
    const first = accept();
    const changed = structuredClone(first);
    changed.plan.maxBatchRows = 3;
    connection.sqlite
      .prepare('UPDATE platform_operations SET result=? WHERE operation_id=?')
      .run(canonicalUpgrade(changed), first.attempt.contractAttemptId);
    expect(() => contracts.snapshot(first.attempt.contractAttemptId)).toThrow(
      'CONTRACT_INTENT_CORRUPT',
    );
  });
});
