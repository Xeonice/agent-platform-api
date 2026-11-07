import 'reflect-metadata';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { cpSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { createRequire } from 'node:module';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLOCK, fromEpochMs } from '@platform/shared-kernel';
import { TasksGateway } from '@platform/sandbox';
import { TerminalGateway } from '@platform/terminal';
import { PLATFORM_SQLITE } from '../../../apps/api/src/platform/persistence/platform.module';
import { fenceCoordinatorConnection } from '../../../apps/api/src/platform/persistence/coordinator-lease';
import { UpgradeStore } from '../../../apps/api/src/platform/upgrade/upgrade-store';
import { UpgradeService } from '../../../apps/api/src/platform/upgrade/upgrade-service';
import { UpgradeController } from '../../../apps/api/src/platform/upgrade/upgrade.controller';
import { UpgradeCatalog } from '../../../apps/api/src/platform/upgrade/upgrade-catalog';
import type { UpgradeInspectionPort } from '../../../apps/api/src/platform/upgrade/upgrade-inspection.port';
import { UpgradeSecurity } from '../../../apps/api/src/platform/access-passcode/upgrade-security.service';
import { PasscodeGuard } from '../../../apps/api/src/platform/access-passcode/passcode.guard';
import { EventsGateway } from '../../../apps/api/src/platform/events/events.gateway';
import {
  ControlApplicationRegistry,
  ControlRpcController,
} from '../../../apps/api/src/platform/control-rpc/control-rpc.module';
import {
  freezeUpgradePlan,
  upgradeDigest,
} from '../../../apps/api/src/platform/upgrade/upgrade-trust';
import { planFixtureSource, planFixtureEnvelope } from '../../support/upgrade-plan-fixture';
import { unused, useEnv } from '../../support/strict-ports';
import { assertDefined } from '../../support/assert-defined';

const { DiscoveryModule } = createRequire(resolve('apps/api/package.json'))('@nestjs/core');

// Actual schema29 SQL, Store/Service/Controller and the production RPC mutation
// journal. Synthetic historical probe rows have the measured production count
// and payload width; they are not historical upgrade/adoption receipts. No SDK,
// package, Owner or Native qualification is constructed by this local fixture.
const instanceId = 'probe-history-local',
  key = 'synthetic-probe-rpc-key-at-least-32-characters';
const businessKey = 'synthetic-business-probe-key-at-least-32-characters';
const controllerId = 'synthetic-history-controller';
const clock = { now: () => fromEpochMs(Date.now()) };
let directory = '',
  restore = () => {},
  app: INestApplication;
let db: Database.Database,
  store: UpgradeStore,
  service: UpgradeService,
  registry: ControlApplicationRegistry;
let attemptId = '',
  fence = 0,
  origin = '',
  countQueries = 0;
