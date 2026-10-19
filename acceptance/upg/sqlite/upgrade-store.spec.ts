import { assertDefined } from '../../support/assert-defined';
import 'reflect-metadata';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ConfirmedServiceReleaseSchema,
  SignedUpgradeManifestSchema,
  UpgradeManifestSchema,
  UpgradeSourceActualSchema,
  type ConfirmedServiceRelease,
  type SignedUpgradeManifest,
  type UpgradePlan,
  type UpgradeRequest,
} from '@platform/contracts';
import { fromEpochMs, type Clock, type IdGenerator } from '@platform/shared-kernel';
import {
  createConnection,
  runMigrations,
  type Connection,
} from '../../../apps/api/src/platform/persistence/drizzle.connection';
import {
  UpgradeStore,
  type UpgradeCommit,
} from '../../../apps/api/src/platform/upgrade/upgrade-store';
import {
  canonicalUpgrade,
  freezeUpgradePlan,
  upgradeDigest,
} from '../../../apps/api/src/platform/upgrade/upgrade-trust';
import { useEnv } from '../../support/strict-ports';

// These receipts exercise the real persisted state machine, not the native
// runtime, installer or release qualification gates. No synthetic receipt is
// submitted through the production controller or represented as continuity proof.
const epoch = Date.parse('2026-10-12T02:00:00.000Z');
const key = generateKeyPairSync('ed25519');
const ids: IdGenerator = { next: () => randomUUID() };
let time: number;
const clock: Clock = { now: () => fromEpochMs(time) };
let connection: Connection;
let store: UpgradeStore;
let directory: string;
let filename: string;
let restoreEnv: () => void;

function artifact(label: string) {
  return {
    artifactDigest: upgradeDigest({ artifact: label }),
    inputFingerprint: upgradeDigest({ input: label }),
    sourceRevision: upgradeDigest({ revision: label }).slice(7, 47),
    protocol: { min: 1, max: 2 },
  };
}
function current(releaseId = '0.2.0', activationGeneration = 1): ConfirmedServiceRelease {
  const revision = artifact(releaseId).sourceRevision;
  return ConfirmedServiceReleaseSchema.parse({
    releaseId,
    activationGeneration,
    activatedAt: clock.now().toISOString(),
    schema: (
      connection.sqlite.prepare('SELECT count(*) AS n FROM __drizzle_migrations').get() as {
        n: number;
      }
    ).n,
    channel: 'sqlite-state-test',
    components: {
      api: artifact(`${releaseId}-api`),
      web: { ...artifact(`${releaseId}-web`), webRevision: revision },
      installer: artifact(`${releaseId}-installer`),
      coordinator: artifact(`${releaseId}-coordinator`),
      owner: artifact(`${releaseId}-owner`),
    },
    commits: { project: revision, api: revision, web: revision },
    productionWebBinding: `http://127.0.0.1/${releaseId}`,
  });
}
function target(source: ConfirmedServiceRelease, releaseId = '0.2.1', migration = false) {
  const components = current(releaseId).components;
  const manifest = UpgradeManifestSchema.parse({
    schemaVersion: 2,
    releaseId,
    channel: source.channel,
    publishedAt: clock.now().toISOString(),
    components,
    commits: current(releaseId).commits,
    packages: [
      {
        platform: process.platform,
        arch: process.arch,
        name: 'sqlite-state-layer-fixture',
        url: 'https://distribution.invalid/sqlite-state-layer-fixture.tar',
        digest: upgradeDigest({ package: releaseId }),
        bytes: 1000,
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
        migrationPlanDigest: migration ? upgradeDigest({ migration: releaseId }) : null,
      },
    ],
    policy: {
      id: 'sqlite-state-fixture',
      weights: [1, 5, 25, 100],
      stageDurationMs: 60_000,
      minRequests: 100,
      observationFreshnessMs: 5000,
      probeHz: 10,
      requestDeadlineMs: 2000,
      attachDeadlineMs: 5000,
      softErrorDelta: 0.01,
      p95Ratio: 2,
      p95FloorMs: 1000,
      evaluationIntervalMs: 10_000,
      consecutiveEvaluations: 2,
      retentionMs: 60_000,
      migrationBatchMs: 50,
      maxWalBytes: 1024 * 1024,
      minFreeBytes: 1024 * 1024,
      fallbacks: [
        {
          releaseId: source.releaseId,
          apiDigest: source.components.api.artifactDigest,
          webDigest: source.components.web.artifactDigest,
          rehearsed: false,
        },
      ],
      stopUserResources: false,
      restoreLiveVolume: false,
      contractInUpgrade: false,
    },
    // Deliberately no release gates: this is a state-layer fixture, not an
    // installable/trusted catalog release and not a native test result.
    evidence: [],
  });
  const envelope: SignedUpgradeManifest = SignedUpgradeManifestSchema.parse({
    manifest,
    manifestDigest: upgradeDigest(manifest),
    signature: {
      algorithm: 'Ed25519',
      keyId: 'state-test-only',
      value: sign(null, Buffer.from(canonicalUpgrade(manifest)), key.privateKey).toString('base64'),
    },
  });
  const plan = freezeUpgradePlan(envelope, source);
  const request: UpgradeRequest = {
    requestId: randomUUID(),
    targetReleaseId: releaseId,
    targetDigest: envelope.manifestDigest,
    expectedActivationGeneration: source.activationGeneration,
  };
  return { envelope, plan, request };
}
function accept(migration = false) {
  const source = assertDefined(store.confirmed());
  const fixture = target(source, '0.2.1', migration);
  const attempt = store.accept('actor-a', fixture.request, fixture.envelope, fixture.plan);
  store.claim(attempt.attemptId, 'controller-a', 30_000);
  return { ...fixture, id: attempt.attemptId };
}
function command(
  id: string,
  kind: UpgradeCommit['kind'],
  payload: Record<string, unknown>,
): UpgradeCommit {
  const snapshot = store.snapshot(id);
  return {
    fence: snapshot.fence,
    generation: snapshot.attempt.generation,
    expectedSequence: snapshot.attempt.sequence,
    eventId: randomUUID(),
    kind,
    payload,
  };
}
function apply(id: string, step: UpgradePlan['steps'][number], unknownWork = 7) {
  const completedWork = step.totalWork ?? unknownWork;
  const evidence = {
    scope: 'sqlite-state-layer-only',
    stepId: step.stepId,
    completedWork,
    ...(step.kind === 'migration'
      ? { commitKnown: true, complete: true, integrityValid: true, budgetExceeded: false }
      : {}),
  };
  return store.commit(
    id,
    command(id, 'step-applied', {
      stepId: step.stepId,
      completedWork,
      evidence,
      receiptDigest: upgradeDigest(evidence),
    }),
  );
}
function applyAll(id: string) {
  for (const step of store.plan(id).steps) apply(id, step);
}
function activate(id: string) {
  applyAll(id);
  const plan = store.plan(id);
  const activation = {
    ...current(plan.releaseId, store.instance().activation_generation + 1),
    schema: plan.migrationPath.targetSchema,
  };
  store.commit(id, command(id, 'activation-confirmed', {}), activation);
  return activation;
}
function recoveryPlan(id: string) {
  const plan = {
    schemaVersion: 1,
    triggeringAttemptId: id,
    eligibilityDigest: upgradeDigest({ scope: 'sqlite-state-layer-only', eligibility: true }),
    api: null,
    web: null,
    coordinator: null,
    owner: null,
    componentScope: [],
    faultDigest: upgradeDigest({ scope: 'sqlite-state-layer-only', fault: true }),
  };
  return { ...plan, planDigest: upgradeDigest(plan) };
}

