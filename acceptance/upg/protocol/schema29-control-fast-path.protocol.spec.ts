import 'reflect-metadata';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { createRequire } from 'node:module';
import { Test } from '@nestjs/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CLOCK, fromEpochMs } from '@platform/shared-kernel';
import { TasksGateway } from '@platform/sandbox';
import { TerminalGateway } from '@platform/terminal';
import {
  UpgradeStore,
  type UpgradeCommit,
} from '../../../apps/api/src/platform/upgrade/upgrade-store';
import { UpgradeService } from '../../../apps/api/src/platform/upgrade/upgrade-service';
import { UpgradeCatalog } from '../../../apps/api/src/platform/upgrade/upgrade-catalog';
import type { UpgradeInspectionPort } from '../../../apps/api/src/platform/upgrade/upgrade-inspection.port';
import {
  UpgradeInternalController,
  UpgradeController,
} from '../../../apps/api/src/platform/upgrade/upgrade.controller';
import {
  ControlApplicationRegistry,
  ControlRpcController,
} from '../../../apps/api/src/platform/control-rpc/control-rpc.module';
import { ApplicationFrameSchema } from '../../../apps/api/src/platform/control-rpc/control-rpc.contract';
import { PLATFORM_SQLITE } from '../../../apps/api/src/platform/persistence/platform-sqlite.token';
import { fenceCoordinatorConnection } from '../../../apps/api/src/platform/persistence/coordinator-lease';
import { EventsGateway } from '../../../apps/api/src/platform/events/events.gateway';
import { PasscodeGuard } from '../../../apps/api/src/platform/access-passcode/passcode.guard';
import { CoordinatorHandoff } from '../../../apps/api/src/platform/upgrade/coordinator-handoff';
import { UpgradeRoleHandoffs } from '../../../apps/api/src/platform/upgrade/upgrade-role-handoffs';
import { UpgradeObserver } from '../../../apps/api/src/platform/upgrade/upgrade-observer';
import { UpgradeOnlineMigration } from '../../../apps/api/src/platform/upgrade/upgrade-online-migration';
import { CoordinatorRecovery } from '../../../apps/api/src/platform/upgrade/coordinator-recovery';
import { UpgradeSecurity } from '../../../apps/api/src/platform/access-passcode/upgrade-security.service';
import {
  freezeUpgradePlan,
  upgradeDigest,
} from '../../../apps/api/src/platform/upgrade/upgrade-trust';
import { planFixtureEnvelope, planFixtureSource } from '../../support/upgrade-plan-fixture';
import { unused, stub, useEnv } from '../../support/strict-ports';
import { assertDefined } from '../../support/assert-defined';