let seedCount = 0,
  seedBytes = 0;

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'probe-history-schema29-'));
  restore = useEnv({
    PLATFORM_PROCESS_ROLE: 'coordinator',
    PLATFORM_INSTANCE_ID: instanceId,
    PLATFORM_CONTROL_RPC_KEY: key,
    UPGRADE_BUSINESS_PROBE_KEY: businessKey,
    UPGRADE_CONTROL_DATABASE_PATH: undefined,
  });
  const migrationsFolder = join(directory, 'schema29');
  cpSync(resolve('drizzle'), migrationsFolder, { recursive: true });
  const journalPath = join(migrationsFolder, 'meta/_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: unknown[] };
  journal.entries = journal.entries.slice(0, 29);
  writeFileSync(journalPath, JSON.stringify(journal));
  const raw = new Database(join(directory, 'business.sqlite'), {
    verbose: (sql) => {
      if (
        typeof sql === 'string' &&
        sql.startsWith('SELECT count(*) AS n FROM upgrade_probe_records WHERE attempt_id=')
      )
        countQueries++;
    },
  });
  raw.pragma('journal_mode=WAL');
  migrate(drizzle(raw), { migrationsFolder });
  db = fenceCoordinatorConnection(raw, instanceId, clock, { next: randomUUID });
  store = new UpgradeStore(db, clock, { next: randomUUID }, { instanceId });
  const source = planFixtureSource(29),
    envelope = planFixtureEnvelope(source, '0.2.1');
  store.bootstrap(source);
  attemptId = store.accept(
    'fixture-actor',
    {
      requestId: randomUUID(),
      targetReleaseId: envelope.manifest.releaseId,
      targetDigest: envelope.manifestDigest,
      expectedActivationGeneration: 1,
    },
    envelope,
    freezeUpgradePlan(envelope, source),
  ).attemptId;
  fence = store.claim(attemptId, controllerId, 120000).fence;
  const insert = db.prepare('INSERT INTO upgrade_probe_records VALUES(?,?,?,?,?)');
  const historyId = randomUUID(),
    value = 'sha256:' + 'a'.repeat(64);
  db.transaction(() => {
    for (let i = 1; i <= 277135 - 8880; i++)
      insert.run(randomUUID(), historyId, value, i, Date.now());
    for (let i = 1; i <= 8880; i++) insert.run(randomUUID(), attemptId, value, i, Date.now());
  }).immediate();
  seedCount =
    db.prepare<unknown[], { n: number }>('SELECT count(*) n FROM upgrade_probe_records').get()?.n ??
    0;
  // A genuine 4,053,536-byte synthetic step receipt also exercises the real
  // snapshot/renew serialization cost. Nothing in it claims physical handoff.
  const overhead = JSON.stringify({ kind: 'synthetic-size-only', padding: '' }).length;
  const evidence = { kind: 'synthetic-size-only', padding: 'x'.repeat(4053536 - overhead) };
  expect(
    db
      .prepare(
        'UPDATE upgrade_steps SET evidence=?,receipt_digest=?,applied=1,applied_at=? WHERE attempt_id=? AND step_id=?',
      )
      .run(
        JSON.stringify(evidence),
        upgradeDigest(evidence),
        Date.now(),
        attemptId,
        'coordinator-handoff',
      ).changes,
  ).toBe(1);
  db.pragma('wal_checkpoint(TRUNCATE)');
  seedBytes = statSync(db.name).size;
  service = new UpgradeService(
    store,
    unused<UpgradeCatalog>('unused catalog'),
    unused<UpgradeSecurity>('unused ordinary access'),
    unused<UpgradeInspectionPort>('unused inspector'),
    clock,
  );
  const module = await Test.createTestingModule({
    imports: [DiscoveryModule],
    controllers: [UpgradeController, ControlRpcController],
    providers: [
      ControlApplicationRegistry,
      { provide: UpgradeService, useValue: service },
      { provide: PLATFORM_SQLITE, useValue: db },
      { provide: CLOCK, useValue: clock },
      {
        provide: PasscodeGuard,
        useValue: {
          canActivate: () => {
            throw Error('Ordinary auth cannot authorize a probe');
          },
        },
      },
      { provide: EventsGateway, useValue: { activeTransportConnections: 0 } },
      { provide: TasksGateway, useValue: { activeTransportConnections: 0 } },
      { provide: TerminalGateway, useValue: { activeTransportConnections: 0 } },
    ],
  }).compile();
  app = module.createNestApplication();
  await app.init();
  await app.listen(0, '127.0.0.1');
  origin = await app.getUrl();
  registry = app.get(ControlApplicationRegistry);
}, 30000);

afterAll(async () => {
  await app?.close();
  if (db?.open) db.close();
  restore();
  if (directory) rmSync(directory, { recursive: true, force: true });
});

const input = () => ({
  attemptId,
  fence,
  requestId: randomUUID(),
  value: upgradeDigest({ nonce: randomUUID() }),
});
const count = () =>
  db
    .prepare<unknown[], { n: number }>(
      'SELECT count(*) n FROM upgrade_probe_records WHERE attempt_id=?',
    )
    .get(attemptId)?.n ?? 0;
async function rpc(method: 'POST' | 'GET', requestId: string, value?: ReturnType<typeof input>) {
  const response = await fetch(origin + '/internal/application/invoke', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-platform-internal-key': key,
      'x-platform-instance-id': instanceId,
    },
    body: JSON.stringify({
      operation: method === 'POST' ? 'UpgradeController.probe' : 'UpgradeController.readProbe',
      operationId: requestId,
      // RPC args preserve the real Controller parameter positions: @Req is
      // index 0, and @Body/@Query is index 1. Registry supplies @Req itself.
      args: method === 'POST' ? [null, value] : [null, requestId],
      request: {
        method,
        path: '/api/system/upgrade/probe',
        query: method === 'GET' ? { requestId } : {},
        remoteAddress: '127.0.0.1',
        headers: { 'x-platform-internal-key': businessKey, 'x-platform-instance-id': instanceId },
      },
    }),
    signal: AbortSignal.timeout(2000),
  });
  const frames: unknown = (await response.text())
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown);
  // The private POST transport has Nest's 201 default; the production RPC
  // headers frame carries the public probe handler's actual 200 status.
  if (response.status !== 201 || !Array.isArray(frames))
    throw Error('ACTUAL_PROBE_HTTP_FAILED:' + response.status);
  const headers = frames.find(
    (x): x is { type: 'headers'; status: number } =>
      !!x && typeof x === 'object' && 'type' in x && x.type === 'headers',
  );
  if (headers?.status !== 200) throw Error('ACTUAL_PROBE_HANDLER_FAILED');
  const result = frames.find(
    (x): x is { type: string; value: { request_id: string; value: string; revision: number } } =>
      !!x && typeof x === 'object' && 'type' in x && x.type === 'result',
  );
  if (!result) throw Error('ACTUAL_PROBE_RESULT_MISSING');
  return result.value;
}