function events() {
  return (
    connection.sqlite.prepare('SELECT count(*) AS n FROM upgrade_events').get() as { n: number }
  ).n;
}

it('keeps known download progress and immutable stage clocks when later migration total is unknown and heartbeat repeats work', () => {
  const { id } = accept(true);
  store.commit(id, command(id, 'progress', { stepId: 'package-download', completedWork: 250 }));
  const first = assertDefined(store.stageProgress(id));
  expect(store.attempt(id).percent).toBeNull();
  expect(first).toMatchObject({
    stage: 'package-download',
    completedWork: 250,
    totalWork: 1000,
    percent: 25,
    enteredAt: clock.now().toISOString(),
    lastProgressAt: clock.now().toISOString(),
  });
  time += 1000;
  store.commit(id, command(id, 'progress', { stepId: 'package-download', completedWork: 250 }));
  expect(store.stageProgress(id)).toEqual(first);
  time += 1000;
  store.commit(id, command(id, 'progress', { stepId: 'package-download', completedWork: 500 }));
  expect(store.stageProgress(id)).toMatchObject({
    completedWork: 500,
    percent: 50,
    enteredAt: first.enteredAt,
    lastProgressAt: clock.now().toISOString(),
  });
  const queries = vi.spyOn(connection.sqlite, 'prepare');
  store.stageProgress(id);
  expect(queries.mock.calls.some(([sql]) => sql.includes('upgrade_events'))).toBe(false);
  queries.mockRestore();
});

beforeEach(() => {
  time = epoch;
  directory = mkdtempSync(join(tmpdir(), 'upg-store-sqlite-'));
  filename = join(directory, 'platform.db');
  restoreEnv = useEnv({ PLATFORM_INSTANCE_ID: 'upgrade-sqlite-test-instance' });
  connection = createConnection(filename);
  runMigrations(connection.db, connection.sqlite);
  store = new UpgradeStore(connection.sqlite, clock, ids);
  store.bootstrap(current());
});
afterEach(() => {
  connection.sqlite.close();
  restoreEnv();
  rmSync(directory, { recursive: true, force: true });
});

