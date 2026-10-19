import 'reflect-metadata';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { fromEpochMs } from '@platform/shared-kernel';
import { createUpgradeControlStores } from '../../../apps/api/src/platform/upgrade/control-store-factory';
import { UpgradeStore } from '../../../apps/api/src/platform/upgrade/upgrade-store';
import {
  freezeUpgradePlan,
  canonicalUpgrade,
  upgradeDigest,
} from '../../../apps/api/src/platform/upgrade/upgrade-trust';
import {
  coordinatorWriterControl,
  fenceCoordinatorConnection,
} from '../../../apps/api/src/platform/persistence/coordinator-lease';
import { rejectRecoveryHeaders } from '../../../apps/api/src/platform/upgrade/upgrade-recovery-authority';
import { planFixtureEnvelope, planFixtureSource } from '../../support/upgrade-plan-fixture';
import { deferred, useEnv, stub, unused } from '../../support/strict-ports';
import { CoordinatorRecovery } from '../../../apps/api/src/platform/upgrade/coordinator-recovery';
import { ControlApplicationRegistry } from '../../../apps/api/src/platform/control-rpc/control-rpc.module';
import { readUpgradeCommandStatus } from '../../../apps/api/src/platform/upgrade/upgrade-command-status';

let directory: string,
  ledger: Database.Database,
  reader: Database.Database,
  business: Database.Database,
  participant: UpgradeStore,
  writer: UpgradeStore,
  restoreEnv: () => void;
let attemptId: string, recoveryId: string, now: number, plan: Record<string, unknown>;
const epoch = 7,
  instanceId = 'independent-recovery-fixture';
const clock = { now: () => fromEpochMs(now) },
  ids = { next: randomUUID };