describe('real schema29 probe append revision over production-sized history', () => {
  it('keeps the historical table/schema and avoids a historical count for consecutive same-attempt writes', () => {
    expect(seedCount).toBe(277135);
    expect(seedBytes).toBeGreaterThan(55 * 1024 * 1024);
    expect(db.prepare('SELECT count(*) n FROM __drizzle_migrations').get()).toEqual({ n: 29 });
    expect(db.pragma('index_list(upgrade_probe_records)')).toHaveLength(1);
    const before = count(),
      scans = countQueries;
    for (let i = 1; i <= 4; i++)
      expect(service.probe(input())).toMatchObject({ revision: before + i });
    expect(countQueries - scans).toBe(0);
    expect(count()).toBe(before + 4);
  });
  it('preserves original request dedup and rejects changed value or foreign-attempt reuse', () => {
    const request = input(),
      before = count(),
      first = service.probe(request);
    expect(service.probe(request)).toEqual(first);
    expect(count()).toBe(before + 1);
    expect(() => service.probe({ ...request, value: 'changed' })).toThrow('PROBE_ID_CONFLICT');
    // Insert a prior foreign request only as a state-boundary negative fixture.
    db.prepare('UPDATE upgrade_probe_records SET attempt_id=? WHERE request_id=?').run(
      randomUUID(),
      request.requestId,
    );
    expect(() => service.probe(request)).toThrow('PROBE_ID_CONFLICT');
    db.prepare('UPDATE upgrade_probe_records SET attempt_id=? WHERE request_id=?').run(
      attemptId,
      request.requestId,
    );
  });
  it('handles an independent legacy append, a different-attempt tail, and a fresh service incarnation', () => {
    const before = count(),
      insert = db.prepare('INSERT INTO upgrade_probe_records VALUES(?,?,?,?,?)');
    const legacy = new Database(db.name);
    try {
      legacy
        .transaction(() => {
          const prior = legacy
            .prepare<unknown[], { n: number }>(
              'SELECT count(*) n FROM upgrade_probe_records WHERE attempt_id=?',
            )
            .get(attemptId);
          legacy
            .prepare('INSERT INTO upgrade_probe_records VALUES(?,?,?,?,?)')
            .run(randomUUID(), attemptId, 'legacy', assertDefined(prior).n + 1, Date.now());
        })
        .immediate();
    } finally {
      legacy.close();
    }
    expect(service.probe(input())).toMatchObject({ revision: before + 2 });
    insert.run(randomUUID(), randomUUID(), 'other-attempt', 1, Date.now());
    const restarted = new UpgradeService(
      store,
      unused('catalog'),
      unused('security'),
      unused('inspector'),
      clock,
    );
    const scans = countQueries;
    expect(restarted.probe(input())).toMatchObject({ revision: before + 3 });
    expect(countQueries - scans).toBe(1);
    expect(service.probe(input())).toMatchObject({ revision: before + 4 });
  });
  it('uses the original count for an empty table or invalid tail revision without retaining memory state', () => {
    const originalCount = count(),
      rollback = new Error('rollback local malformed-state fixture');
    for (const revision of [0, -1, Number.MAX_SAFE_INTEGER]) {
      const scans = countQueries;
      expect(() =>
        db
          .transaction(() => {
            db.prepare(
              'UPDATE upgrade_probe_records SET revision=? WHERE rowid=(SELECT max(rowid) FROM upgrade_probe_records)',
            ).run(revision);
            expect(service.probe(input())).toMatchObject({ revision: originalCount + 1 });
            throw rollback;
          })
          .immediate(),
      ).toThrow(rollback);
      expect(countQueries - scans).toBe(1);
      expect(count()).toBe(originalCount);
    }
    expect(() =>
      db
        .transaction(() => {
          db.prepare('DELETE FROM upgrade_probe_records').run();
          expect(service.probe(input())).toMatchObject({ revision: 1 });
          throw rollback;
        })
        .immediate(),
    ).toThrow(rollback);
    expect(count()).toBe(originalCount);
  });
  it('rolls back a failed insert without skipping revision, and retains fence denial', () => {
    const request = input(),
      before = count();
    db.exec(
      `CREATE TEMP TRIGGER reject_probe_fixture BEFORE INSERT ON upgrade_probe_records WHEN NEW.request_id='${request.requestId}' BEGIN SELECT RAISE(ABORT,'fixture rollback'); END`,
    );
    try {
      expect(() => service.probe(request)).toThrow('fixture rollback');
    } finally {
      db.exec('DROP TRIGGER reject_probe_fixture');
    }
    expect(count()).toBe(before);
    expect(service.probe(request)).toMatchObject({ revision: before + 1 });
    expect(() => service.probe({ ...input(), fence: fence + 1 })).toThrow('UPGRADE_FENCE_EXPIRED');
    expect(count()).toBe(before + 1);
  });
  it('retains actual HTTP probe authorization and retirement admission', async () => {
    const request = input(),
      written = await rpc('POST', request.requestId, request);
    expect(await rpc('GET', request.requestId)).toEqual(written);
    expect(written).toMatchObject({ request_id: request.requestId, value: request.value });
    const denied = await fetch(origin + '/system/upgrade/probe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input()),
    });
    expect(denied.status).toBe(403);
    registry.closeRetirementAdmission();
    try {
      await expect(rpc('POST', randomUUID(), input())).rejects.toThrow('ACTUAL_PROBE_HTTP_FAILED');
    } finally {
      registry.resume();
    }
  });
  it('sustains three actual HTTP POST/GET lanes for >=60s with 277135 history rows and a 4MB step', async () => {
    // These are three logical request lanes against this one real Nest RPC
    // listener, not three physical gateway/source/candidate processes.
    const lanes = ['lane-a', 'lane-b', 'lane-c'] as const;
    const samples: Record<
      (typeof lanes)[number],
      { at: number; latency: number; success: boolean }[]
    > = { 'lane-a': [], 'lane-b': [], 'lane-c': [] };
    const pending = new Set<Promise<void>>(),
      inFlight = { 'lane-a': 0, 'lane-b': 0, 'lane-c': 0 };
    const maxInFlight = { 'lane-a': 0, 'lane-b': 0, 'lane-c': 0 };
    const scans = countQueries,
      began = performance.now();
    let next = began,
      maxRenewMs = 0;
    const renew = setInterval(() => {
      const start = performance.now();
      JSON.parse(JSON.stringify(store.renew(attemptId, fence, controllerId)));
      maxRenewMs = Math.max(maxRenewMs, performance.now() - start);
    }, 5000);
    const pair = async (lane: (typeof lanes)[number]) => {
      const request = input(),
        at = performance.now();
      let latency = 0,
        success = false;
      inFlight[lane]++;
      maxInFlight[lane] = Math.max(maxInFlight[lane], inFlight[lane]);
      try {
        const writeStart = performance.now(),
          written = await rpc('POST', request.requestId, request);
        latency = Math.max(latency, performance.now() - writeStart);
        const readStart = performance.now(),
          read = await rpc('GET', request.requestId);
        latency = Math.max(latency, performance.now() - readStart);
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
    const timer = setInterval(() => {
      const now = performance.now(),
        due = Math.max(0, Math.floor((now - next) / 50) + 1);
      next += due * 50;
      for (let slot = 0; slot < Math.min(due, 4); slot++)
        for (const lane of lanes)
          if (inFlight[lane] < 80) {
            const work = pair(lane);
            pending.add(work);
            void work.finally(() => pending.delete(work));
          }
    }, 50);
    try {
      await new Promise<void>((resolve) => setTimeout(resolve, 65000));
    } finally {
      clearInterval(timer);
      clearInterval(renew);
      await Promise.all(pending);
    }
    const measured = lanes.map((lane) => {
      const values = samples[lane].sort((a, b) => a.at - b.at),
        first = assertDefined(values[0]),
        last = assertDefined(values.at(-1));
      const windowMs = last.at - first.at,
        hz = (1000 * (values.length - 1)) / windowMs;
      const failures = values.filter((x) => !x.success).length,
        maxLatencyMs = Math.max(...values.map((x) => x.latency));
      expect(windowMs).toBeGreaterThanOrEqual(60000);
      expect(hz).toBeGreaterThanOrEqual(10);
      expect(failures).toBe(0);
      expect(maxLatencyMs).toBeLessThanOrEqual(2000);
      expect(maxInFlight[lane]).toBeLessThanOrEqual(80);
      return {
        lane,
        samples: values.length,
        windowMs,
        hz,
        failures,
        maxLatencyMs,
        maxInFlight: maxInFlight[lane],
      };
    });
    expect(countQueries - scans).toBe(0);
    expect(
      db
        .prepare(
          'SELECT octet_length(evidence) n FROM upgrade_steps WHERE attempt_id=? AND step_id=?',
        )
        .get(attemptId, 'coordinator-handoff'),
    ).toEqual({ n: 4053536 });
    console.info(
      'ACTUAL_SCHEMA29_HISTORY_HTTP_PAIRS',
      JSON.stringify({
        seedCount,
        seedBytes,
        logicalRequestLanes: true,
        physicalNestListeners: 1,
        elapsedMs: performance.now() - began,
        countedHistoricalTableInWindow: countQueries - scans,
        maxRenewSnapshotSerializeMs: maxRenewMs,
        measured,
      }),
    );
  }, 80000);
});