describe('REQ-UPG-001/006/007/008 — actual SQLite upgrade intent, fencing and recovery', () => {
  it('advertises reference heartbeats and preserves the full durable receipt without rewriting evidence', () => {
    const { id } = accept();
    expect(store.snapshot(id).controllerCapabilities).toEqual({
      progressEvidenceReference: 1,
      controlFastPath: 1,
    });
    const evidence = { scope: 'sqlite-state-layer-only', proof: 'x'.repeat(1024 * 1024) };
    const material = command(id, 'step-applied', {
      stepId: 'package-download',
      completedWork: 1000,
      evidence,
      receiptDigest: upgradeDigest(evidence),
    });
    store.commit(id, material);
    const durable = () =>
      connection.sqlite
        .prepare('SELECT * FROM upgrade_steps WHERE attempt_id=? AND step_id=?')
        .get(id, 'package-download');
    const before = durable();
    const timing = store.stageProgress(id);
    const initial = store.snapshot(id).attempt;
    // SQLite itself rejects any evidence UPDATE, including one with identical bytes.
    connection.sqlite.exec(
      "CREATE TRIGGER reject_evidence_rewrite BEFORE UPDATE OF evidence ON upgrade_steps BEGIN SELECT RAISE(ABORT, 'EVIDENCE_REWRITTEN'); END",
    );
    for (let i = 0; i < 8; i++) {
      time += 1000;
      const heartbeat = command(id, 'progress', {
        stepId: 'package-download',
        completedWork: 1000,
        totalWork: 1000,
        stage: 'downloading',
        evidenceDigest: upgradeDigest(evidence),
      });
      store.commit(id, heartbeat);
      expect(store.commit(id, heartbeat).attempt.sequence).toBe(initial.sequence + i + 1);
    }
    expect(durable()).toEqual(before);
    expect(store.stageProgress(id)).toEqual(timing);
    expect(store.snapshot(id).attempt).toMatchObject({
      state: initial.state,
      stage: initial.stage,
      sequence: initial.sequence + 8,
      observedAt: clock.now().toISOString(),
    });
    const materialEvent = connection.sqlite
      .prepare<unknown[], { payload: string }>(
        'SELECT payload FROM upgrade_events WHERE event_id=?',
      )
      .get(material.eventId);
    expect(JSON.parse(assertDefined(materialEvent).payload)).toEqual(material.payload);
    const heartbeats = connection.sqlite
      .prepare<unknown[], { payload: string }>(
        "SELECT payload FROM upgrade_events WHERE attempt_id=? AND kind='progress'",
      )
      .all(id);
    expect(heartbeats).toHaveLength(8);
    for (const event of heartbeats) {
      expect(Buffer.byteLength(event.payload)).toBeLessThan(512);
      expect(JSON.parse(event.payload)).toEqual({
        stepId: 'package-download',
        completedWork: 1000,
        totalWork: 1000,
        stage: 'downloading',
        evidenceDigest: upgradeDigest(evidence),
      });
    }
  });
  it('accepts a reference only to the current partial checkpoint while retaining full material progress', () => {
    const { id } = accept();
    const first = { scope: 'sqlite-state-layer-only', received: 250 };
    const second = { scope: 'sqlite-state-layer-only', received: 500 };
    store.commit(
      id,
      command(id, 'progress', { stepId: 'package-download', completedWork: 250, evidence: first }),
    );
    time += 1000;
    const reference = command(id, 'progress', {
      stepId: 'package-download',
      completedWork: 250,
      evidenceDigest: upgradeDigest(first),
    });
    store.commit(id, reference);
    const referenceEvent = connection.sqlite
      .prepare<unknown[], { event_digest: string; payload: string }>(
        'SELECT event_digest,payload FROM upgrade_events WHERE event_id=?',
      )
      .get(reference.eventId);
    expect(assertDefined(referenceEvent)).toEqual({
      event_digest: upgradeDigest(reference),
      payload: JSON.stringify(reference.payload),
    });
    const beforeRepeat = store.snapshot(id);
    const beforeRepeatEvents = events();
    expect(store.commit(id, reference)).toEqual(beforeRepeat);
    expect(events()).toBe(beforeRepeatEvents);
    expect(() =>
      store.commit(id, { ...reference, payload: { ...reference.payload, totalWork: 1000 } }),
    ).toThrow('UPGRADE_EVENT_PAYLOAD_CONFLICT');
    expect(store.step(id, 'package-download')).toMatchObject({
      applied: false,
      completedWork: 250,
      receiptDigest: null,
      evidence: first,
    });
    time += 1000;
    store.commit(
      id,
      command(id, 'progress', { stepId: 'package-download', completedWork: 500, evidence: second }),
    );
    expect(store.step(id, 'package-download')).toMatchObject({
      applied: false,
      completedWork: 500,
      evidence: second,
    });
    expect(() =>
      store.commit(
        id,
        command(id, 'progress', {
          stepId: 'package-download',
          completedWork: 500,
          evidenceDigest: upgradeDigest(first),
        }),
      ),
    ).toThrow('UPGRADE_PROGRESS_REFERENCE_INVALID');
    store.commit(id, command(id, 'progress', { stepId: 'package-download', completedWork: 500 }));
    const timing = store.stageProgress(id);
    time += 1000;
    store.commit(
      id,
      command(id, 'progress', {
        stepId: 'package-download',
        completedWork: 500,
        evidenceDigest: upgradeDigest(null),
      }),
    );
    expect(store.step(id, 'package-download')).toMatchObject({
      applied: false,
      completedWork: 500,
      evidence: null,
    });
    expect(store.stageProgress(id)).toEqual(timing);
  });
  it.each([
    ['digest', { evidenceDigest: 'sha256:' + '0'.repeat(64) }],
    ['work', { completedWork: 251 }],
    ['total', { totalWork: 999 }],
    ['stage', { stage: 'observing' }],
    ['inline evidence', { evidence: null }],
    ['extra proof', { otherProof: 'x'.repeat(1024) }],
  ])('rejects a tampered %s reference atomically', (_kind, patch) => {
    const { id } = accept();
    const evidence = { scope: 'sqlite-state-layer-only', received: 250 };
    store.commit(
      id,
      command(id, 'progress', { stepId: 'package-download', completedWork: 250, evidence }),
    );
    const before = store.snapshot(id);
    const beforeEvents = events();
    const beforeTiming = store.stageProgress(id);
    time += 1000;
    expect(() =>
      store.commit(
        id,
        command(id, 'progress', {
          stepId: 'package-download',
          completedWork: 250,
          evidenceDigest: upgradeDigest(evidence),
          ...patch,
        }),
      ),
    ).toThrow('UPGRADE_PROGRESS_REFERENCE_INVALID');
    expect(store.snapshot(id)).toEqual(before);
    expect(events()).toBe(beforeEvents);
    expect(store.stageProgress(id)).toEqual(beforeTiming);
  });
  it('rejects reference-only completion and references to a different durable stage', () => {
    const { id, plan } = accept();
    const first = assertDefined(plan.steps[0]);
    apply(id, first);
    const previous = store.step(id, first.stepId);
    expect(() =>
      store.commit(
        id,
        command(id, 'step-applied', {
          stepId: first.stepId,
          completedWork: previous.completedWork,
          evidenceDigest: upgradeDigest(previous.evidence),
        }),
      ),
    ).toThrow('UPGRADE_PROGRESS_REFERENCE_INVALID');
    apply(id, assertDefined(plan.steps[1]));
    const before = store.snapshot(id);
    expect(() =>
      store.commit(
        id,
        command(id, 'progress', {
          stepId: first.stepId,
          completedWork: previous.completedWork,
          evidenceDigest: upgradeDigest(previous.evidence),
        }),
      ),
    ).toThrow('UPGRADE_PROGRESS_REFERENCE_INVALID');
    expect(store.snapshot(id)).toEqual(before);
  });
  it('rejects an unqualified global migration version without reserving an attempt or changing the actual journal', () => {
    const source = assertDefined(store.confirmed());
    const fixture = target(source, '0.2.1', true);
    const manifest = UpgradeManifestSchema.parse({
      ...fixture.envelope.manifest,
      upgradePaths: fixture.envelope.manifest.upgradePaths.map((path) => ({
        ...path,
        targetSchema: source.schema + 1,
      })),
    });
    const envelope = {
      ...fixture.envelope,
      manifest,
      manifestDigest: upgradeDigest(manifest),
      signature: {
        ...fixture.envelope.signature,
        value: sign(null, Buffer.from(canonicalUpgrade(manifest)), key.privateKey).toString(
          'base64',
        ),
      },
    };
    const before = connection.sqlite.prepare('SELECT * FROM __drizzle_migrations').all();
    expect(() => freezeUpgradePlan(envelope, source)).toThrow(
      'GLOBAL_SCHEMA_MIGRATION_UNQUALIFIED',
    );
    expect(store.latest()).toBeNull();
    expect(store.confirmed()).toEqual(source);
    expect(connection.sqlite.prepare('SELECT * FROM __drizzle_migrations').all()).toEqual(before);
  });
  it('freezes a separately measured partial tuple for a new explicit repair intent, preserving the last complete release and reusing only the actual Owner/Installer', () => {
    const original = assertDefined(store.confirmed());
    const first = accept();
    for (const step of first.plan.steps) {
      apply(first.id, step);
      if (step.kind === 'owner-candidate') break;
    }
    store.commit(
      first.id,
      command(first.id, 'deferred', { reason: 'state-fixture partial installation' }),
    );
    const facts = {
      schemaVersion: 1,
      qualified: true,
      partial: true,
      instanceId: store.instanceId,
      baseConfirmedReleaseId: original.releaseId,
      activationGeneration: store.instance().activation_generation,
      schema: original.schema,
      components: {
        ...original.components,
        owner: first.envelope.manifest.components.owner,
        installer: first.envelope.manifest.components.installer,
      },
      observedAt: clock.now().toISOString(),
    };
    const actual = UpgradeSourceActualSchema.parse({ ...facts, proofDigest: upgradeDigest(facts) });
    const plan = freezeUpgradePlan(first.envelope, {
      ...original,
      schema: actual.schema,
      components: actual.components,
    });
    const request = {
      ...first.request,
      requestId: randomUUID(),
      expectedActivationGeneration: actual.activationGeneration,
    };
    const accepted = store.accept(
      'explicit-repair-actor',
      request,
      first.envelope,
      plan,
      undefined,
      undefined,
      actual,
    );
    expect(accepted.attemptId).not.toBe(first.id);
    expect(accepted.generation).toBeGreaterThan(store.attempt(first.id).generation);
    expect(store.confirmed()).toEqual(original);
    expect(store.instance().service_state).not.toBe('confirmed');
    expect(store.snapshot(accepted.attemptId).sourceActual).toEqual(actual);
    expect(store.snapshot(accepted.attemptId).sourceActivation).toEqual(original);
    expect(store.latestProbeSnapshot()).toMatchObject({
      attempt: { attemptId: accepted.attemptId },
      sourceActual: actual,
      sourceActivation: original,
    });
    expect(store.plan(accepted.attemptId)).toMatchObject({
      ownerReused: true,
      installerReused: true,
      sourceOwnerDigest: actual.components.owner?.artifactDigest,
      sourceInstallerDigest: actual.components.installer.artifactDigest,
    });
    expect(
      store
        .plan(accepted.attemptId)
        .steps.some((step) => step.kind === 'owner-candidate' || step.kind === 'installer-handoff'),
    ).toBe(false);
    expect(
      store.accept(
        'explicit-repair-actor',
        request,
        first.envelope,
        plan,
        undefined,
        undefined,
        actual,
      ).attemptId,
    ).toBe(accepted.attemptId);
  });
  it.each(['proof', 'base', 'generation', 'stale'] as const)(
    'rejects a partial source with %s mismatch before admitting another instance attempt',
    (kind) => {
      const original = assertDefined(store.confirmed());
      const first = accept();
      store.commit(first.id, command(first.id, 'deferred', { reason: 'state-fixture deferred' }));
      connection.sqlite
        .prepare("UPDATE upgrade_instances SET service_state='unknown' WHERE instance_id=?")
        .run(store.instanceId);
      const facts = {
        schemaVersion: 1,
        qualified: true,
        partial: true,
        instanceId: store.instanceId,
        baseConfirmedReleaseId: original.releaseId,
        activationGeneration: store.instance().activation_generation,
        schema: original.schema,
        components: original.components,
        observedAt: clock.now().toISOString(),
      };
      if (kind === 'base') facts.baseConfirmedReleaseId = '9.9.9';
      if (kind === 'generation') facts.activationGeneration++;
      if (kind === 'stale') facts.observedAt = fromEpochMs(time - 5001).toISOString();
      const actual = UpgradeSourceActualSchema.parse({
        ...facts,
        proofDigest: kind === 'proof' ? upgradeDigest({ tampered: true }) : upgradeDigest(facts),
      });
      expect(() =>
        store.accept(
          'explicit-repair-actor',
          { ...first.request, requestId: randomUUID() },
          first.envelope,
          first.plan,
          undefined,
          undefined,
          actual,
        ),
      ).toThrow('REPAIR_SOURCE_UNCONFIRMED');
      expect(connection.sqlite.prepare('SELECT count(*) n FROM upgrade_attempts').get()).toEqual({
        n: 1,
      });
      expect(store.confirmed()).toEqual(original);
    },
  );
  it('commits one accepted intent across lost acknowledgement, reopen and two-actor concurrent admission', async () => {
    const fixture = target(assertDefined(store.confirmed()));
    const accepted = store.accept('actor-a', fixture.request, fixture.envelope, fixture.plan);
    connection.sqlite.close();
    connection = createConnection(filename);
    runMigrations(connection.db, connection.sqlite);
    store = new UpgradeStore(connection.sqlite, clock, ids);
    const results = await Promise.allSettled([
      Promise.resolve().then(() =>
        store.accept('actor-a', fixture.request, fixture.envelope, fixture.plan),
      ),
      Promise.resolve().then(() =>
        store.accept(
          'actor-b',
          { ...fixture.request, requestId: randomUUID() },
          fixture.envelope,
          fixture.plan,
        ),
      ),
    ]);
    expect(results[0]).toMatchObject({
      status: 'fulfilled',
      value: { attemptId: accepted.attemptId },
    });
    expect(results[1]).toMatchObject({
      status: 'rejected',
      reason: { code: 'UPGRADE_ALREADY_ACTIVE' },
    });
    expect(store.lookup('actor-a', fixture.request.requestId)).toEqual(accepted);
    expect(() => store.lookup('actor-b', fixture.request.requestId)).toThrow(
      'UPGRADE_REQUEST_NOT_FOUND',
    );
    expect(connection.sqlite.prepare('SELECT count(*) AS n FROM upgrade_attempts').get()).toEqual({
      n: 1,
    });
    expect(connection.sqlite.prepare('SELECT count(*) AS n FROM upgrade_steps').get()).toEqual({
      n: fixture.plan.steps.length,
    });
    expect(events()).toBe(0);
  });

  it('rejects changed payload for a retained request identity and stale activation/target without mutations', () => {
    const fixture = accept();
    const before = store.pending();
    const changed = { ...fixture.request, expectedActivationGeneration: 0 };
    expect(() => store.accept('actor-a', changed, fixture.envelope, fixture.plan)).toThrow(
      'UPGRADE_REQUEST_PAYLOAD_CONFLICT',
    );
    expect(() => store.replay('actor-a', changed)).toThrow('UPGRADE_REQUEST_PAYLOAD_CONFLICT');
    expect(() =>
      store.accept(
        'actor-b',
        { ...changed, requestId: randomUUID() },
        fixture.envelope,
        fixture.plan,
      ),
    ).toThrow('UPGRADE_ACTIVATION_CONFLICT');
    expect(() =>
      store.accept(
        'actor-b',
        {
          ...fixture.request,
          requestId: randomUUID(),
          targetDigest: upgradeDigest({ changed: true }),
        },
        fixture.envelope,
        fixture.plan,
      ),
    ).toThrow('UPGRADE_TARGET_CHANGED');
    expect(store.pending()).toEqual(before);
    expect(store.replay('actor-a', fixture.request)?.attemptId).toBe(fixture.id);
  });

  it('read-only lookup and snapshots do not claim authority, write receipts or advance leases/work', () => {
    const fixture = accept();
    const before = store.snapshot(fixture.id);
    time += 100;
    store.lookup('actor-a', fixture.request.requestId);
    store.plan(fixture.id);
    store.pending();
    store.recovery();
    store.renew(fixture.id, before.fence, null, true);
    expect(store.snapshot(fixture.id)).toEqual(before);
    expect(events()).toBe(0);
  });

  it('uses a higher instance-wide fence after controller loss and rejects stale writes/CAS', () => {
    const { id, plan } = accept();
    const old = command(id, 'progress', { stepId: plan.steps[0].stepId, completedWork: 1 });
    expect(() => store.claim(id, 'controller-b', 30_000)).toThrow('UPGRADE_CONTROLLER_BUSY');
    time += 30_001;
    const next = store.claim(id, 'controller-b', 30_000);
    expect(next.fence).toBeGreaterThan(old.fence);
    expect(() => store.commit(id, old)).toThrow('UPGRADE_FENCE_EXPIRED');
    const live = command(id, 'progress', { stepId: plan.steps[0].stepId, completedWork: 2 });
    store.commit(id, live);
    expect(() => store.commit(id, { ...live, eventId: randomUUID() })).toThrow(
      'UPGRADE_SEQUENCE_CONFLICT',
    );
    expect(store.attempt(id).completedWork).toBe(2);
    expect(events()).toBe(1);
  });

  it('canonically binds idempotent event receipts, preserves immutable ledger and rejects conflicting retries', () => {
    const { id, plan } = accept();
    const evidence = { z: { b: 2, a: 1 }, a: ['state-layer-only'] };
    const commit = command(id, 'step-applied', {
      stepId: plan.steps[0].stepId,
      completedWork: plan.steps[0].totalWork,
      evidence,
      receiptDigest: upgradeDigest(evidence),
    });
    store.commit(id, commit);
    const after = store.snapshot(id);
    const reordered = {
      ...commit,
      payload: {
        receiptDigest: commit.payload.receiptDigest,
        evidence: { a: ['state-layer-only'], z: { a: 1, b: 2 } },
        completedWork: commit.payload.completedWork,
        stepId: commit.payload.stepId,
      },
    };
    expect(store.commit(id, reordered)).toEqual(after);
    expect(events()).toBe(1);
    expect(() =>
      store.commit(id, { ...commit, payload: { ...commit.payload, completedWork: 1 } }),
    ).toThrow('UPGRADE_EVENT_PAYLOAD_CONFLICT');
    expect(() =>
      connection.sqlite
        .prepare('UPDATE upgrade_events SET kind=? WHERE event_id=?')
        .run('failed', commit.eventId),
    ).toThrow('upgrade events are immutable');
    expect(() =>
      connection.sqlite.prepare('DELETE FROM upgrade_events WHERE event_id=?').run(commit.eventId),
    ).toThrow('upgrade events are immutable');
    expect(store.snapshot(id)).toEqual(after);
  });

  it('rejects receipt mismatch, unsatisfied step dependency, partial applied work and work regression atomically', () => {
    const { id, plan } = accept();
    const first = plan.steps[0];
    expect(() => apply(id, plan.steps[1])).toThrow('UPGRADE_STEP_DEPENDENCY');
    expect(() =>
      store.commit(
        id,
        command(id, 'step-applied', {
          stepId: first.stepId,
          completedWork: first.totalWork,
          evidence: { actual: 'A' },
          receiptDigest: upgradeDigest({ actual: 'B' }),
        }),
      ),
    ).toThrow('UPGRADE_RECEIPT_INVALID');
    expect(() =>
      store.commit(
        id,
        command(id, 'step-applied', {
          stepId: first.stepId,
          completedWork: 1,
          evidence: null,
          receiptDigest: upgradeDigest(null),
        }),
      ),
    ).toThrow('UPGRADE_RECEIPT_INVALID');
    expect(events()).toBe(0);
    expect(store.step(id, first.stepId)).toMatchObject({ applied: false, completedWork: 0 });
    store.commit(id, command(id, 'progress', { stepId: first.stepId, completedWork: 50 }));
    expect(() =>
      store.commit(id, command(id, 'progress', { stepId: first.stepId, completedWork: 49 })),
    ).toThrow('UPGRADE_WORK_CONFLICT');
    expect(() =>
      store.commit(id, command(id, 'progress', { stepId: first.stepId, completedWork: 1001 })),
    ).toThrow('UPGRADE_WORK_CONFLICT');
    expect(store.step(id, first.stepId).completedWork).toBe(50);
    expect(events()).toBe(1);
  });

  it('keeps unknown migration totalWork frozen, counts only observed work and cannot claim 100 before activation', () => {
    const { id, plan } = accept(true);
    const frozen = canonicalUpgrade(plan);
    const knownTotal = plan.steps.reduce((sum, step) => sum + (step.totalWork ?? 0), 0);
    const migration = assertDefined(plan.steps.find((s) => s.kind === 'migration'));
    expect(store.attempt(id)).toMatchObject({ totalWork: null, percent: null, completedWork: 0 });
    for (const step of plan.steps.slice(0, plan.steps.indexOf(migration))) apply(id, step);
    store.commit(id, command(id, 'progress', { stepId: migration.stepId, completedWork: 3 }));
    expect(store.attempt(id)).toMatchObject({ totalWork: null, percent: null });
    time += 100;
    expect(store.attempt(id).percent).toBeNull();
    apply(id, migration, 7);
    expect(store.attempt(id).totalWork).toBe(knownTotal + 7);
    expect(store.attempt(id).percent).toBeLessThan(100);
    for (const step of plan.steps.slice(plan.steps.indexOf(migration) + 1)) apply(id, step);
    expect(store.attempt(id)).toMatchObject({
      totalWork: knownTotal + 7,
      percent: 99,
      state: 'api-activated',
    });
    expect(canonicalUpgrade(store.plan(id))).toBe(frozen);
    const activated = { ...current(plan.releaseId, 2), schema: plan.migrationPath.targetSchema };
    store.commit(id, command(id, 'activation-confirmed', {}), activated);
    expect(store.attempt(id)).toMatchObject({
      totalWork: knownTotal + 7,
      percent: 100,
      state: 'activation-confirmed',
    });
  });

  it.each([9, 0])(
    'uses only the completed migration receipt to resolve its actual %i units without rewriting the fixed plan or receipts',
    (completed) => {
      const { id, plan } = accept(true);
      const migration = assertDefined(plan.steps.find((step) => step.kind === 'migration'));
      const before = canonicalUpgrade(store.plan(id));
      const storedPlan = (
        connection.sqlite
          .prepare('SELECT plan FROM upgrade_attempts WHERE attempt_id=?')
          .get(id) as {
          plan: string;
        }
      ).plan;
      for (const step of plan.steps.slice(0, plan.steps.indexOf(migration))) apply(id, step);
      expect(store.attempt(id).totalWork).toBeNull();
      apply(id, migration, completed);
      const receipt = connection.sqlite
        .prepare('SELECT * FROM upgrade_steps WHERE attempt_id=? AND step_id=?')
        .get(id, migration.stepId);
      const eventCount = events();
      const snapshot = store.attempt(id);
      expect(snapshot.totalWork).toBe(
        plan.steps.reduce((sum, step) => sum + (step.totalWork ?? 0), 0) + completed,
      );
      expect(snapshot.completedWork).toBe(
        plan.steps
          .slice(0, plan.steps.indexOf(migration))
          .reduce((sum, step) => sum + (step.totalWork ?? 0), 0) + completed,
      );
      expect(snapshot.percent).toBe(
        Math.floor((100 * (plan.steps.indexOf(migration) + 1)) / plan.steps.length),
      );
      expect(snapshot.percent).toBeLessThan(100);
      expect(
        store.plan(id).steps.find((step) => step.stepId === migration.stepId)?.totalWork,
      ).toBeNull();
      expect(canonicalUpgrade(store.plan(id))).toBe(before);
      expect(
        connection.sqlite.prepare('SELECT plan FROM upgrade_attempts WHERE attempt_id=?').get(id),
      ).toEqual({ plan: storedPlan });
      expect(
        connection.sqlite
          .prepare('SELECT * FROM upgrade_steps WHERE attempt_id=? AND step_id=?')
          .get(id, migration.stepId),
      ).toEqual(receipt);
      expect(events()).toBe(eventCount);
    },
  );

  it('keeps incomplete unknown work unresolved despite progress and elapsed time, and rejects invalid or regressing work', () => {
    const { id, plan } = accept(true);
    const migration = assertDefined(plan.steps.find((step) => step.kind === 'migration'));
    for (const step of plan.steps.slice(0, plan.steps.indexOf(migration))) apply(id, step);
    store.commit(id, command(id, 'progress', { stepId: migration.stepId, completedWork: 3 }));
    expect(store.attempt(id)).toMatchObject({ totalWork: null, percent: null });
    time += 5000;
    store.renew(id, store.snapshot(id).fence, 'controller-a');
    expect(store.attempt(id)).toMatchObject({ totalWork: null, percent: null });
    const before = store.step(id, migration.stepId);
    const eventCount = events();
    for (const completedWork of [2, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        store.commit(id, command(id, 'progress', { stepId: migration.stepId, completedWork })),
      ).toThrow();
    }
    expect(store.step(id, migration.stepId)).toEqual(before);
    expect(events()).toBe(eventCount);
  });

  it.each([
    'unapplied',
    'missing-digest',
    'missing-evidence',
    'missing-applied-time',
    'malformed-evidence',
    'digest-mismatch',
    'work-mismatch',
    'incomplete',
    'unknown-commit',
    'invalid-integrity',
    'over-budget',
  ])('does not turn %s migration metadata into a known total', (fault) => {
    const { id, plan } = accept(true);
    const migration = assertDefined(plan.steps.find((step) => step.kind === 'migration'));
    for (const step of plan.steps.slice(0, plan.steps.indexOf(migration))) apply(id, step);
    apply(id, migration, 9);
    const row = connection.sqlite
      .prepare('SELECT evidence FROM upgrade_steps WHERE attempt_id=? AND step_id=?')
      .get(id, migration.stepId) as { evidence: string };
    const evidence = JSON.parse(row.evidence) as Record<string, unknown>;
    if (fault === 'unapplied')
      connection.sqlite
        .prepare('UPDATE upgrade_steps SET applied=0 WHERE attempt_id=? AND step_id=?')
        .run(id, migration.stepId);
    else if (
      fault === 'missing-digest' ||
      fault === 'missing-evidence' ||
      fault === 'missing-applied-time'
    ) {
      const column = {
        'missing-digest': 'receipt_digest',
        'missing-evidence': 'evidence',
        'missing-applied-time': 'applied_at',
      }[fault];
      connection.sqlite
        .prepare(`UPDATE upgrade_steps SET ${column}=NULL WHERE attempt_id=? AND step_id=?`)
        .run(id, migration.stepId);
    } else if (fault === 'malformed-evidence')
      connection.sqlite
        .prepare('UPDATE upgrade_steps SET evidence=? WHERE attempt_id=? AND step_id=?')
        .run('{', id, migration.stepId);
    else if (fault === 'digest-mismatch')
      connection.sqlite
        .prepare('UPDATE upgrade_steps SET receipt_digest=? WHERE attempt_id=? AND step_id=?')
        .run(upgradeDigest({ mismatched: true }), id, migration.stepId);
    else {
      if (fault === 'work-mismatch') evidence.completedWork = 10;
      if (fault === 'incomplete') evidence.complete = false;
      if (fault === 'unknown-commit') evidence.commitKnown = false;
      if (fault === 'invalid-integrity') evidence.integrityValid = false;
      if (fault === 'over-budget') evidence.budgetExceeded = true;
      connection.sqlite
        .prepare(
          'UPDATE upgrade_steps SET evidence=?,receipt_digest=? WHERE attempt_id=? AND step_id=?',
        )
        .run(JSON.stringify(evidence), upgradeDigest(evidence), id, migration.stepId);
    }
    const original = canonicalUpgrade(store.plan(id));
    const count = events();
    expect(store.attempt(id)).toMatchObject({ totalWork: null, percent: null });
    expect(canonicalUpgrade(store.plan(id))).toBe(original);
    expect(events()).toBe(count);
  });

  it('rejects activation without all receipts or target/generation identity and retains original service', () => {
    const { id } = accept();
    const original = store.confirmed();
    expect(() =>
      store.commit(id, command(id, 'activation-confirmed', {}), current('0.2.1', 2)),
    ).toThrow('OVERALL_ACTIVATION_UNCONFIRMED');
    applyAll(id);
    expect(() =>
      store.commit(id, command(id, 'activation-confirmed', {}), current('0.2.2', 2)),
    ).toThrow('ACTIVATION_IDENTITY_CONFLICT');
    expect(() =>
      store.commit(id, command(id, 'activation-confirmed', {}), current('0.2.1', 1)),
    ).toThrow('ACTIVATION_IDENTITY_CONFLICT');
    expect(store.confirmed()).toEqual(original);
    expect(store.attempt(id).percent).toBe(99);
  });

  it('preserves historical success/100 after ready revocation and uses independently fenced recovery', () => {
    const { id } = accept();
    activate(id);
    store.commit(id, command(id, 'ready-revoked', { reason: 'post-activation observation lost' }));
    expect(store.attempt(id)).toMatchObject({ state: 'activation-confirmed', percent: 100 });
    expect(store.instance().ready).toBe(0);
    const before = store.snapshot(id);
    const recoveryAttemptId = randomUUID();
    const frozenRecovery = recoveryPlan(id);
    store.commit(
      id,
      command(id, 'recovery-started', {
        reason: 'explicit recovery test',
        recoveryAttemptId,
        recoveryPlan: frozenRecovery,
      }),
    );
    const recovery = assertDefined(store.recovery());
    expect(recovery).toMatchObject({
      recoveryAttemptId,
      triggeringAttemptId: id,
      generation: before.attempt.generation + 1,
      sequence: 0,
      state: 'recovering',
      planDigest: frozenRecovery.planDigest,
    });
    expect(recovery).not.toHaveProperty('percent');
    expect(store.snapshot(id).fence).toBeGreaterThan(before.fence);
    expect(() =>
      store.commit(id, {
        ...command(id, 'ready-revoked', { reason: 'late old controller' }),
        fence: before.fence,
        generation: before.attempt.generation,
      }),
    ).toThrow('UPGRADE_FENCE_EXPIRED');
    // Actual migrated/newly written data is not restored from an older snapshot.
    connection.sqlite
      .prepare(
        'CREATE TABLE state_test_user_data (id TEXT PRIMARY KEY, revision INTEGER, value TEXT)',
      )
      .run();
    connection.sqlite
      .prepare('INSERT INTO state_test_user_data VALUES (?,?,?)')
      .run('new-user-data', 2, 'after activation');
    const fallback = current('0.2.0', 3);
    store.commit(id, command(id, 'recovery-confirmed', {}), fallback);
    expect(store.recovery()).toMatchObject({ state: 'recovery-confirmed', sequence: 1 });
    expect(store.attempt(id)).toMatchObject({ state: 'activation-confirmed', percent: 100 });
    expect(store.confirmed()).toEqual(fallback);
    expect(store.instance()).toMatchObject({
      activation_generation: 3,
      ready: 0,
      service_state: 'confirmed',
    });
    expect(connection.sqlite.prepare('SELECT * FROM state_test_user_data').all()).toEqual([
      { id: 'new-user-data', revision: 2, value: 'after activation' },
    ]);
  });

  it('a Web-only mixed recovery preserves successful history and latest data without inventing a fully restored A release', () => {
    const original = assertDefined(store.confirmed());
    const { id } = accept();
    const installed = activate(id);
    const success = connection.sqlite
      .prepare("SELECT * FROM upgrade_events WHERE attempt_id=? AND kind='activation-confirmed'")
      .all(id);
    connection.sqlite.exec(
      'CREATE TABLE state_test_web_data(id TEXT PRIMARY KEY, revision INTEGER, value TEXT)',
    );
    connection.sqlite
      .prepare('INSERT INTO state_test_web_data VALUES(?,?,?)')
      .run('after-B', 2, 'latest user data');
    store.commit(
      id,
      command(id, 'ready-revoked', {
        reason: 'state-layer Web fault',
        evidence: { componentScope: ['web'] },
      }),
    );
    const recoveryInput = {
      schemaVersion: 1,
      triggeringAttemptId: id,
      eligibilityDigest: upgradeDigest({ scope: 'sqlite-state-layer-Web-only' }),
      api: null,
      web: {
        origin: original.productionWebBinding,
        digest: original.components.web.artifactDigest,
      },
      coordinator: null,
      owner: null,
      componentScope: ['web'],
      faultDigest: upgradeDigest({ fault: 'state-layer-Web-only' }),
    };
    const fixedRecovery = { ...recoveryInput, planDigest: upgradeDigest(recoveryInput) };
    store.commit(
      id,
      command(id, 'recovery-started', {
        recoveryPlan: fixedRecovery,
        reason: 'state-layer exact Web recovery',
      }),
    );
    const mixedFacts = {
      schemaVersion: 1,
      qualified: true,
      partial: true,
      instanceId: store.instanceId,
      baseConfirmedReleaseId: installed.releaseId,
      activationGeneration: installed.activationGeneration,
      schema: installed.schema,
      components: { ...installed.components, web: original.components.web },
      observedAt: clock.now().toISOString(),
    };
    // State-layer fixture only: the service/inspector tests separately obtain the
    // physical mixed tuple. This does not create a native qualification receipt.
    const mixed = UpgradeSourceActualSchema.parse({
      ...mixedFacts,
      proofDigest: upgradeDigest(mixedFacts),
    });
    store.commit(id, command(id, 'recovery-confirmed', { actualSource: mixed }), undefined, mixed);
    expect(store.recovery()).toMatchObject({
      state: 'recovery-confirmed',
      sequence: 1,
      planDigest: fixedRecovery.planDigest,
    });
    expect(store.confirmed()).toEqual(installed);
    expect(store.instance()).toMatchObject({
      activation_generation: installed.activationGeneration,
      service_state: 'unknown',
      ready: 0,
    });
    expect(store.attempt(id)).toMatchObject({ state: 'activation-confirmed', percent: 100 });
    expect(store.snapshot(id).recoveryPlan).toEqual(fixedRecovery);
    expect(
      connection.sqlite
        .prepare("SELECT * FROM upgrade_events WHERE attempt_id=? AND kind='activation-confirmed'")
        .all(id),
    ).toEqual(success);
    expect(connection.sqlite.prepare('SELECT * FROM state_test_web_data').all()).toEqual([
      { id: 'after-B', revision: 2, value: 'latest user data' },
    ]);
    const event = connection.sqlite
      .prepare(
        "SELECT payload FROM upgrade_events WHERE attempt_id=? AND kind='recovery-confirmed'",
      )
      .get(id) as { payload: string };
    expect(JSON.parse(event.payload).actualSource.components).toEqual(mixed.components);
    expect(mixed.components.api).toEqual(installed.components.api);
    expect(mixed.components.web).toEqual(original.components.web);
    const before = store.snapshot(id);
    time += 1000;
    store.lookup('actor-a', before.attempt.requestId);
    expect(store.snapshot(id)).toEqual(before);
  });

  it('keeps recovery failure unknown without rewriting success or claiming an automatic retry', () => {
    const { id } = accept();
    const installed = activate(id);
    store.commit(
      id,
      command(id, 'recovery-started', {
        reason: 'controlled fault',
        recoveryPlan: recoveryPlan(id),
      }),
    );
    store.commit(id, command(id, 'recovery-failed', { reason: 'fallback proof missing' }));
    const before = store.snapshot(id);
    const publicBefore = store.lookup('actor-a', before.attempt.requestId);
    expect(before.recovery).toMatchObject({ state: 'unknown', sequence: 1 });
    expect(before.attempt).toMatchObject({ state: 'activation-confirmed', percent: 100 });
    expect(store.confirmed()).toEqual(installed);
    expect(store.instance()).toMatchObject({ service_state: 'transitioning', ready: 0 });
    time += 10_000;
    expect(store.lookup('actor-a', before.attempt.requestId)).toEqual(publicBefore);
    expect(store.snapshot(id)).toEqual(before);
  });

  it('rejects a stale recovery activation generation without restoring older ledger or business data', () => {
    const { id } = accept();
    const installed = activate(id);
    store.commit(
      id,
      command(id, 'recovery-started', {
        reason: 'state-layer fallback',
        recoveryPlan: recoveryPlan(id),
      }),
    );
    const before = store.snapshot(id);
    expect(() =>
      store.commit(
        id,
        command(id, 'recovery-confirmed', {}),
        current('0.2.0', installed.activationGeneration),
      ),
    ).toThrow('RECOVERY_ACTIVATION_GENERATION_CONFLICT');
    expect(() =>
      store.commit(id, command(id, 'recovery-confirmed', {}), current('0.2.0', 1)),
    ).toThrow('RECOVERY_ACTIVATION_GENERATION_CONFLICT');
    expect(store.snapshot(id)).toEqual(before);
    expect(store.confirmed()).toEqual(installed);
    expect(store.instance().activation_generation).toBe(installed.activationGeneration);
  });

  it('new explicit attempt supersedes every older controller even a retained successful 100 attempt', () => {
    const first = accept();
    const installed = activate(first.id);
    const stale = command(first.id, 'ready-revoked', { reason: 'old-controller late observation' });
    time += 1;
    const fixture = target(installed, '0.2.2');
    const next = store.accept('actor-b', fixture.request, fixture.envelope, fixture.plan);
    const authority = store.claim(next.attemptId, 'controller-b', 30_000);
    expect(next.generation).toBeGreaterThan(stale.generation);
    expect(authority.fence).toBeGreaterThan(stale.fence);
    expect(() => store.commit(first.id, stale)).toThrow('UPGRADE_AUTHORITY_SUPERSEDED');
    expect(() => store.claim(first.id, 'controller-a', 30_000)).toThrow(
      'UPGRADE_AUTHORITY_SUPERSEDED',
    );
    expect(() => store.renew(first.id, stale.fence, 'controller-a')).toThrow(
      'UPGRADE_AUTHORITY_SUPERSEDED',
    );
    expect(store.lookup('actor-a', first.request.requestId)).toMatchObject({
      state: 'activation-confirmed',
      percent: 100,
    });
    expect(store.latest()?.attemptId).toBe(next.attemptId);
    expect(store.confirmed()).toEqual(installed);
  });

  it('current attempt and recovery authority follow persisted generations when the observation clock moves backwards', () => {
    const first = accept();
    const installed = activate(first.id);
    time -= 60_000;
    const fixture = target(installed, '0.2.2');
    const next = store.accept('actor-b', fixture.request, fixture.envelope, fixture.plan);
    expect(store.latest()?.attemptId).toBe(next.attemptId);
    store.claim(next.attemptId, 'controller-b', 30_000);
    store.commit(
      next.attemptId,
      command(next.attemptId, 'failed', { reason: 'state-layer fault' }),
    );
    store.commit(
      next.attemptId,
      command(next.attemptId, 'recovery-started', {
        reason: 'state-layer first recovery',
        recoveryPlan: recoveryPlan(next.attemptId),
      }),
    );
    const originalRecovery = assertDefined(store.recovery());
    store.commit(
      next.attemptId,
      command(next.attemptId, 'recovery-failed', { reason: 'await independent proof' }),
    );
    time -= 60_000;
    store.commit(
      next.attemptId,
      command(next.attemptId, 'recovery-started', {
        reason: 'state-layer explicitly new recovery',
        recoveryPlan: recoveryPlan(next.attemptId),
      }),
    );
    const currentRecovery = assertDefined(store.recovery());
    expect(currentRecovery.generation).toBeGreaterThan(originalRecovery.generation);
    expect(currentRecovery.recoveryAttemptId).not.toBe(originalRecovery.recoveryAttemptId);
    expect(currentRecovery.state).toBe('recovering');
    expect(store.latest()?.attemptId).toBe(next.attemptId);
    expect(store.attempt(first.id)).toMatchObject({ state: 'activation-confirmed', percent: 100 });
  });
});