type PrivateRequest = Parameters<UpgradeStore['recoveryRequest']>[0];
function request(value = epoch): PrivateRequest {
  return {
    headers: { 'x-platform-recovery-id': recoveryId, 'x-platform-recovery-epoch': String(value) },
  };
}
function phase(value: string, fixed = true) {
  ledger
    .prepare('UPDATE control_recovery_intents SET phase=?,plan=?,plan_digest=? WHERE recovery_id=?')
    .run(value, fixed ? canonicalUpgrade(plan) : null, fixed ? plan.planDigest : null, recoveryId);
}
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'independent-recovery-'));
  now = Date.parse('2026-10-20T00:00:00Z');
  restoreEnv = useEnv({
    COORDINATOR_GENERATION: undefined,
    COORDINATOR_WRITER_FENCE_VALID: undefined,
  });
  ledger = new Database(join(directory, 'control.db'));
  ledger.pragma('journal_mode=WAL');
  const stores = createUpgradeControlStores({
    sqlite: ledger,
    instanceId,
    clock,
    ids,
    claimGuard: () => null,
    dataFormatGuard: () => {},
  });
  writer = stores.store;
  const source = planFixtureSource(),
    envelope = planFixtureEnvelope(source, '0.2.1');
  writer.bootstrap(source);
  const attempt = writer.accept(
    'fixture-admin',
    {
      requestId: randomUUID(),
      targetReleaseId: envelope.manifest.releaseId,
      targetDigest: envelope.manifestDigest,
      expectedActivationGeneration: 1,
    },
    envelope,
    freezeUpgradePlan(envelope, source),
  );
  attemptId = attempt.attemptId;
  writer.claim(attemptId, 'original-controller', 30000);
  const original = writer.snapshot(attemptId);
  writer.commit(attemptId, {
    fence: original.fence,
    generation: original.attempt.generation,
    expectedSequence: original.attempt.sequence,
    eventId: randomUUID(),
    kind: 'failed',
    payload: { reason: 'FIXTURE_ORIGINAL_FAILURE' },
  });
  // Exact deployed control-table shape, independent from the legacy attempt journal.
  ledger.exec(`CREATE TABLE control_authority(instance_id TEXT PRIMARY KEY,epoch INTEGER NOT NULL,operation_id TEXT,kind TEXT,holder_id TEXT,lease_expires_at INTEGER NOT NULL,mode TEXT NOT NULL,revision INTEGER NOT NULL,source_binding_digest TEXT,updated_at INTEGER NOT NULL);
    CREATE TABLE control_recovery_intents(recovery_id TEXT PRIMARY KEY,instance_id TEXT NOT NULL,triggering_attempt_id TEXT NOT NULL,triggering_operation_id TEXT,authorization_plan TEXT NOT NULL,authorization_digest TEXT NOT NULL,plan TEXT,plan_digest TEXT,phase TEXT NOT NULL,epoch INTEGER NOT NULL,sequence INTEGER NOT NULL,reason TEXT NOT NULL,deadline INTEGER NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,confirmed_at INTEGER,diagnostic_id TEXT);`);
  recoveryId = randomUUID();
  const authorization = { triggeringAttemptId: attemptId, scope: ['api'] },
    spec = {
      triggeringAttemptId: attemptId,
      componentScope: ['api'],
      api: null,
      web: null,
      coordinator: null,
      owner: null,
    };
  plan = { ...spec, planDigest: upgradeDigest(spec) };
  ledger
    .prepare(
      "INSERT INTO control_authority VALUES(?,?,?,'recovery','stable-agent',?,'active',1,NULL,?)",
    )
    .run(instanceId, epoch, recoveryId, now + 30000, now);
  ledger
    .prepare(
      "INSERT INTO control_recovery_intents VALUES(?,?,?,?,?,?,NULL,NULL,'reconciling',?,1,'FIXTURE_RECOVERY',?,?,?,NULL,NULL)",
    )
    .run(
      recoveryId,
      instanceId,
      attemptId,
      null,
      canonicalUpgrade(authorization),
      upgradeDigest(authorization),
      epoch,
      now + 60000,
      now,
      now,
    );
  business = new Database(join(directory, 'business.db'));
  business.exec(`CREATE TABLE platform_operations(operation_id TEXT PRIMARY KEY,instance_id TEXT NOT NULL,actor_id TEXT NOT NULL,role TEXT NOT NULL,fence INTEGER NOT NULL,request_digest TEXT NOT NULL,state TEXT NOT NULL,result TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
    CREATE TABLE coordinator_recoveries(recovery_attempt_id TEXT PRIMARY KEY,plan_digest TEXT,stage TEXT,evidence TEXT);
    CREATE TABLE app_effects(value TEXT);`);
  const fenced = fenceCoordinatorConnection(business, instanceId, clock, ids);
  reader = new Database(join(directory, 'control.db'), { readonly: true });
  participant = new UpgradeStore(fenced, clock, ids, {
    instanceId,
    readonly: true,
    ledgerSqlite: reader,
  });
});
afterEach(() => {
  coordinatorWriterControl(participant.sqlite).release();
  reader.close();
  business.close();
  ledger.close();
  restoreEnv();
  rmSync(directory, { recursive: true, force: true });
});