// Real committed migration prefix and durable Store/Service/HTTP contracts.
// Synthetic state receipts below establish no Owner/SDK/Native qualification.
const close: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const work of close.splice(0).reverse()) await work();
});
const key = 'synthetic-schema29-light-control-key-at-least-32-characters';
const { DiscoveryModule } = createRequire(resolve('apps/api/package.json'))('@nestjs/core');
const { z } = createRequire(resolve('apps/api/package.json'))(
  'zod',
) as typeof import('../../../apps/api/node_modules/zod');
function fixture(schema = 29, realTime = false) {
  const directory = mkdtempSync(join(tmpdir(), 'schema29-light-control-')),
    instanceId = 'schema29-light-control';
  close.push(() => rmSync(directory, { recursive: true, force: true }));
  close.push(
    useEnv({
      PLATFORM_INSTANCE_ID: instanceId,
      PLATFORM_PROCESS_ROLE: 'coordinator',
      PLATFORM_CONTROLLER_RPC_KEY: key,
      PLATFORM_CONTROL_RPC_KEY: key,
      UPGRADE_BUSINESS_PROBE_KEY: key,
      COORDINATOR_GENERATION: undefined,
      COORDINATOR_WRITER_FENCE_VALID: undefined,
      UPGRADE_CONTROL_DATABASE_PATH: undefined,
    }),
  );
  const migrationsFolder = join(directory, 'drizzle');
  cpSync(resolve('drizzle'), migrationsFolder, { recursive: true });
  const path = join(migrationsFolder, 'meta/_journal.json'),
    journal = JSON.parse(readFileSync(path, 'utf8')) as { entries: unknown[] };
  journal.entries = journal.entries.slice(0, schema);
  writeFileSync(path, JSON.stringify(journal));
  let historicalCounts = 0;
  const raw = new Database(join(directory, 'business.sqlite'), {
    verbose: (sql) => {
      if (
        typeof sql === 'string' &&
        sql.startsWith('SELECT count(*) AS n FROM upgrade_probe_records WHERE attempt_id=')
      )
        historicalCounts++;
    },
  });
  raw.pragma('journal_mode=WAL');
  migrate(drizzle(raw), { migrationsFolder });
  let now = Date.parse('2026-11-07T00:00:00Z');
  const clock = { now: () => fromEpochMs(realTime ? Date.now() : now) },
    sqlite = realTime
      ? fenceCoordinatorConnection(raw, instanceId, clock, { next: randomUUID })
      : raw,
    store = new UpgradeStore(sqlite, clock, { next: randomUUID }, { instanceId }),
    source = planFixtureSource(schema),
    envelope = planFixtureEnvelope(source, '0.2.1'),
    plan = freezeUpgradePlan(envelope, source);
  close.push(() => {
    sqlite.close();
  });
  store.bootstrap(source);
  const accepted = store.accept(
      'fixture-user',
      {
        requestId: randomUUID(),
        targetReleaseId: envelope.manifest.releaseId,
        targetDigest: envelope.manifestDigest,
        expectedActivationGeneration: 1,
      },
      envelope,
      plan,
    ),
    id = accepted.attemptId,
    claim = store.claim(id, 'fixture-controller', 30000),
    step = assertDefined(plan.steps[0]);
  const command = (
    kind: UpgradeCommit['kind'],
    payload: Record<string, unknown>,
  ): UpgradeCommit => ({
    fence: claim.fence,
    generation: claim.generation,
    expectedSequence: store.attempt(id).sequence,
    eventId: randomUUID(),
    kind,
    payload,
  });
  const evidenceBytes = (payloadBytes: number) => {
    const overhead = JSON.stringify({ fixture: 'synthetic-size-only', padding: '' }).length;
    return { fixture: 'synthetic-size-only', padding: 'x'.repeat(payloadBytes - overhead) };
  };
  return {
    sqlite,
    store,
    source,
    envelope,
    plan,
    id,
    claim,
    step,
    command,
    evidenceBytes,
    instanceId,
    clock,
    advance: (ms: number) => {
      now += ms;
    },
    historyCounts: () => historicalCounts,
  };
}
async function http(f: ReturnType<typeof fixture>) {
  const service = new UpgradeService(
    f.store,
    unused<UpgradeCatalog>('catalog'),
    stub<UpgradeSecurity>({ internal: UpgradeSecurity.prototype.internal }),
    unused<UpgradeInspectionPort>('inspector'),
    f.clock,
  );
  const module = await Test.createTestingModule({
    imports: [DiscoveryModule],
    controllers: [UpgradeInternalController, UpgradeController, ControlRpcController],
    providers: [
      ControlApplicationRegistry,
      { provide: PLATFORM_SQLITE, useValue: f.sqlite },
      { provide: CLOCK, useValue: f.clock },
      {
        provide: PasscodeGuard,
        useValue: {
          canActivate: () => {
            throw Error('Ordinary auth cannot authorize probes');
          },
        },
      },
      { provide: EventsGateway, useValue: { activeTransportConnections: 0 } },
      { provide: TasksGateway, useValue: { activeTransportConnections: 0 } },
      { provide: TerminalGateway, useValue: { activeTransportConnections: 0 } },
      { provide: UpgradeService, useValue: service },
      ...[
        CoordinatorHandoff,
        UpgradeRoleHandoffs,
        UpgradeObserver,
        UpgradeOnlineMigration,
        CoordinatorRecovery,
      ].map((provide) => ({ provide, useValue: {} })),
    ],
  }).compile();
  const app = module.createNestApplication({ logger: false });
  await app.listen(0, '127.0.0.1');
  close.push(() => app.close());
  const origin = await app.getUrl();
  const call = async (path: string, body?: unknown) => {
    const response = await fetch(origin + '/internal/upgrades/' + f.id + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        'content-type': 'application/json',
        'x-platform-internal-key': key,
        'x-platform-instance-id': f.instanceId,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(2000),
    });
    return { status: response.status, value: JSON.parse(await response.text()) as unknown };
  };
  const probe = async (
    method: 'POST' | 'GET',
    request: { attemptId: string; fence: number; requestId: string; value: string },
  ) => {
    const response = await fetch(origin + '/internal/application/invoke', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-platform-internal-key': key,
        'x-platform-instance-id': f.instanceId,
      },
      body: JSON.stringify({
        operation: method === 'POST' ? 'UpgradeController.probe' : 'UpgradeController.readProbe',
        operationId: request.requestId,
        args: [null, method === 'POST' ? request : request.requestId],
        request: {
          method,
          path: '/api/system/upgrade/probe',
          headers: { 'x-platform-internal-key': key, 'x-platform-instance-id': f.instanceId },
          query: method === 'GET' ? { requestId: request.requestId } : {},
          remoteAddress: '127.0.0.1',
        },
      }),
      signal: AbortSignal.timeout(2000),
    });
    expect(response.status).toBe(201);
    const frames = (await response.text())
      .trim()
      .split('\n')
      .map((line) => ApplicationFrameSchema.parse(JSON.parse(line)));
    expect(frames.find((frame) => frame.type === 'headers')).toMatchObject({ status: 200 });
    return z
      .object({
        request_id: z.string().uuid(),
        value: z.string(),
        revision: z.number().int().positive(),
      })
      .parse(frames.find((frame) => frame.type === 'result')?.value);
  };
  return Object.assign(call, { probe });
}
const schemaWitness = (sqlite: Database.Database) => ({
  tables: sqlite
    .prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name')
    .all(),
  journal: sqlite.prepare('SELECT * FROM __drizzle_migrations ORDER BY id').all(),
});

