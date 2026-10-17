import 'reflect-metadata';
import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fromEpochMs } from '@platform/shared-kernel';
import { UpgradeObserver } from '../../../apps/api/src/platform/upgrade/upgrade-observer';
import {
  UpgradeProbeEvidence,
  type UpgradeProbeLane,
} from '../../../apps/api/src/platform/upgrade/upgrade-probe-evidence';
import { UPGRADE_PROBE_IDENTITY_HEADERS } from '../../../apps/api/src/platform/upgrade/upgrade-probe-identity';
import { useEnv } from '../../support/strict-ports';
import { COORDINATOR_WRITER_CONTROL } from '../../../apps/api/src/platform/persistence/coordinator-lease';
import * as integrity from '../../../apps/api/src/platform/upgrade/migration-database-integrity';

type Json = Record<string, unknown>;
let servers: Server[] = [],
  restore = () => {};
let clockOffset = 0;
const files: Array<{ db: Database.Database; directory: string }> = [];
const clock = { now: () => fromEpochMs(Date.now() + clockOffset) };
const ids = { next: randomUUID };
const instanceId = 'verified-observer-http-fixture';
const sourceDigest = 'sha256:' + 'a'.repeat(64),
  candidateDigest = 'sha256:' + 'b'.repeat(64);
interface Backend {
  origin: string;
  mode: 'ok' | 'fail' | 'mismatch' | 'partial';
  start: string;
  headers: boolean;
  waitMs: number;
  requests: Array<{ method: string; operationId: string; requestId: string }>;
  identities: number;
  rotateAfterWrite: boolean;
}
async function backend(digest: string, headers: boolean): Promise<Backend> {
  const state: Backend = {
    origin: '',
    mode: 'ok',
    start: randomUUID(),
    headers,
    waitMs: 0,
    requests: [],
    identities: 0,
    rotateAfterWrite: false,
  };
  const records = new Map<string, Json>();
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://127.0.0.1');
    res.setHeader('content-type', 'application/json');
    if (url.pathname === '/internal/control/identity') {
      state.identities++;
      res.end(
        JSON.stringify({
          instanceId,
          role: 'control',
          artifactDigest: digest,
          startIdentity: state.start,
          coordinatorGeneration: Number(process.env.COORDINATOR_GENERATION),
          writerFenceValid: true,
        }),
      );
      return;
    }
    if (state.waitMs) await delay(state.waitMs);
    if (req.aborted || res.destroyed) return;
    if (state.headers) {
      res.setHeader(UPGRADE_PROBE_IDENTITY_HEADERS.instanceId, instanceId);
      res.setHeader(
        UPGRADE_PROBE_IDENTITY_HEADERS.artifactDigest,
        state.mode === 'mismatch' ? sourceDigest : digest,
      );
      if (state.mode !== 'partial')
        res.setHeader(UPGRADE_PROBE_IDENTITY_HEADERS.startIdentity, state.start);
    }
    let requestId = url.searchParams.get('requestId')!;
    if (req.method === 'POST') {
      let body = '';
      for await (const bytes of req) body += String(bytes);
      const input = JSON.parse(body) as Json;
      requestId = String(input.requestId);
      records.set(requestId, {
        request_id: requestId,
        value: input.value,
        revision: records.size + 1,
      });
      if (state.rotateAfterWrite) state.start = randomUUID();
    }
    state.requests.push({
      method: req.method!,
      operationId: String(req.headers['x-operation-id']),
      requestId,
    });
    res.statusCode = state.mode === 'fail' ? 500 : 200;
    res.end(JSON.stringify(records.get(requestId) ?? {}));
  });
  servers.push(server);
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  state.origin = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
  return state;
}
async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'upg-observer-integrity-')),
    db = new Database(join(directory, 'observation.sqlite'));
  db.exec('CREATE TABLE unrelated_history(id INTEGER PRIMARY KEY, payload BLOB)');
  files.push({ db, directory });
  const source = await backend(sourceDigest, false),
    candidate = await backend(candidateDigest, true);
  let binding: Json = {
    instanceId,
    attemptId: 'attempt',
    fence: 7,
    routeGeneration: 1,
    weight: 1,
    oldApi: { origin: source.origin, digest: sourceDigest },
    candidateApi: { origin: candidate.origin, digest: candidateDigest },
    web: { digest: sourceDigest },
  };
  const durable: unknown[][] = [];
  const policy = {
    minRequests: 100,
    stageDurationMs: 60000,
    observationFreshnessMs: 5000,
    probeHz: 10,
    requestDeadlineMs: 2000,
    attachDeadlineMs: 5000,
  };
  const snapshot = {
    fence: 7,
    leaseExpiresAt: clock.now().getTime() + 600000,
    plan: { policy, migrationPath: {} },
    appliedSteps: [
      {
        stepId: 'candidate',
        evidence: {
          origin: candidate.origin,
          artifactDigest: candidateDigest,
          startIdentity: candidate.start,
        },
      },
    ],
    sourceActivation: {
      components: {
        web: { artifactDigest: sourceDigest, webRevision: 'source' },
        api: { artifactDigest: sourceDigest },
      },
    },
    manifest: {
      components: {
        web: { artifactDigest: candidateDigest, webRevision: 'candidate' },
        api: { artifactDigest: candidateDigest },
      },
    },
  };
  let writerValid = true,
    controllerValid = true;
  const writer = {
    instanceId,
    generation: Number(process.env.COORDINATOR_GENERATION),
    fence: 3,
    assert: () => {
      if (!writerValid) throw new Error('COORDINATOR_WRITER_FENCE_EXPIRED');
    },
  };
  const store = {
    instanceId,
    latest: () => ({ attemptId: 'attempt' }),
    snapshot: () => snapshot,
    latestProbeSnapshot: () => ({ attempt: { attemptId: 'attempt' }, ...snapshot }),
    assertFence: () => {
      if (!controllerValid) throw new Error('UPGRADE_FENCE_EXPIRED');
    },
    sqlite: {
      name: db.name,
      [COORDINATOR_WRITER_CONTROL]: writer,
      prepare: (sql: string) => ({
        run: (...args: unknown[]) => durable.push(args),
        get: () =>
          sql.includes('upgrade_continuity_baselines')
            ? {
                snapshot: JSON.stringify({
                  resources: [],
                  tasks: [],
                  observedAt: new Date().toISOString(),
                }),
              }
            : { n: 0 },
      }),
      pragma: () => {
        throw new Error('WHOLE_DATABASE_SCAN_ON_EVENT_LOOP');
      },
    },
  };
  const inspector = {
    entryBinding: async () => binding,
    controlIdentity: async (origin: string) =>
      (await (await fetch(origin + '/internal/control/identity')).json()) as Json,
    continuity: async () => ({
      qualified: true,
      observedAt: clock.now().toISOString(),
      resources: [],
      owner: {
        operations: [],
        owners: [
          {
            lease: {
              generation: Number(process.env.COORDINATOR_GENERATION),
              expiresAt: clock.now().getTime() + 60000,
            },
          },
        ],
      },
    }),
    webBuild: async () => ({ webRevision: 'source' }),
  };
  const evidence = new UpgradeProbeEvidence(clock, ids);
  process.env.PLATFORM_ENTRY_ORIGIN = source.origin; // Real gateway traffic all lands on healthy A.
  const observer = new UpgradeObserver(
    store as never,
    inspector as never,
    clock,
    ids,
    {} as never,
    { projectionReadEvidence: () => ({}) } as never,
    evidence,
  );
  const sample = (lane: UpgradeProbeLane) => observer['sample'](lane);
  const read = (lane: UpgradeProbeLane) =>
    evidence.read(
      lane,
      {
        attemptId: 'attempt',
        fence: 7,
        routeGeneration: Number(binding.routeGeneration),
        routeWeight: Number(binding.weight),
        coordinatorGeneration: Number(process.env.COORDINATOR_GENERATION),
        observerEpoch: evidence.observerEpoch,
      },
      5000,
    );
  return {
    source,
    candidate,
    sample,
    read,
    evidence,
    observer,
    durable,
    snapshot,
    db,
    inspector,
    writer,
    retireWriter: () => {
      writerValid = false;
    },
    expireController: () => {
      controllerValid = false;
    },
    binding: () => binding,
    change: (patch: Json) => {
      binding = { ...binding, ...patch };
    },
  };
}
beforeEach(() => {
  clockOffset = 0;
  restore = useEnv({
    PLATFORM_PROCESS_ROLE: 'coordinator',
    COORDINATOR_WRITER_FENCE_VALID: 'true',
    COORDINATOR_GENERATION: '2',
    PLATFORM_ENTRY_ORIGIN: undefined,
    PLATFORM_CONTROLLER_RPC_KEY: 'synthetic-fixture-controller-key',
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise<void>((ok) => server.close(() => ok()));
  }
  servers = [];
  for (const { db, directory } of files.splice(0)) {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
  restore();
});

describe('UPG actual backend HTTP evidence, independent of sticky gateway success', () => {
  it('detects candidate 500 while gateway A remains healthy, and each lane writes its own unique pair', async () => {
    const f = await fixture();
    f.candidate.mode = 'fail';
    await Promise.all([f.sample('gateway'), f.sample('source'), f.sample('candidate')]);
    expect(f.read('gateway')).toMatchObject({ known: true, failures: 0, requests: 1 });
    expect(f.read('source')).toMatchObject({ known: true, failures: 0, requests: 1 });
    expect(f.read('candidate')).toMatchObject({
      known: true,
      failures: 1,
      requests: 1,
      errorRate: 1,
    });
    expect(f.source.identities).toBe(2); // Legacy A: actual before and after identity.
    const pairs = [...f.source.requests, ...f.candidate.requests];
    expect(new Set(pairs.map((r) => r.requestId)).size).toBe(3);
    for (const id of new Set(pairs.map((r) => r.requestId)))
      expect(pairs.filter((r) => r.requestId === id)).toEqual([
        expect.objectContaining({ method: 'POST', operationId: id }),
        expect.objectContaining({ method: 'GET', operationId: id }),
      ]);
    expect(f.durable).toHaveLength(1); // Gateway only; no schema or fake natural-user samples.
  });
  it('rejects mismatched or partial own identity rather than borrowing source success', async () => {
    const f = await fixture();
    await f.sample('candidate');
    f.candidate.mode = 'mismatch';
    await f.sample('candidate');
    expect(f.read('candidate')).toMatchObject({
      known: false,
      requests: 0,
      errorRate: null,
      p95Ms: null,
    });
    f.candidate.mode = 'partial';
    await f.sample('candidate');
    expect(f.read('candidate').known).toBe(false);
    expect(f.candidate.identities).toBe(0); // Candidate headers are mandatory, no legacy fallback.
  });
  it('discards a legacy source pair when actual process identity changes between write/read', async () => {
    const f = await fixture();
    await f.sample('source');
    expect(f.read('source').known).toBe(true);
    f.source.rotateAfterWrite = true;
    await f.sample('source');
    expect(f.read('source')).toMatchObject({ known: false, requests: 0, failures: 0 });
    f.source.rotateAfterWrite = false;
    await f.sample('source');
    expect(f.read('source')).toMatchObject({ known: true, requests: 1, windowMs: 0 });
    expect(f.read('candidate').failures).toBe(0);
  });
  it('continues source baseline at nonzero weight and keeps source failures out of candidate/gateway hard SLO', async () => {
    const f = await fixture();
    f.source.mode = 'fail';
    await f.sample('source');
    await f.sample('candidate');
    expect(f.read('source').failures).toBe(1);
    expect(f.read('candidate').failures).toBe(0);
    expect(f.read('gateway').failures).toBe(0);
    expect(f.source.identities).toBe(2);
  });
  it('needs a full fresh window after Coordinator, route, or process changes and discards late old groups', async () => {
    const f = await fixture();
    for (let i = 0; i <= 120; i++) {
      await Promise.all([f.sample('source'), f.sample('gateway')]);
      clockOffset += 500;
    }
    f.change({ weight: 0 });
    await Promise.all([f.sample('source'), f.sample('gateway')]);
    const initial = await f.observer.observation('attempt', 7, 0);
    expect(initial.baseline).toMatchObject({ known: false, qualified: false, windowMs: 0 });
    for (let i = 0; i <= 120; i++) {
      await Promise.all([f.sample('source'), f.sample('gateway')]);
      clockOffset += 500;
    }
    expect((await f.observer.observation('attempt', 7, 0)).baseline).toMatchObject({
      known: true,
      qualified: true,
      source: {
        routeWeight: 0,
        weight: 0,
        coordinatorGeneration: 2,
        origin: f.source.origin,
        artifactDigest: sourceDigest,
      },
    });
    process.env.COORDINATOR_GENERATION = '3';
    f.writer.generation = 3; // A new actual writer epoch cannot borrow the old cohort.
    expect((await f.observer.observation('attempt', 7, 0)).baseline).toMatchObject({
      known: false,
      qualified: false,
    });
    await f.sample('source');
    expect(f.read('source').windowMs).toBe(0);
    f.source.start = randomUUID();
    await f.sample('source');
    expect(f.read('source').windowMs).toBe(0);
    f.change({ weight: 1 });
    f.candidate.waitMs = 100;
    const late = f.sample('candidate');
    await delay(20);
    f.change({ routeGeneration: 2 });
    await late;
    expect(f.read('candidate')).toMatchObject({ requests: 0, known: false });
  });
  it('keeps gateway scheduling independent while candidate HTTP takes 1100 ms', async () => {
    const f = await fixture();
    f.candidate.waitMs = 550;
    const slow = f.sample('candidate');
    for (let i = 0; i < 8; i++) {
      await f.sample('gateway');
      await delay(50);
    }
    expect(f.read('gateway').requests).toBe(8);
    expect(f.read('candidate').requests).toBe(0);
    await slow;
    expect(f.read('candidate')).toMatchObject({ known: true, requests: 1, failures: 0 });
  });
  it('reports actual candidate transport failure even without a completed verified pair', async () => {
    const f = await fixture();
    f.candidate.waitMs = 2200;
    await f.sample('candidate');
    expect(f.read('candidate')).toMatchObject({ known: false, requests: 0, failures: 1 });
  });
  it('keeps real HTTP pairs and the event loop running during an uncached large-file integrity worker', async () => {
    const f = await fixture();
    f.db.transaction(() => {
      const insert = f.db.prepare('INSERT INTO unrelated_history(payload) VALUES(zeroblob(?))');
      for (let i = 0; i < 128; i++) insert.run(1024 * 1024);
    })();
    const scan = vi.spyOn(integrity, 'verifyMigrationDatabaseIntegrity');
    let heartbeats = 0,
      completedPairs = 0,
      pending = false;
    const timer = setInterval(() => {
      heartbeats++;
      if (!pending) {
        pending = true;
        void f.sample('gateway').then(() => {
          completedPairs++;
          pending = false;
        });
      }
    }, 5);
    try {
      expect((await f.observer.observation('attempt', 7, 1)).sharedStateHealthy).toBe(true);
      expect(heartbeats).toBeGreaterThan(1);
      expect(completedPairs).toBeGreaterThan(0);
      expect(f.read('gateway').known).toBe(true);
      // Every observation starts its own actual worker; no previous pass is cached.
      await f.observer.observation('attempt', 7, 1);
      expect(scan).toHaveBeenCalledTimes(2);
    } finally {
      clearInterval(timer);
      while (pending) await delay(1);
    }
  });
  it.each([
    ['retired writer', (f: Awaited<ReturnType<typeof fixture>>) => f.retireWriter()],
    ['controller lease', (f: Awaited<ReturnType<typeof fixture>>) => f.expireController()],
    ['route', (f: Awaited<ReturnType<typeof fixture>>) => f.change({ routeGeneration: 2 })],
    ['weight', (f: Awaited<ReturnType<typeof fixture>>) => f.change({ weight: 25 })],
    [
      'API identity',
      (f: Awaited<ReturnType<typeof fixture>>) =>
        f.change({ oldApi: { origin: f.source.origin, digest: candidateDigest } }),
    ],
    [
      'writer epoch',
      (f: Awaited<ReturnType<typeof fixture>>) => {
        f.writer.generation++;
      },
    ],
    [
      'observer epoch',
      (f: Awaited<ReturnType<typeof fixture>>) => {
        Object.assign(f.evidence, { observerEpoch: randomUUID() });
      },
    ],
  ])(
    'rejects %s changed while the real worker was awaited before collecting mutable proofs',
    async (_name, change) => {
      const f = await fixture();
      const verify = integrity.verifyMigrationDatabaseIntegrity;
      let release = () => {},
        scanned = () => {};
      const scannedPromise = new Promise<void>((ok) => {
        scanned = ok;
      });
      const releasePromise = new Promise<void>((ok) => {
        release = ok;
      });
      vi.spyOn(integrity, 'verifyMigrationDatabaseIntegrity').mockImplementationOnce(async (db) => {
        await verify(db);
        scanned();
        await releasePromise;
      });
      const continuity = vi.spyOn(f.inspector, 'continuity');
      const observation = f.observer.observation('attempt', 7, 1);
      const rejection = expect(observation).rejects.toThrow();
      await scannedPromise;
      change(f);
      release();
      await rejection;
      expect(continuity).not.toHaveBeenCalled();
    },
  );
  it('refuses an expired integrity snapshot and stale mutable proof tails without relying on caller timeouts', async () => {
    const f = await fixture();
    const verify = integrity.verifyMigrationDatabaseIntegrity;
    vi.spyOn(integrity, 'verifyMigrationDatabaseIntegrity').mockImplementationOnce(async (db) => {
      await verify(db);
      clockOffset += 6000;
    });
    // A late worker must not give its old read snapshot a fresh wrapper timestamp.
    await expect(f.observer.observation('attempt', 7, 1)).rejects.toThrow('OBSERVATION_STALE');
    const web = f.inspector.webBuild;
    vi.spyOn(f.inspector, 'webBuild').mockImplementationOnce(async () => {
      clockOffset += 5001;
      return web();
    });
    await expect(f.observer.observation('attempt', 7, 1)).rejects.toThrow('OBSERVATION_STALE');
  });
  it.each([
    ['route', (f: Awaited<ReturnType<typeof fixture>>) => f.change({ routeGeneration: 2 })],
    ['writer', (f: Awaited<ReturnType<typeof fixture>>) => f.retireWriter()],
    ['controller', (f: Awaited<ReturnType<typeof fixture>>) => f.expireController()],
  ])('rejects %s changes during post-worker proof collection', async (_name, change) => {
    const f = await fixture();
    const web = f.inspector.webBuild;
    vi.spyOn(f.inspector, 'webBuild').mockImplementationOnce(async () => {
      change(f);
      return web();
    });
    await expect(f.observer.observation('attempt', 7, 1)).rejects.toThrow();
  });
  it('does not stamp a stale continuity result with a new wrapper observation time', async () => {
    const f = await fixture();
    const continuity = f.inspector.continuity;
    vi.spyOn(f.inspector, 'continuity').mockImplementation(async () => ({
      ...(await continuity()),
      observedAt: new Date(clock.now().getTime() - 5001).toISOString(),
    }));
    await expect(f.observer.observation('attempt', 7, 1)).rejects.toThrow('OBSERVATION_STALE');
  });
  it('fails closed on real foreign-key corruption in the independently opened database', async () => {
    const f = await fixture();
    f.db.pragma('foreign_keys=OFF');
    f.db.exec(
      'CREATE TABLE parent(id INTEGER PRIMARY KEY); CREATE TABLE child(parent_id INTEGER REFERENCES parent(id)); INSERT INTO child VALUES(1)',
    );
    const continuity = vi.spyOn(f.inspector, 'continuity');
    await expect(f.observer.observation('attempt', 7, 1)).rejects.toThrow(
      'GLOBAL_SCHEMA_INTEGRITY_FAILED',
    );
    expect(continuity).not.toHaveBeenCalled();
  });
});
