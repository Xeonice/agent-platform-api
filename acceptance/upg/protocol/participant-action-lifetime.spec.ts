import 'reflect-metadata';
import Database from 'better-sqlite3';
import { createServer } from 'node:http';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { fromEpochMs } from '@platform/shared-kernel';
import { createUpgradeControlStores } from '../../../apps/api/src/platform/upgrade/control-store-factory';
import { UpgradeStore } from '../../../apps/api/src/platform/upgrade/upgrade-store';
import {
  freezeUpgradePlan,
  canonicalUpgrade,
  upgradeDigest,
  UpgradeError,
} from '../../../apps/api/src/platform/upgrade/upgrade-trust';
import { assertCurrentBusinessAction } from '../../../apps/api/src/platform/upgrade/upgrade-business-action';
import {
  coordinatorWriterControl,
  fenceCoordinatorConnection,
} from '../../../apps/api/src/platform/persistence/coordinator-lease';
import { upgradeRecord } from '../../../apps/api/src/platform/upgrade/upgrade-values';
import { planFixtureEnvelope, planFixtureSource } from '../../support/upgrade-plan-fixture';
import { deferred, useEnv } from '../../support/strict-ports';

describe('actual HTTP abort, participant lifecycle facts and real SQLite recovery admission', () => {
  it('keeps a late prepared-adopt handler fenced until its work actually settles, then permits a separately authorized recovery', async () => {
    // Isolated protocol/transaction boundary, no model, SDK, Guest or production mounts.
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'participant-http-lifetime-'))),
      now = Date.parse('2026-10-20T00:00:00Z'),
      instanceId = 'participant-http-fixture';
    const clock = { now: () => fromEpochMs(now) },
      ids = { next: randomUUID };
    const restore = useEnv({
      PLATFORM_INSTANCE_ID: instanceId,
      PLATFORM_PROCESS_START_IDENTITY: 'prepared-fixture-birth',
      PLATFORM_ARTIFACT_DIGEST: 'sha256:' + 'a'.repeat(64),
      PLATFORM_COORDINATOR_BINDING_PATH: join(directory, 'coordinator.json'),
      COORDINATOR_GENERATION: undefined,
      COORDINATOR_WRITER_FENCE_VALID: undefined,
    });
    const control = new Database(join(directory, 'control.db')),
      business = new Database(join(directory, 'business.db'));
    const stores = createUpgradeControlStores({
      sqlite: control,
      instanceId,
      clock,
      ids,
      claimGuard: () => null,
      dataFormatGuard: () => {
        /* No project-format migration in this isolated command fixture. */
      },
    });
    const source = planFixtureSource(),
      envelope = planFixtureEnvelope(source, '0.2.1'),
      plan = freezeUpgradePlan(envelope, source);
    stores.store.bootstrap(source);
    const attempt = stores.store.accept(
        'state-actor',
        {
          requestId: randomUUID(),
          targetReleaseId: envelope.manifest.releaseId,
          targetDigest: envelope.manifestDigest,
          expectedActivationGeneration: 1,
        },
        envelope,
        plan,
      ),
      claim = stores.store.claim(attempt.attemptId, 'stable-executor', 30000);
    control.exec(`CREATE TABLE control_authority(instance_id TEXT PRIMARY KEY,epoch INTEGER,operation_id TEXT,kind TEXT,holder_id TEXT,lease_expires_at INTEGER,mode TEXT);
      CREATE TABLE control_commands(instance_id TEXT,operation_id TEXT,command_id TEXT,spec TEXT,spec_digest TEXT,state TEXT,epoch INTEGER);
      CREATE TABLE control_recovery_intents(recovery_id TEXT PRIMARY KEY,instance_id TEXT,triggering_attempt_id TEXT,triggering_operation_id TEXT,authorization_plan TEXT,authorization_digest TEXT,plan TEXT,plan_digest TEXT,phase TEXT,epoch INTEGER,sequence INTEGER,reason TEXT,deadline INTEGER,created_at INTEGER,updated_at INTEGER,confirmed_at INTEGER,diagnostic_id TEXT);`);
    control
      .prepare("INSERT INTO control_authority VALUES(?,?,?,'upgrade','stable-executor',?,'active')")
      .run(instanceId, claim.fence, attempt.attemptId, now + 30000);
    const commandId = 'prepared-adopt:' + randomUUID(),
      operationId = randomUUID();
    const participantIdentity = {
      startIdentity: 'prepared-fixture-birth',
      artifactDigest: 'sha256:' + 'a'.repeat(64),
    };
    const spec = {
      schemaVersion: 1,
      method: 'coordinatorHandoff',
      path: '/internal/upgrades/' + attempt.attemptId + '/coordinator-handoff',
      attemptId: attempt.attemptId,
      participant: participantIdentity,
      body: {
        action: 'adopt',
        operationId,
        planDigest: plan.planDigest,
        candidate: { ...participantIdentity, managementOrigin: 'http://127.0.0.1:43123' },
      },
      originalFence: claim.fence,
      deadline: now + 10000,
    };
    control
      .prepare("INSERT INTO control_commands VALUES(?,?,?,?,?,'executing',?)")
      .run(
        instanceId,
        attempt.attemptId,
        commandId,
        canonicalUpgrade(spec),
        upgradeDigest(spec),
        claim.fence,
      );
    business.exec(
      `CREATE TABLE platform_operations(operation_id TEXT PRIMARY KEY,instance_id TEXT,actor_id TEXT,role TEXT,fence INTEGER,request_digest TEXT,state TEXT,result TEXT,created_at INTEGER,updated_at INTEGER); CREATE TABLE coordinator_recoveries(recovery_attempt_id TEXT PRIMARY KEY,plan_digest TEXT,stage TEXT,evidence TEXT); CREATE TABLE app_effects(value TEXT);`,
    );
    const fenced = fenceCoordinatorConnection(business, instanceId, clock, ids),
      reader = new Database(join(directory, 'control.db'), { readonly: true }),
      store = new UpgradeStore(fenced, clock, ids, {
        instanceId,
        readonly: true,
        ledgerSqlite: reader,
      });
    const entered = deferred<void>(),
      gate = deferred<void>(),
      finished = deferred<void>();
    const server = createServer((req, res) => {
      void (async () => {
        let text = '';
        for await (const chunk of req) text += String(chunk);
        const input = upgradeRecord(JSON.parse(text));
        if (req.url === '/status')
          return store.participantCommandStatus(String(input.attemptId), String(input.commandId));
        return store.businessAction(
          req.headers,
          String(input.attemptId),
          'coordinatorHandoff',
          input,
          async () => {
            entered.resolve();
            await gate.promise;
            assertCurrentBusinessAction();
            fenced.prepare("INSERT INTO app_effects VALUES('late-adopt-ready')").run();
            return { commitKnown: true, stage: 'adopted' };
          },
          true,
        );
      })()
        .then(
          (value) => {
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify(value));
          },
          (error) => {
            res.statusCode = 409;
            res.end(
              JSON.stringify({
                code: error instanceof UpgradeError ? error.code : 'FIXTURE_HTTP_FAILED',
              }),
            );
          },
        )
        .finally(() => {
          if (req.url !== '/status') finished.resolve();
        });
    });
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('fixture address missing');
    const origin = 'http://127.0.0.1:' + String(address.port),
      abort = new AbortController();
    const input = {
      instanceId,
      attemptId: attempt.attemptId,
      fence: claim.fence,
      operationId,
      planDigest: plan.planDigest,
      startIdentity: participantIdentity.startIdentity,
    };
    try {
      const pending = fetch(origin + '/adopt', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-platform-control-command-id': commandId,
          'x-platform-control-spec-digest': upgradeDigest(spec),
        },
        body: JSON.stringify(input),
        signal: abort.signal,
      });
      const aborted = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
      await entered.promise;
      abort.abort();
      await aborted;
      const recoveryId = randomUUID(),
        authorization = { triggeringAttemptId: attempt.attemptId };
      control
        .prepare(
          "UPDATE control_authority SET epoch=7,operation_id=?,kind='recovery',holder_id='recovery-executor'",
        )
        .run(recoveryId);
      control
        .prepare(
          "INSERT INTO control_recovery_intents VALUES(?,?,?,NULL,?,?,NULL,NULL,'reconciling',7,1,'fixture',?,?,?,NULL,NULL)",
        )
        .run(
          recoveryId,
          instanceId,
          attempt.attemptId,
          canonicalUpgrade(authorization),
          upgradeDigest(authorization),
          now + 60000,
          now,
          now,
        );
      const recoveryRequest = {
        headers: { 'x-platform-recovery-id': recoveryId, 'x-platform-recovery-epoch': '7' },
      };
      const observe = async () =>
        upgradeRecord(
          await (
            await fetch(origin + '/status', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ attemptId: attempt.attemptId, commandId }),
            })
          ).json(),
        );
      expect(await observe()).toMatchObject({
        state: 'running',
        actualRunning: true,
        admissionClosed: true,
      });
      expect(() =>
        store.recoveryRequest(recoveryRequest, attempt.attemptId, 'admit', () =>
          store.admitRecovery(attempt.attemptId, 7),
        ),
      ).toThrow('CONTROL_PREVIOUS_BUSINESS_ACTION_PENDING');
      gate.resolve();
      await finished.promise;
      const settled = await observe();
      expect(settled).toMatchObject({
        state: 'settled',
        actualRunning: false,
        admissionClosed: true,
        receipt: { outcome: 'rejected' },
      });
      expect(business.prepare('SELECT count(*) n FROM app_effects').get()).toEqual({ n: 0 });
      expect(
        store.recoveryRequest(recoveryRequest, attempt.attemptId, 'admit', () =>
          store.admitRecovery(attempt.attemptId, 7),
        ),
      ).toMatchObject({ admitted: true, epoch: 7 });
      const late = await fetch(origin + '/adopt', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-platform-control-command-id': commandId,
          'x-platform-control-spec-digest': upgradeDigest(spec),
        },
        body: JSON.stringify(input),
      });
      expect(late.status).toBe(409);
      expect(business.prepare('SELECT count(*) n FROM app_effects').get()).toEqual({ n: 0 });
    } finally {
      gate.resolve();
      server.closeAllConnections();
      await new Promise<void>((ok) => server.close(() => ok()));
      coordinatorWriterControl(fenced).release();
      reader.close();
      business.close();
      control.close();
      restore();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