describe('reviewed schema29 compatibility for the existing light control protocol', () => {
  it('uses real HTTP small receipts for a 4MB legacy applied checkpoint and preserves both legacy full replies', async () => {
    const f = fixture(),
      call = await http(f),
      beforeSchema = schemaWitness(f.sqlite),
      evidence = f.evidenceBytes(4053536);
    const original = f.store.commit(
      f.id,
      f.command('step-applied', {
        stepId: f.step.stepId,
        completedWork: f.step.totalWork,
        evidence,
        receiptDigest: upgradeDigest(evidence),
      }),
    );
    expect(original.appliedSteps[0]?.evidence).toEqual(evidence);
    const rawBefore = f.sqlite
      .prepare('SELECT * FROM upgrade_steps WHERE attempt_id=? AND step_id=?')
      .get(f.id, f.step.stepId);
    const parse = vi.spyOn(JSON, 'parse'),
      snapshot = vi.spyOn(f.store, 'snapshot');
    const lease = {
      fence: f.claim.fence,
      generation: f.claim.generation,
      controllerId: 'fixture-controller',
    };
    const check = await call('/authority-check', {
      fence: lease.fence,
      generation: lease.generation,
    });
    expect(check.status).toBe(200);
    expect(f.store.controlCapabilities()).toEqual({
      controlFastPath: 1,
      progressEvidenceReference: 1,
    });
    expect(Buffer.byteLength(JSON.stringify(check.value))).toBeLessThan(1024);
    expect((await call('/lease-renew', lease)).status).toBe(200);
    const checkpoint = await call(
      '/progress-checkpoint?fence=' + lease.fence + '&generation=' + lease.generation,
    );
    expect(checkpoint).toMatchObject({
      status: 200,
      value: {
        planDigest: f.plan.planDigest,
        step: {
          applied: true,
          evidenceDigest: upgradeDigest(evidence),
          receiptDigest: upgradeDigest(evidence),
        },
      },
    });
    const heartbeat = f.command('progress', {
      stepId: f.step.stepId,
      completedWork: f.step.totalWork,
      totalWork: f.step.totalWork,
      stage: f.store.attempt(f.id).state,
      evidenceDigest: upgradeDigest(evidence),
    });
    const committed = await call('/commit-receipt', heartbeat);
    expect(committed.status).toBe(200);
    expect(Buffer.byteLength(JSON.stringify(committed.value))).toBeLessThan(1024);
    expect(await call('/commit-receipt', heartbeat)).toEqual(committed);
    expect(snapshot).not.toHaveBeenCalled();
    expect(parse.mock.calls.some(([text]) => text.length >= 4053536)).toBe(false);
    parse.mockRestore();
    snapshot.mockRestore();
    const expiry = f.sqlite
      .prepare('SELECT lease_expires_at FROM upgrade_attempts WHERE attempt_id=?')
      .get(f.id);
    const legacyRead = await call('/renew', {
      fence: lease.fence,
      controllerId: null,
      checkOnly: true,
    });
    expect(legacyRead).toMatchObject({
      status: 200,
      value: { snapshot: { appliedSteps: [{ evidence }] } },
    });
    expect(
      f.sqlite
        .prepare('SELECT lease_expires_at FROM upgrade_attempts WHERE attempt_id=?')
        .get(f.id),
    ).toEqual(expiry);
    const legacyCommit = await call('/commit', f.command('progress', heartbeat.payload));
    expect(legacyCommit).toMatchObject({ status: 200, value: { appliedSteps: [{ evidence }] } });
    expect(
      f.sqlite
        .prepare('SELECT * FROM upgrade_steps WHERE attempt_id=? AND step_id=?')
        .get(f.id, f.step.stepId),
    ).toEqual(rawBefore);
    expect(schemaWitness(f.sqlite)).toEqual(beforeSchema);
  });

  it('hashes actual bounded unapplied evidence rather than borrowing any receipt, and preserves progress-reference conflicts', () => {
    const f = fixture(),
      evidence = { partial: true },
      fake = upgradeDigest({ forged: true });
    f.store.commit(
      f.id,
      f.command('progress', { stepId: f.step.stepId, completedWork: 1, evidence }),
    );
    f.sqlite
      .prepare('UPDATE upgrade_steps SET receipt_digest=? WHERE attempt_id=? AND step_id=?')
      .run(fake, f.id, f.step.stepId);
    const checkpoint = f.store.progressCheckpoint(f.id, f.claim.fence, f.claim.generation);
    expect(checkpoint.step).toMatchObject({
      applied: false,
      evidenceDigest: upgradeDigest(evidence),
      receiptDigest: fake,
    });
    const command = f.command('progress', {
        stepId: f.step.stepId,
        completedWork: 1,
        totalWork: f.step.totalWork,
        evidenceDigest: fake,
      }),
      sequence = f.store.attempt(f.id).sequence;
    expect(() => f.store.commitReceipt(f.id, command)).toThrow(
      'UPGRADE_PROGRESS_REFERENCE_INVALID',
    );
    expect(f.store.attempt(f.id).sequence).toBe(sequence);
    const actual = {
      ...command,
      payload: { ...command.payload, evidenceDigest: upgradeDigest(evidence) },
    };
    expect(f.store.commitReceipt(f.id, actual).eventSequence).toBe(sequence + 1);
    expect(f.store.commitReceipt(f.id, actual).eventSequence).toBe(sequence + 1);
    expect(() =>
      f.store.commitReceipt(f.id, { ...actual, payload: { ...actual.payload, completedWork: 2 } }),
    ).toThrow('UPGRADE_EVENT_PAYLOAD_CONFLICT');
  });

  it('rejects malformed, changed, wrong-target and oversized plans before exposing a light authority receipt', () => {
    const f = fixture(),
      original = JSON.stringify(f.plan),
      changed = { ...f.plan, sourceApiDigest: upgradeDigest({ another: true }) };
    const { planDigest: _old, ...facts } = f.plan;
    const foreign = { ...facts, manifestDigest: upgradeDigest({ foreign: true }) };
    for (const raw of [
      'not-json',
      JSON.stringify(changed),
      JSON.stringify({ ...foreign, planDigest: upgradeDigest(foreign) }),
      JSON.stringify({ ...f.plan, extra: true }),
      ' '.repeat(8 * 1024 * 1024 + 1),
    ]) {
      f.sqlite.prepare('UPDATE upgrade_attempts SET plan=? WHERE attempt_id=?').run(raw, f.id);
      const parse = vi.spyOn(JSON, 'parse');
      try {
        expect(() => f.store.authorityCheck(f.id, f.claim.fence, f.claim.generation)).toThrow(
          'UPGRADE_CONTROL_METADATA_UNKNOWN',
        );
        expect(() =>
          f.store.commitReceipt(f.id, {
            fence: f.claim.fence,
            generation: f.claim.generation,
            expectedSequence: 0,
            eventId: randomUUID(),
            kind: 'progress',
            payload: { stepId: f.step.stepId, completedWork: 0 },
          }),
        ).toThrow('UPGRADE_CONTROL_METADATA_UNKNOWN');
        if (raw.length > 8 * 1024 * 1024) expect(parse).not.toHaveBeenCalled();
      } finally {
        parse.mockRestore();
      }
    }
    f.sqlite.prepare('UPDATE upgrade_attempts SET plan=? WHERE attempt_id=?').run(original, f.id);
    expect(f.store.authorityCheck(f.id, f.claim.fence).planDigest).toBe(f.plan.planDigest);
  });

  it('fails closed on invalid/oversized unapplied evidence or an applied row without a valid persisted receipt', () => {
    const f = fixture();
    f.store.commit(
      f.id,
      f.command('progress', { stepId: f.step.stepId, completedWork: 1, evidence: null }),
    );
    expect(
      f.store.progressCheckpoint(f.id, f.claim.fence, f.claim.generation).step?.evidenceDigest,
    ).toBe(upgradeDigest(null));
    for (const evidence of ['not-json', ' '.repeat(8 * 1024 * 1024 + 1)]) {
      f.sqlite
        .prepare('UPDATE upgrade_steps SET evidence=? WHERE attempt_id=? AND step_id=?')
        .run(evidence, f.id, f.step.stepId);
      expect(() => f.store.progressCheckpoint(f.id, f.claim.fence, f.claim.generation)).toThrow(
        'UPGRADE_CONTROL_METADATA_UNKNOWN',
      );
    }
    f.sqlite
      .prepare(
        'UPDATE upgrade_steps SET applied=1,evidence=?,receipt_digest=NULL WHERE attempt_id=? AND step_id=?',
      )
      .run('{}', f.id, f.step.stepId);
    expect(() => f.store.progressCheckpoint(f.id, f.claim.fence, f.claim.generation)).toThrow(
      'UPGRADE_CONTROL_METADATA_UNKNOWN',
    );
    f.sqlite
      .prepare('UPDATE upgrade_steps SET applied=2 WHERE attempt_id=? AND step_id=?')
      .run(f.id, f.step.stepId);
    expect(() => f.store.progressCheckpoint(f.id, f.claim.fence, f.claim.generation)).toThrow(
      'UPGRADE_CONTROL_METADATA_UNKNOWN',
    );
  });

  it('never advertises the compatibility path for schema28, unknown journals or partial column layouts', () => {
    const old = fixture(28);
    expect(old.store.controlCapabilities()).toEqual({ progressEvidenceReference: 1 });
    expect(() => old.store.authorityCheck(old.id, old.claim.fence)).toThrow(
      'UPGRADE_CONTROL_METADATA_UNKNOWN',
    );
    const f = fixture();
    f.sqlite
      .prepare(
        "UPDATE __drizzle_migrations SET hash='unknown' WHERE rowid=(SELECT min(rowid) FROM __drizzle_migrations)",
      )
      .run();
    expect(f.store.controlCapabilities()).toEqual({ progressEvidenceReference: 1 });
    expect(() => f.store.authorityCheck(f.id, f.claim.fence)).toThrow(
      'UPGRADE_CONTROL_METADATA_UNKNOWN',
    );
    const partial = fixture();
    partial.sqlite.exec('ALTER TABLE upgrade_steps ADD evidence_digest TEXT');
    expect(partial.store.controlCapabilities()).toEqual({ progressEvidenceReference: 1 });
    expect(() => partial.store.authorityCheck(partial.id, partial.claim.fence)).toThrow(
      'UPGRADE_CONTROL_METADATA_UNKNOWN',
    );
    const noPk = fixture();
    noPk.sqlite.exec(
      'ALTER TABLE upgrade_steps RENAME TO original_steps_fixture; CREATE TABLE upgrade_steps(attempt_id text NOT NULL,step_id text NOT NULL,completed_work real NOT NULL DEFAULT 0,applied integer NOT NULL DEFAULT 0,receipt_digest text,evidence text,applied_at integer); INSERT INTO upgrade_steps SELECT * FROM original_steps_fixture',
    );
    expect(noPk.store.controlCapabilities()).toEqual({ progressEvidenceReference: 1 });
    expect(() => noPk.store.authorityCheck(noPk.id, noPk.claim.fence)).toThrow(
      'UPGRADE_CONTROL_METADATA_UNKNOWN',
    );
  });

  it('retains exact fence/generation/controller/instance/expiry and supersession checks without resurrecting a lease', () => {
    const f = fixture(),
      expiry = f.store.authorityCheck(f.id, f.claim.fence).leaseExpiresAt;
    expect(() => f.store.authorityCheck(f.id, f.claim.fence + 1)).toThrow('UPGRADE_FENCE_EXPIRED');
    expect(() =>
      f.store.leaseRenew(f.id, f.claim.fence, f.claim.generation + 1, 'fixture-controller'),
    ).toThrow('UPGRADE_FENCE_EXPIRED');
    expect(() => f.store.leaseRenew(f.id, f.claim.fence, f.claim.generation, 'foreign')).toThrow(
      'UPGRADE_CONTROLLER_MISMATCH',
    );
    const foreign = new UpgradeStore(
      f.sqlite,
      f.clock,
      { next: randomUUID },
      { instanceId: 'foreign' },
    );
    expect(() => foreign.authorityCheck(f.id, f.claim.fence)).toThrow('UPGRADE_ATTEMPT_NOT_FOUND');
    expect(f.store.authorityCheck(f.id, f.claim.fence).leaseExpiresAt).toBe(expiry);
    f.advance(30000);
    expect(() =>
      f.store.leaseRenew(f.id, f.claim.fence, f.claim.generation, 'fixture-controller'),
    ).toThrow('UPGRADE_FENCE_EXPIRED');
    expect(
      f.sqlite
        .prepare('SELECT lease_expires_at FROM upgrade_attempts WHERE attempt_id=?')
        .get(f.id),
    ).toEqual({ lease_expires_at: expiry });
    f.advance(-1);
    f.sqlite
      .prepare('INSERT INTO platform_operations VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(
        randomUUID(),
        f.instanceId,
        'fixture',
        'project-name-contract',
        f.claim.fence + 1,
        'fixture',
        'completed',
        null,
        1,
        1,
      );
    expect(() => f.store.authorityCheck(f.id, f.claim.fence)).toThrow(
      'UPGRADE_AUTHORITY_SUPERSEDED',
    );
  });

  it('combines >=60s real three-lane HTTP pairs with 1Hz lease/checkpoint/progress receipts over 277135 rows and 4MB evidence', async () => {
    const f = fixture(29, true),
      call = await http(f),
      evidence = f.evidenceBytes(4053536),
      evidenceDigest = upgradeDigest(evidence);
    f.store.commit(
      f.id,
      f.command('step-applied', {
        stepId: f.step.stepId,
        completedWork: f.step.totalWork,
        evidence,
        receiptDigest: evidenceDigest,
      }),
    );
    const insert = f.sqlite.prepare('INSERT INTO upgrade_probe_records VALUES(?,?,?,?,?)'),
      prior = randomUUID();
    f.sqlite
      .transaction(() => {
        for (let i = 1; i <= 277135 - 8880; i++)
          insert.run(randomUUID(), prior, 'sha256:' + 'a'.repeat(64), i, Date.now());
        for (let i = 1; i <= 8880; i++)
          insert.run(randomUUID(), f.id, 'sha256:' + 'a'.repeat(64), i, Date.now());
      })
      .immediate();
    const smoke = {
      attemptId: f.id,
      fence: f.claim.fence,
      requestId: randomUUID(),
      value: 'actual-local-rpc-smoke',
    };
    const smokeWritten = await call.probe('POST', smoke);
    expect(await call.probe('GET', smoke)).toEqual(smokeWritten);
    const originalEvidence = f.sqlite
      .prepare('SELECT evidence,receipt_digest FROM upgrade_steps WHERE attempt_id=? AND step_id=?')
      .get(f.id, f.step.stepId);
    const lanes = ['lane-a', 'lane-b', 'lane-c'] as const,
      samples: Record<(typeof lanes)[number], { at: number; latency: number; success: boolean }[]> =
        { 'lane-a': [], 'lane-b': [], 'lane-c': [] },
      inFlight = { 'lane-a': 0, 'lane-b': 0, 'lane-c': 0 },
      maxInFlight = { 'lane-a': 0, 'lane-b': 0, 'lane-c': 0 },
      pending = new Set<Promise<void>>(),
      parse = vi.spyOn(JSON, 'parse'),
      began = performance.now(),
      scans = f.historyCounts();
    let next = began,
      controlPending = false,
      controlOverlap = 0,
      controlFailures = 0,
      maxControlRpcMs = 0,
      lastSequence = f.store.attempt(f.id).sequence;
    const controlTimes: number[] = [];
    const checked = async (path: string, body?: unknown) => {
      const start = performance.now(),
        response = await call(path, body);
      maxControlRpcMs = Math.max(maxControlRpcMs, performance.now() - start);
      expect(response.status).toBe(200);
      expect(Buffer.byteLength(JSON.stringify(response.value))).toBeLessThan(2048);
      expect(response.value).toMatchObject({
        instanceId: f.instanceId,
        attemptId: f.id,
        targetDigest: f.envelope.manifestDigest,
        planDigest: f.plan.planDigest,
        generation: f.claim.generation,
        fence: f.claim.fence,
        controllerId: 'fixture-controller',
      });
      return response.value;
    };
    const pair = async (lane: (typeof lanes)[number]) => {
      const request = {
          attemptId: f.id,
          fence: f.claim.fence,
          requestId: randomUUID(),
          value: upgradeDigest({ request: randomUUID() }),
        },
        at = performance.now();
      let latency = 0,
        success = false;
      inFlight[lane]++;
      maxInFlight[lane] = Math.max(maxInFlight[lane], inFlight[lane]);
      try {
        const a = performance.now(),
          written = await call.probe('POST', request);
        latency = Math.max(latency, performance.now() - a);
        const b = performance.now(),
          read = await call.probe('GET', request);
        latency = Math.max(latency, performance.now() - b);
        success =
          written.request_id === request.requestId &&
          read.request_id === request.requestId &&
          written.value === request.value &&
          read.value === request.value &&
          written.revision === read.revision;
      } catch {
        latency = Math.max(latency, performance.now() - at);
      } finally {
        samples[lane].push({ at, latency, success });
        inFlight[lane]--;
      }
    };
    const track = (work: Promise<void>) => {
      pending.add(work);
      void work.finally(() => pending.delete(work));
    };
    const probes = setInterval(() => {
      const due = Math.max(0, Math.floor((performance.now() - next) / 50) + 1);
      next += due * 50;
      for (let slot = 0; slot < Math.min(due, 4); slot++)
        for (const lane of lanes) if (inFlight[lane] < 80) track(pair(lane));
    }, 50);
    const controls = setInterval(() => {
      if (controlPending) {
        controlOverlap++;
        return;
      }
      controlPending = true;
      const at = performance.now();
      track(
        (async () => {
          try {
            await checked('/authority-check', {
              fence: f.claim.fence,
              generation: f.claim.generation,
            });
            await checked('/lease-renew', {
              fence: f.claim.fence,
              generation: f.claim.generation,
              controllerId: 'fixture-controller',
            });
            const checkpoint = z
              .object({
                sequence: z.number().int(),
                state: z.string(),
                step: z.object({
                  stepId: z.string(),
                  completedWork: z.number(),
                  applied: z.literal(true),
                  evidenceDigest: z.string(),
                  receiptDigest: z.string(),
                }),
              })
              .parse(
                await checked(
                  '/progress-checkpoint?fence=' +
                    f.claim.fence +
                    '&generation=' +
                    f.claim.generation,
                ),
              );
            expect(checkpoint.sequence).toBe(lastSequence);
            expect(checkpoint.step.evidenceDigest).toBe(evidenceDigest);
            expect(checkpoint.step.receiptDigest).toBe(evidenceDigest);
            const command: UpgradeCommit = {
              fence: f.claim.fence,
              generation: f.claim.generation,
              expectedSequence: checkpoint.sequence,
              eventId: randomUUID(),
              kind: 'progress',
              payload: {
                stepId: checkpoint.step.stepId,
                completedWork: checkpoint.step.completedWork,
                totalWork: f.step.totalWork,
                stage: checkpoint.state,
                evidenceDigest: checkpoint.step.evidenceDigest,
              },
            };
            const receipt = await checked('/commit-receipt', command);
            expect(receipt).toMatchObject({
              eventId: command.eventId,
              eventDigest: upgradeDigest(command),
              eventSequence: lastSequence + 1,
              sequence: lastSequence + 1,
            });
            lastSequence++;
            controlTimes.push(at);
          } catch {
            controlFailures++;
          } finally {
            controlPending = false;
          }
        })(),
      );
    }, 1000);
    try {
      await new Promise<void>((resolve) => setTimeout(resolve, 65000));
    } finally {
      clearInterval(probes);
      clearInterval(controls);
      await Promise.all(pending);
    }
    const measured = lanes.map((lane) => {
      const rows = samples[lane].sort((a, b) => a.at - b.at),
        windowMs = assertDefined(rows.at(-1)).at - assertDefined(rows[0]).at,
        hz = (1000 * (rows.length - 1)) / windowMs,
        failures = rows.filter((row) => !row.success).length,
        maxLatencyMs = Math.max(...rows.map((row) => row.latency));
      expect(windowMs).toBeGreaterThanOrEqual(60000);
      expect(hz).toBeGreaterThanOrEqual(10);
      expect(failures).toBe(0);
      expect(maxLatencyMs).toBeLessThanOrEqual(2000);
      expect(maxInFlight[lane]).toBeLessThanOrEqual(80);
      return {
        lane,
        samples: rows.length,
        windowMs,
        hz,
        failures,
        maxLatencyMs,
        maxInFlight: maxInFlight[lane],
      };
    });
    expect(controlTimes.length).toBeGreaterThanOrEqual(60);
    expect(
      assertDefined(controlTimes.at(-1)) - assertDefined(controlTimes[0]),
    ).toBeGreaterThanOrEqual(60000);
    expect(controlFailures).toBe(0);
    expect(controlOverlap).toBe(0);
    expect(maxControlRpcMs).toBeLessThanOrEqual(2000);
    expect(f.historyCounts() - scans).toBe(0);
    expect(parse.mock.calls.some(([text]) => text.length >= 4053536)).toBe(false);
    parse.mockRestore();
    expect(
      f.sqlite
        .prepare(
          'SELECT evidence,receipt_digest FROM upgrade_steps WHERE attempt_id=? AND step_id=?',
        )
        .get(f.id, f.step.stepId),
    ).toEqual(originalEvidence);
    console.info(
      'ACTUAL_SCHEMA29_COMBINED_HTTP_AND_LIGHT_CONTROL',
      JSON.stringify({
        logicalRequestLanes: true,
        physicalNestListeners: 1,
        seedRows: 277135,
        appliedEvidenceBytes: 4053536,
        elapsedMs: performance.now() - began,
        historicalCountQueries: f.historyCounts() - scans,
        controlRounds: controlTimes.length,
        controlWindowMs: assertDefined(controlTimes.at(-1)) - assertDefined(controlTimes[0]),
        controlFailures,
        controlOverlap,
        maxControlRpcMs,
        measured,
      }),
    );
  }, 85000);
});
