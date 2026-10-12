import 'reflect-metadata';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
  const source = store.confirmed()!;
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
  const evidence = { scope: 'sqlite-state-layer-only', stepId: step.stepId, completedWork };
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
  it('rejects an unqualified global migration version without reserving an attempt or changing the actual journal', () => {
    const source = store.confirmed()!;
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
    const original = store.confirmed()!;
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
      const original = store.confirmed()!;
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
    const fixture = target(store.confirmed()!);
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
    const migration = plan.steps.find((s) => s.kind === 'migration')!;
    expect(store.attempt(id)).toMatchObject({ totalWork: null, percent: null, completedWork: 0 });
    for (const step of plan.steps.slice(0, plan.steps.indexOf(migration))) apply(id, step);
    store.commit(id, command(id, 'progress', { stepId: migration.stepId, completedWork: 3 }));
    expect(store.attempt(id)).toMatchObject({ totalWork: null, percent: null });
    time += 100;
    expect(store.attempt(id).percent).toBeNull();
    apply(id, migration, 7);
    expect(store.attempt(id).totalWork).toBeNull();
    expect(store.attempt(id).percent).toBeLessThan(100);
    for (const step of plan.steps.slice(plan.steps.indexOf(migration) + 1)) apply(id, step);
    expect(store.attempt(id)).toMatchObject({
      totalWork: null,
      percent: 99,
      state: 'api-activated',
    });
    expect(canonicalUpgrade(store.plan(id))).toBe(frozen);
    const activated = { ...current(plan.releaseId, 2), schema: plan.migrationPath.targetSchema };
    store.commit(id, command(id, 'activation-confirmed', {}), activated);
    expect(store.attempt(id)).toMatchObject({
      totalWork: null,
      percent: 100,
      state: 'activation-confirmed',
    });
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
    const recovery = store.recovery()!;
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
    const original = store.confirmed()!;
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
    const originalRecovery = store.recovery()!;
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
    const currentRecovery = store.recovery()!;
    expect(currentRecovery.generation).toBeGreaterThan(originalRecovery.generation);
    expect(currentRecovery.recoveryAttemptId).not.toBe(originalRecovery.recoveryAttemptId);
    expect(currentRecovery.state).toBe('recovering');
    expect(store.latest()?.attemptId).toBe(next.attemptId);
    expect(store.attempt(first.id)).toMatchObject({ state: 'activation-confirmed', percent: 100 });
  });
});