describe('independent recovery authority and business participant barriers', () => {
  it('stabilizes only the same real SQLite writer after quiesce, with a bounded fixed inventory witness and a durable original command result', async () => {
    // This fixture proves the semantic/DB/file boundary. It does not claim a real
    // container inventory or Guest continuity qualification.
    type Dependencies = ConstructorParameters<typeof CoordinatorRecovery>;
    type AppDependencies = ConstructorParameters<typeof ControlApplicationRegistry>;
    let resumed = 0;
    const events = stub<Dependencies[8]>({
      activeTransportConnections: 0,
      resumeAfterHandoff: () => {
        resumed++;
      },
    });
    const tasks = stub<Dependencies[9]>({
      activeTransportConnections: 0,
      resumeAfterHandoff: () => {
        resumed++;
      },
    });
    const terminals = stub<Dependencies[10]>({ activeTransportConnections: 0 });
    const applications = new ControlApplicationRegistry(
      unused<AppDependencies[0]>('discovery'),
      participant.sqlite,
      clock,
      unused<AppDependencies[3]>('auth'),
      events,
      tasks,
      terminals,
    );
    await applications.quiesce(1000);
    const coordinator = new CoordinatorRecovery(
      participant,
      unused<Dependencies[1]>('inspector'),
      unused<Dependencies[2]>('migration'),
      applications,
      stub<Dependencies[4]>({
        resumeOwnership: () => {
          resumed++;
        },
      }),
      stub<Dependencies[5]>({
        resumeOwnership: () => {
          resumed++;
        },
      }),
      stub<Dependencies[6]>({
        resumeOwnership: () => {
          resumed++;
        },
      }),
      stub<Dependencies[7]>({
        resumeOwnership: () => {
          resumed++;
        },
      }),
      events,
      tasks,
      terminals,
      unused<Dependencies[11]>('Owners must stay untouched'),
      clock,
      undefined,
      stub<NonNullable<Dependencies[14]>>({
        resumeOwnership: () => {
          resumed++;
        },
      }),
    );
    const lease = business
      .prepare<unknown[], { holder_id: string; generation: number; fence: number }>(
        "SELECT holder_id,generation,fence FROM platform_role_leases WHERE role='state-coordinator'",
      )
      .get();
    if (!lease) throw new Error('fixture writer lease missing');
    const writerIdentity = {
      artifactDigest: 'sha256:' + 'a'.repeat(64),
      startIdentity: 'fixed-fixture-writer-birth',
      generation: lease.generation,
      fence: lease.fence,
      holderId: lease.holder_id,
    };
    const snapshot = writer.snapshot(attemptId),
      inventoryDigest = upgradeDigest({ immutableInventory: ['source', 'prepared'] });
    const authorization = {
      triggeringAttemptId: attemptId,
      targetDigest: snapshot.attempt.targetDigest,
      acceptedPlanDigest: snapshot.plan.planDigest,
      stabilizeCurrentWriter: true,
      stabilization: { writer: writerIdentity, inventoryDigest },
    };
    ledger
      .prepare('UPDATE control_recovery_intents SET authorization_plan=?,authorization_digest=?')
      .run(canonicalUpgrade(authorization), upgradeDigest(authorization));
    const proof = {
      instanceId,
      writer: writerIdentity,
      coordinators: [
        {
          containerId: 'source-container',
          startIdentity: writerIdentity.startIdentity,
          artifactDigest: writerIdentity.artifactDigest,
          generation: lease.generation,
          writerFenceValid: true,
          observedAt: clock.now().toISOString(),
        },
        {
          containerId: 'prepared-container',
          startIdentity: 'fixed-prepared-birth',
          artifactDigest: 'sha256:' + 'b'.repeat(64),
          generation: 0,
          writerFenceValid: false,
          observedAt: clock.now().toISOString(),
        },
      ],
      observedAt: clock.now().toISOString(),
    };
    ledger.exec(
      'CREATE TABLE control_stabilization_witnesses(recovery_id TEXT PRIMARY KEY,instance_id TEXT,writer_digest TEXT,inventory_digest TEXT,proof TEXT,proof_digest TEXT,observed_at INTEGER)',
    );
    ledger
      .prepare('INSERT INTO control_stabilization_witnesses VALUES(?,?,?,?,?,?,?)')
      .run(
        recoveryId,
        instanceId,
        upgradeDigest(writerIdentity),
        inventoryDigest,
        canonicalUpgrade(proof),
        upgradeDigest(proof),
        now,
      );
    business.exec(
      'CREATE TABLE coordinator_handoffs(attempt_id TEXT PRIMARY KEY,stage TEXT,source_generation INTEGER)',
    );
    business
      .prepare("INSERT INTO coordinator_handoffs VALUES(?,'quiesced',?)")
      .run(attemptId, lease.generation);
    const path = join(directory, 'coordinator-binding.json');
    writeFileSync(
      path,
      canonicalUpgrade({
        instanceId,
        state: 'quiescing',
        origin: 'http://127.0.0.1:43123',
        generation: lease.generation,
        artifactDigest: writerIdentity.artifactDigest,
      }),
      { mode: 0o600 },
    );
    const restore = useEnv({
      PLATFORM_COORDINATOR_BINDING_PATH: path,
      PLATFORM_ARTIFACT_DIGEST: writerIdentity.artifactDigest,
      PLATFORM_PROCESS_START_IDENTITY: writerIdentity.startIdentity,
    });
    try {
      participant.recoveryRequest(request(), attemptId, 'admit', () =>
        participant.admitRecovery(attemptId, epoch),
      );
      const input = { fence: epoch, operationId: recoveryId + ':stabilize-current-writer' };
      const run = () =>
        participant.recoveryRequest(request(), attemptId, 'stabilize', () =>
          participant.recoveryAction(attemptId, 'stabilize-current-writer', input, () =>
            coordinator.stabilize(attemptId, input),
          ),
        );
      const result = await run();
      expect(result).toMatchObject({
        commitKnown: true,
        writerUnchanged: true,
        requiresFreshQualification: true,
      });
      expect(resumed).toBe(7);
      expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({
        state: 'ready',
        generation: lease.generation,
      });
      expect(
        business.prepare('SELECT holder_id,generation,fence FROM platform_role_leases').get(),
      ).toEqual(lease);
      expect(await run()).toEqual(result);
      expect(resumed).toBe(7);
      expect(
        participant.recoveryRequest(request(), attemptId, 'read', () =>
          participant.recoveryActions(attemptId),
        )[0].state,
      ).toBe('completed');
      business.prepare("UPDATE coordinator_handoffs SET stage='releasing'").run();
      await expect(
        participant.recoveryRequest(request(), attemptId, 'stabilize', () =>
          coordinator.stabilize(attemptId, input),
        ),
      ).rejects.toThrow('CONTROL_STABILIZATION_HANDOFF_UNKNOWN');
      business.prepare("UPDATE coordinator_handoffs SET stage='quiesced'").run();
      now += 5001;
      await expect(
        participant.recoveryRequest(request(), attemptId, 'stabilize', () =>
          coordinator.stabilize(attemptId, input),
        ),
      ).rejects.toThrow('CONTROL_STABILIZATION_WITNESS_STALE');
      expect(resumed).toBe(7);
    } finally {
      restore();
    }
  });
  it('reads original command journals without granting the expired controller or mistaking quiesce markers for completion', () => {
    business.exec(
      'CREATE TABLE coordinator_handoffs(attempt_id TEXT PRIMARY KEY,operation_id TEXT,plan_digest TEXT,stage TEXT,candidate TEXT,evidence TEXT); CREATE TABLE upgrade_migration_operations(operation_id TEXT PRIMARY KEY,request_digest TEXT,result TEXT)',
    );
    const operationId = randomUUID(),
      currentPlan = writer.plan(attemptId),
      candidate = { artifactDigest: 'sha256:' + 'c'.repeat(64), startIdentity: 'candidate-birth' };
    business
      .prepare('INSERT INTO coordinator_handoffs VALUES(?,?,?,?,?,?)')
      .run(
        attemptId,
        operationId,
        currentPlan.planDigest,
        'quiesced',
        canonicalUpgrade(candidate),
        canonicalUpgrade({ prepared: true }),
      );
    const query = { attemptId, commandKind: 'coordinator-handoff' as const, operationId };
    const status = participant.recoveryRequest(request(), attemptId, 'read', () =>
      readUpgradeCommandStatus(participant, query),
    );
    expect(status).toMatchObject({
      stage: 'quiesced',
      state: 'unknown',
      actionsCompleted: ['prepare'],
    });
    expect(() =>
      participant.recoveryRequest(request(), attemptId, 'read', () =>
        readUpgradeCommandStatus(participant, { ...query, operationId: randomUUID() }),
      ),
    ).toThrow('RECOVERY_ORIGINAL_COMMAND_BINDING_MISMATCH');
    const migrationId = randomUUID(),
      requestDigest = upgradeDigest({
        attemptId,
        action: 'batch',
        planDigest: currentPlan.migrationPath.migrationPlanDigest,
        checkpoint: null,
      });
    business
      .prepare('INSERT INTO upgrade_migration_operations VALUES(?,?,?)')
      .run(migrationId, requestDigest, canonicalUpgrade({ commitKnown: true, completedWork: 1 }));
    participant.recoveryRequest(request(), attemptId, 'read', () => {
      expect(
        readUpgradeCommandStatus(participant, {
          attemptId,
          commandKind: 'migration',
          operationId: migrationId,
        }),
      ).toMatchObject({ state: 'unknown', requestDigest });
      expect(
        readUpgradeCommandStatus(participant, {
          attemptId,
          commandKind: 'migration',
          operationId: migrationId,
          expectedRequestDigest: requestDigest,
        }),
      ).toMatchObject({ state: 'applied', result: { commitKnown: true, completedWork: 1 } });
    });
  });
  it('projects the independent intent without rewriting failed history and limits qualification to reads', () => {
    const history = ledger
      .prepare('SELECT * FROM upgrade_attempts WHERE attempt_id=?')
      .get(attemptId);
    participant.recoveryRequest(request(), attemptId, 'read', () => {
      expect(participant.assertFence(attemptId, epoch).generation).toBe(epoch);
      const snapshot = participant.snapshot(attemptId);
      expect(snapshot.recovery?.phase).toBe('reconciling');
      expect(snapshot.recoveryPlan).toBeNull();
      expect(snapshot.fence).toBe(epoch);
      expect(() =>
        participant.sqlite.prepare("INSERT INTO app_effects VALUES('forbidden')").run(),
      ).toThrow('RECOVERY_READ_CONTEXT_CANNOT_MUTATE');
    });
    expect(() =>
      participant.assertFence(
        attemptId,
        history && typeof history === 'object' ? Number(Reflect.get(history, 'fence')) : 1,
      ),
    ).toThrow('CONTROL_AUTHORITY_EXPIRED_OR_SUPERSEDED');
    expect(() => participant.recoveryRequest(request(), attemptId, 'restore', () => true)).toThrow(
      'CONTROL_RECOVERY_FIXED_PLAN_REQUIRED',
    );
    expect(() =>
      participant.recoveryRequest(request(epoch + 1), attemptId, 'read', () => true),
    ).toThrow('RECOVERY_AUTHORITY_EXPIRED_OR_SUPERSEDED');
    expect(() => participant.recoveryRequest(request(), randomUUID(), 'read', () => true)).toThrow(
      'RECOVERY_AUTHORITY_EXPIRED_OR_SUPERSEDED',
    );
    expect(() => rejectRecoveryHeaders(request())).toThrow('RECOVERY_RPC_NOT_ALLOWED');
    expect(
      ledger.prepare('SELECT * FROM upgrade_attempts WHERE attempt_id=?').get(attemptId),
    ).toEqual(history);
    expect(ledger.prepare('SELECT count(*) n FROM upgrade_recoveries').get()).toEqual({ n: 0 });
  });

  it('requires local admission and preserves immutable command results across a new epoch', async () => {
    phase('restoring');
    await expect(
      participant.recoveryRequest(request(), attemptId, 'restore', () =>
        participant.recoveryAction(
          attemptId,
          'coordinator-recovery',
          { fence: epoch, recoveryPlanDigest: plan.planDigest },
          async () => ({ commitKnown: true }),
        ),
      ),
    ).rejects.toThrow('RECOVERY_PARTICIPANT_NOT_ADMITTED');
    const admission = participant.recoveryRequest(request(), attemptId, 'admit', () =>
      participant.admitRecovery(attemptId, epoch),
    );
    expect(admission).toMatchObject({ recoveryId, epoch, admitted: true });
    let calls = 0;
    const result = await participant.recoveryRequest(request(), attemptId, 'restore', () =>
      participant.recoveryAction(
        attemptId,
        'coordinator-recovery',
        { fence: epoch, recoveryPlanDigest: plan.planDigest },
        async () => {
          calls++;
          participant.sqlite.prepare("INSERT INTO app_effects VALUES('once')").run();
          return { commitKnown: true, qualified: true };
        },
      ),
    );
    ledger.prepare('UPDATE control_authority SET epoch=epoch+1').run();
    ledger.prepare('UPDATE control_recovery_intents SET epoch=epoch+1').run();
    participant.recoveryRequest(request(epoch + 1), attemptId, 'admit', () =>
      participant.admitRecovery(attemptId, epoch + 1),
    );
    expect(
      await participant.recoveryRequest(request(epoch + 1), attemptId, 'restore', () =>
        participant.recoveryAction(
          attemptId,
          'coordinator-recovery',
          { fence: epoch + 1, recoveryPlanDigest: plan.planDigest },
          async () => {
            calls++;
            return {};
          },
        ),
      ),
    ).toEqual(result);
    expect(calls).toBe(1);
    await expect(
      participant.recoveryRequest(request(epoch + 1), attemptId, 'restore', () =>
        participant.recoveryAction(
          attemptId,
          'coordinator-recovery',
          { fence: epoch + 1, recoveryPlanDigest: 'sha256:' + 'f'.repeat(64) },
          async () => ({}),
        ),
      ),
    ).rejects.toThrow('RECOVERY_COMMAND_SPEC_CONFLICT');
    expect(business.prepare('SELECT * FROM app_effects').all()).toEqual([{ value: 'once' }]);
  });

  it('does not copy an unknown old action or allow its late mutation after takeover', async () => {
    phase('restoring');
    participant.recoveryRequest(request(), attemptId, 'admit', () =>
      participant.admitRecovery(attemptId, epoch),
    );
    const gate = deferred<void>();
    const old = participant.recoveryRequest(request(), attemptId, 'restore', () =>
      participant.recoveryAction(
        attemptId,
        'coordinator-recovery',
        { fence: epoch, recoveryPlanDigest: plan.planDigest },
        async () => {
          await gate.promise;
          participant.sqlite.prepare("INSERT INTO app_effects VALUES('late')").run();
          return {};
        },
      ),
    );
    ledger.prepare('UPDATE control_authority SET epoch=epoch+1').run();
    ledger.prepare('UPDATE control_recovery_intents SET epoch=epoch+1').run();
    expect(() =>
      participant.recoveryRequest(request(epoch + 1), attemptId, 'admit', () =>
        participant.admitRecovery(attemptId, epoch + 1),
      ),
    ).toThrow('RECOVERY_PREVIOUS_ACTION_UNKNOWN');
    const failure = expect(old).rejects.toThrow('RECOVERY_AUTHORITY_EXPIRED_OR_SUPERSEDED');
    gate.resolve();
    await failure;
    const actions = participant.recoveryRequest(request(epoch + 1), attemptId, 'read', () =>
      participant.recoveryActions(attemptId),
    );
    expect(actions).toHaveLength(1);
    expect(actions[0].state).toBe('running');
    expect(actions[0].result).toBeNull();
    expect(business.prepare('SELECT count(*) n FROM app_effects').get()).toEqual({ n: 0 });
  });

  it('atomically confirms a real receipt with instance readiness, preserving failed history and partial tuple', () => {
    phase('verifying');
    const before = ledger
        .prepare('SELECT * FROM upgrade_attempts WHERE attempt_id=?')
        .get(attemptId),
      oldConfirmed = writer.confirmed();
    const proof = {
      qualified: true as const,
      recoveryId,
      epoch,
      planDigest: String(plan.planDigest),
      observedAt: clock.now().toISOString(),
      physical: { actualBindingDigest: 'sha256:' + 'a'.repeat(64) },
    };
    const input = {
      recoveryId,
      epoch,
      expectedRecoverySequence: 1,
      restoredPartial: true,
      confirmation: { ...proof, receiptDigest: upgradeDigest(proof) },
    };
    ledger.exec(
      "CREATE TRIGGER fixture_confirmation_failure BEFORE UPDATE OF phase ON control_recovery_intents WHEN NEW.phase='recovered' BEGIN SELECT raise(ABORT,'fixture atomic failure'); END",
    );
    expect(() => writer.confirmIndependentRecovery(input)).toThrow('fixture atomic failure');
    expect(writer.instance().ready).toBe(0);
    expect(
      ledger
        .prepare("SELECT name FROM sqlite_master WHERE name='control_recovery_confirmations'")
        .get(),
    ).toBeUndefined();
    ledger.exec('DROP TRIGGER fixture_confirmation_failure');
    expect(() =>
      writer.confirmIndependentRecovery({
        ...input,
        confirmation: { ...input.confirmation, planDigest: 'sha256:' + 'b'.repeat(64) },
      }),
    ).toThrow('CONTROL_RECOVERY_CONFIRMATION_REQUIRED');
    const ticking = vi.spyOn(clock, 'now').mockImplementation(() => fromEpochMs(now++));
    try {
      const confirmed = writer.confirmIndependentRecovery(input);
      expect(confirmed).toMatchObject({ phase: 'recovered', sequence: 2 });
      const durable = ledger
        .prepare('SELECT confirmed_at FROM control_recovery_confirmations WHERE recovery_id=?')
        .get(recoveryId);
      expect(durable).toEqual({ confirmed_at: Date.parse(String(confirmed.confirmedAt)) });
      expect(
        ledger
          .prepare('SELECT confirmed_at FROM control_recovery_intents WHERE recovery_id=?')
          .get(recoveryId),
      ).toEqual(durable);
    } finally {
      ticking.mockRestore();
    }
    expect(writer.instance()).toMatchObject({ ready: 1, service_state: 'recovery-confirmed' });
    expect(writer.confirmed()).toEqual(oldConfirmed);
    expect(
      ledger
        .prepare('SELECT receipt FROM control_recovery_confirmations WHERE recovery_id=?')
        .get(recoveryId),
    ).toEqual({ receipt: canonicalUpgrade(input.confirmation) });
    expect(
      ledger.prepare('SELECT * FROM upgrade_attempts WHERE attempt_id=?').get(attemptId),
    ).toEqual(before);
  });
  it('revokes an active attempt using only the new authority and journals why, while an already failed history remains unchanged', () => {
    const failedHistory = ledger
      .prepare('SELECT * FROM upgrade_attempts WHERE attempt_id=?')
      .get(attemptId);
    const receipt = writer.freezeAttemptForRecovery({
      recoveryId,
      epoch,
      reason: 'FIXTURE_RECOVERY_REVOKE',
    });
    expect(receipt.revokedActiveAttempt).toBe(false);
    expect(
      writer.freezeAttemptForRecovery({ recoveryId, epoch, reason: 'FIXTURE_RECOVERY_REVOKE' }),
    ).toEqual(receipt);
    expect(
      ledger.prepare('SELECT * FROM upgrade_attempts WHERE attempt_id=?').get(attemptId),
    ).toEqual(failedHistory);
    const source = planFixtureSource(),
      envelope = planFixtureEnvelope(source, '0.2.2');
    expect(() =>
      writer.accept(
        'blocked-new-intent',
        {
          requestId: randomUUID(),
          targetReleaseId: envelope.manifest.releaseId,
          targetDigest: envelope.manifestDigest,
          expectedActivationGeneration: 1,
        },
        envelope,
        freezeUpgradePlan(envelope, source),
      ),
    ).toThrow('CONTROL_OPERATION_ALREADY_ACTIVE');
    ledger.prepare("UPDATE control_recovery_intents SET phase='blocked'").run();
    ledger.prepare('UPDATE control_authority SET holder_id=NULL,lease_expires_at=0').run();
    const next = writer.accept(
      'fixture-next-admin',
      {
        requestId: randomUUID(),
        targetReleaseId: envelope.manifest.releaseId,
        targetDigest: envelope.manifestDigest,
        expectedActivationGeneration: 1,
      },
      envelope,
      freezeUpgradePlan(envelope, source),
    );
    const old = writer.snapshot(next.attemptId);
    const nextRecoveryId = randomUUID();
    ledger
      .prepare(
        "INSERT INTO control_recovery_intents SELECT ?,instance_id,?,triggering_operation_id,authorization_plan,authorization_digest,NULL,NULL,'reconciling',epoch+1,1,reason,deadline,created_at,updated_at,NULL,NULL FROM control_recovery_intents WHERE recovery_id=?",
      )
      .run(nextRecoveryId, next.attemptId, recoveryId);
    ledger
      .prepare(
        "UPDATE control_authority SET operation_id=?,epoch=epoch+1,holder_id='new-recovery-controller',lease_expires_at=?",
      )
      .run(nextRecoveryId, now + 30000);
    const revoked = writer.freezeAttemptForRecovery({
      recoveryId: nextRecoveryId,
      epoch: epoch + 1,
      reason: 'NEW_RECOVERY_AUTHORITY',
    });
    expect(revoked.revokedActiveAttempt).toBe(true);
    expect(writer.attempt(next.attemptId)).toMatchObject({
      state: 'failed',
      sequence: old.attempt.sequence + 1,
      reason: 'NEW_RECOVERY_AUTHORITY',
    });
    expect(writer.snapshot(next.attemptId)).toMatchObject({
      controllerId: null,
      leaseExpiresAt: 0,
    });
    expect(
      ledger
        .prepare('SELECT count(*) n FROM upgrade_events WHERE attempt_id=?')
        .get(next.attemptId),
    ).toEqual({ n: 0 });
    expect(
      ledger
        .prepare('SELECT receipt FROM control_recovery_faults WHERE recovery_id=?')
        .get(nextRecoveryId),
    ).toEqual({ receipt: canonicalUpgrade(revoked) });
  });
});