// Real SQLite projection regression only. Large state-layer receipts do not
// represent runtime/native traffic or release qualification evidence.
describe('UPG high-frequency probe snapshot excludes historical receipt payloads', () => {
  it('preserves current probe inputs and the applied candidate without reading or decoding megabytes of observation/continuity history', () => {
    const fixture = accept();
    const candidate = {
      kind: 'api',
      instanceId: store.instanceId,
      attemptId: fixture.id,
      origin: 'http://127.0.0.1:32123',
      artifactDigest: fixture.envelope.manifest.components.api.artifactDigest,
      inputFingerprint: fixture.envelope.manifest.components.api.inputFingerprint,
      startIdentity: 'persisted-candidate-incarnation',
      pid: 1,
    };
    const write = connection.sqlite.prepare(
      'UPDATE upgrade_steps SET applied=1,completed_work=1,receipt_digest=?,evidence=?,applied_at=? WHERE attempt_id=? AND step_id=?',
    );
    write.run(upgradeDigest(candidate), JSON.stringify(candidate), time, fixture.id, 'candidate');
    const marker = 'HISTORICAL_OBSERVATION_NOT_A_PROBE_INPUT';
    const history = { marker, payload: 'x'.repeat(1_800_000) };
    const large = JSON.stringify(history);
    for (const stepId of ['observe-1', 'observe-5'])
      expect(write.run(upgradeDigest(history), large, time, fixture.id, stepId).changes).toBe(1);
    connection.sqlite
      .prepare('INSERT INTO upgrade_continuity_baselines VALUES(?,?,?,?)')
      .run(fixture.id, large, upgradeDigest(history), time);
    const full = store.snapshot(fixture.id);
    expect(full.appliedSteps.filter((step) => step.stepId.startsWith('observe-'))).toHaveLength(2);
    expect(Buffer.byteLength(large) * 2).toBeGreaterThan(3_600_000);
    const prepareSpy = vi.spyOn(connection.sqlite, 'prepare');
    const parseSpy = vi.spyOn(JSON, 'parse');
    let projected: ReturnType<UpgradeStore['latestProbeSnapshot']>;
    let queries: string[], decoded: string[];
    try {
      projected = store.latestProbeSnapshot();
      queries = prepareSpy.mock.calls.map(([sql]) => sql);
      decoded = parseSpy.mock.calls.map(([value]) => value);
    } finally {
      prepareSpy.mockRestore();
      parseSpy.mockRestore();
    }
    expect(projected).toEqual({
      attempt: { attemptId: fixture.id },
      fence: full.fence,
      leaseExpiresAt: full.leaseExpiresAt,
      plan: full.plan,
      manifest: full.manifest,
      sourceActivation: full.sourceActivation,
      sourceActual: full.sourceActual,
      appliedSteps: full.appliedSteps.filter((step) => step.stepId === 'candidate'),
    });
    expect(assertDefined(assertDefined(projected).appliedSteps[0]).evidence).toEqual(candidate);
    expect(assertDefined(decoded).some((value) => value.includes(marker))).toBe(false);
    expect(assertDefined(queries).every((sql) => !/SELECT\s+\*/i.test(sql))).toBe(true);
    expect(
      assertDefined(queries).some((sql) =>
        /upgrade_continuity_baselines|upgrade_events|upgrade_recoveries/.test(sql),
      ),
    ).toBe(false);
    const stepQueries = assertDefined(queries).filter((sql) => sql.includes('upgrade_steps'));
    expect(stepQueries).toHaveLength(1);
    expect(stepQueries[0]).toMatch(/step_id\s*=\s*'candidate'/);
    expect(stepQueries[0]).toMatch(/applied\s*=\s*1/);
    // Even undecodable unrelated history cannot be loaded into this hot path.
    connection.sqlite
      .prepare("UPDATE upgrade_steps SET evidence=? WHERE attempt_id=? AND step_id='observe-1'")
      .run('{invalid-history:' + large, fixture.id);
    expect(store.latestProbeSnapshot()).toEqual(projected);
  });
  it('reads the current fence and lease afresh and never exposes an unapplied candidate', () => {
    expect(store.latestProbeSnapshot()).toBeNull();
    const fixture = accept();
    connection.sqlite
      .prepare("UPDATE upgrade_steps SET evidence=? WHERE attempt_id=? AND step_id='candidate'")
      .run('{not-yet-applied', fixture.id);
    const initial = assertDefined(store.latestProbeSnapshot());
    expect(initial.appliedSteps).toEqual([]);
    time += 31_000;
    expect(assertDefined(store.latestProbeSnapshot()).leaseExpiresAt).toBeLessThan(time);
    const claimed = store.claim(fixture.id, 'replacement-probe-controller', 30_000);
    const fresh = assertDefined(store.latestProbeSnapshot());
    expect(fresh.fence).toBe(claimed.fence);
    expect(fresh.fence).toBeGreaterThan(initial.fence);
    expect(fresh.leaseExpiresAt).toBe(time + 30_000);
    expect(fresh.appliedSteps).toEqual([]);
    expect(() => store.assertFence(fixture.id, initial.fence)).toThrow('UPGRADE_FENCE_EXPIRED');
  });
  it('selects the same latest instance attempt as the full snapshot after a new explicit intent', () => {
    const first = accept();
    store.commit(first.id, command(first.id, 'deferred', { reason: 'state-layer fixture' }));
    const second = accept();
    expect(second.id).not.toBe(first.id);
    const selected = assertDefined(store.latestProbeSnapshot());
    expect(selected.attempt.attemptId).toBe(assertDefined(store.latest()).attemptId);
    expect(selected.attempt.attemptId).toBe(second.id);
    expect(selected.fence).toBe(store.snapshot(second.id).fence);
  });
  it.each([
    'valid',
    'wrong-fence',
    'wrong-generation',
    'expired',
    'newer-attempt',
    'higher-contract',
  ])('retains the actual %s authority guard without reading large step history', (boundary) => {
    const fixture = accept();
    const before = store.snapshot(fixture.id);
    const evidence = { marker: 'large-unrelated-guard-history', payload: 'x'.repeat(1_800_000) };
    connection.sqlite
      .prepare(
        "UPDATE upgrade_steps SET applied=1,receipt_digest=?,evidence=?,applied_at=? WHERE attempt_id=? AND step_id='observe-1'",
      )
      .run(upgradeDigest(evidence), JSON.stringify(evidence), time, fixture.id);
    if (boundary === 'expired') time += 31_000;
    if (boundary === 'newer-attempt') {
      store.commit(fixture.id, command(fixture.id, 'deferred', { reason: 'state fixture' }));
      accept();
    }
    if (boundary === 'higher-contract')
      connection.sqlite
        .prepare(
          'INSERT INTO platform_operations(operation_id,instance_id,actor_id,role,fence,request_digest,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)',
        )
        .run(
          randomUUID(),
          store.instanceId,
          'state-fixture-actor',
          'project-name-contract',
          before.fence + 1,
          upgradeDigest({ scope: 'state-only-contract' }),
          'completed',
          time,
          time,
        );
    const querySpy = vi.spyOn(connection.sqlite, 'prepare');
    let queries: string[];
    try {
      const check = () =>
        store.assertFence(
          fixture.id,
          before.fence + Number(boundary === 'wrong-fence'),
          before.attempt.generation + Number(boundary === 'wrong-generation'),
        );
      if (boundary === 'valid') expect(check().attempt_id).toBe(fixture.id);
      else
        expect(check).toThrow(
          ['newer-attempt', 'higher-contract'].includes(boundary)
            ? 'UPGRADE_AUTHORITY_SUPERSEDED'
            : 'UPGRADE_FENCE_EXPIRED',
        );
      queries = querySpy.mock.calls.map(([sql]) => sql);
    } finally {
      querySpy.mockRestore();
    }
    expect(
      assertDefined(queries).some((sql) => /upgrade_steps|upgrade_continuity_baselines/.test(sql)),
    ).toBe(false);
  });
});
