import 'reflect-metadata';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Clock } from '@platform/shared-kernel';
import type { RuntimeOwnerProviderRegistry } from '@platform/sandbox';
import { CoordinatorHandoff } from '../../../apps/api/src/platform/upgrade/coordinator-handoff';
import { UpgradeStore } from '../../../apps/api/src/platform/upgrade/upgrade-store';
import {
  coordinatorWriterControl,
  fenceCoordinatorConnection,
} from '../../../apps/api/src/platform/persistence/coordinator-lease';
import {
  canonicalUpgrade,
  freezeUpgradePlan,
} from '../../../apps/api/src/platform/upgrade/upgrade-trust';
import type { ControlApplicationRegistry } from '../../../apps/api/src/platform/control-rpc/control-rpc.module';
import { planFixtureEnvelope, planFixtureSource } from '../../support/upgrade-plan-fixture';
import { deferred, stub, unused, useEnv } from '../../support/strict-ports';

const clock: Clock = { now: () => new Date() };
const instanceId = 'coordinator-release-budget-instance';
const cleanups: (() => Promise<void>)[] = [];

/** This fixture supplies the quiesced stage explicitly. It exercises release
 * admission and the real source SQLite lease, not a complete upgrade/quiesce. */
async function fixture(p: {
  release(signal: AbortSignal | undefined): Promise<void>;
  remainingMs?: number;
  candidateOrigin?: string;
}) {
  const home = await mkdtemp(join(tmpdir(), 'coordinator-release-budget-'));
  const bindingPath = join(home, 'coordinator.json');
  const restore = useEnv({
    PLATFORM_INSTANCE_ID: instanceId,
    PLATFORM_PROCESS_ROLE: undefined,
    PLATFORM_COORDINATOR_BINDING_PATH: bindingPath,
    COORDINATOR_GENERATION: undefined,
    COORDINATOR_WRITER_FENCE_VALID: undefined,
  });
  const raw = new Database(join(home, 'platform.sqlite'));
  raw.pragma('journal_mode = WAL');
  const sqlite = fenceCoordinatorConnection(raw, instanceId, clock, { next: randomUUID });
  cleanups.push(async () => {
    sqlite.close();
    restore();
    await rm(home, { recursive: true, force: true });
  });
  migrate(drizzle(sqlite), { migrationsFolder: resolve('drizzle') });
  sqlite.exec('CREATE TABLE release_writer_probe(value TEXT)');
  const store = new UpgradeStore(sqlite, clock, { next: randomUUID });
  const schema = (
    sqlite.prepare('SELECT count(*) n FROM __drizzle_migrations').get() as { n: number }
  ).n;
  const source = planFixtureSource(schema);
  const envelope = planFixtureEnvelope(source, '0.2.1');
  const plan = freezeUpgradePlan(envelope, source);
  store.bootstrap(source);
  const accepted = store.accept(
    'release-budget-actor',
    {
      requestId: randomUUID(),
      targetReleaseId: envelope.manifest.releaseId,
      targetDigest: envelope.manifestDigest,
      expectedActivationGeneration: 1,
    },
    envelope,
    plan,
  );
  const { fence } = store.claim(accepted.attemptId, 'release-budget-controller', 30000);
  const operationId = randomUUID();
  const writer = coordinatorWriterControl(sqlite);
  const calls = { release: 0, activate: 0, resume: 0 };
  const owners = stub<RuntimeOwnerProviderRegistry>(
    {
      releaseBusinessAuthority: async (signal) => {
        calls.release++;
        await p.release(signal);
      },
      activateBusinessAuthority: async () => {
        calls.activate++;
        throw new Error('Unknown Owner release is not authority to re-claim');
      },
    },
    'explicit external Owner release port',
  );
  const applications = stub<ControlApplicationRegistry>(
    {
      resume: () => {
        calls.resume++;
        throw new Error('Unknown Owner release is not authority to resume applications');
      },
    },
    'application admission port',
  );
  const handoff = new CoordinatorHandoff(
    store,
    unused('source continuity/artifact inspector'),
    applications,
    unused('task pump'),
    unused('terminal gateway'),
    unused('automation scheduler'),
    unused('provision ownership'),
    unused('clone ownership'),
    unused('event gateway'),
    unused('task gateway'),
    owners,
    clock,
    unused('sandbox cleanup ownership'),
  );
  const binding = canonicalUpgrade({
    state: 'quiescing',
    instanceId,
    origin: 'http://127.0.0.1:43123',
    generation: writer.generation,
    artifactDigest: envelope.manifest.components.coordinator.artifactDigest,
    attemptId: accepted.attemptId,
    fence,
  });
  await writeFile(bindingPath, binding, { mode: 0o600 });
  const quiescedAt =
    clock.now().getTime() - plan.policy.requestDeadlineMs + (p.remainingMs ?? 2000);
  sqlite
    .prepare(
      "INSERT INTO coordinator_handoffs(attempt_id,operation_id,plan_digest,candidate,stage,source_generation,quiesced_at) VALUES(?,?,?,?,'quiesced',?,?)",
    )
    .run(
      accepted.attemptId,
      operationId,
      plan.planDigest,
      canonicalUpgrade({
        startIdentity: 'explicit-stage-candidate-birth',
        artifactDigest: envelope.manifest.components.coordinator.artifactDigest,
        managementOrigin: p.candidateOrigin ?? 'http://127.0.0.1:1',
      }),
      writer.generation,
      quiescedAt,
    );
  return {
    sqlite,
    writer,
    calls,
    quiescedAt,
    release: () =>
      handoff.execute(accepted.attemptId, {
        action: 'release',
        fence,
        operationId,
        planDigest: plan.planDigest,
      }),
    row: () =>
      sqlite
        .prepare(
          'SELECT stage,quiesced_at,activated_at,evidence FROM coordinator_handoffs WHERE attempt_id=?',
        )
        .get(accepted.attemptId),
    assertBindingUnchanged: async () => expect(await readFile(bindingPath, 'utf8')).toBe(binding),
  };
}

afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

describe('actual CoordinatorHandoff release uses the original quiesce budget', () => {
  it('retains the releasing intent and actual source writer after an unknown Owner result without compensation', async () => {
    const gate = deferred<void>();
    const unknown = new Error('Explicit external Owner result is unknown');
    const f = await fixture({ release: () => gate.promise });
    const work = f.release();
    const rejected = expect(work).rejects.toBe(unknown);
    try {
      await vi.waitFor(() => expect(f.calls.release).toBe(1));
      expect(f.row()).toMatchObject({ stage: 'releasing', quiesced_at: f.quiescedAt });
      gate.reject(unknown);
      await rejected;
      expect(f.row()).toMatchObject({
        stage: 'releasing',
        quiesced_at: f.quiescedAt,
        activated_at: null,
        evidence: null,
      });
      expect(f.calls).toEqual({ release: 1, activate: 0, resume: 0 });
      expect(() => f.writer.assert()).not.toThrow();
      f.sqlite.prepare("INSERT INTO release_writer_probe VALUES('still-owned')").run();
      expect(f.sqlite.prepare('SELECT value FROM release_writer_probe').all()).toEqual([
        { value: 'still-owned' },
      ]);
      await f.assertBindingUnchanged();
    } finally {
      gate.reject(unknown);
      await rejected;
    }
  });

  it('passes the remaining original deadline to the Owner and preserves source ownership when it aborts', async () => {
    let observed: AbortSignal | undefined;
    const f = await fixture({
      remainingMs: 100,
      release: async (signal) => {
        if (!signal) throw new Error('Actual handoff must provide its common deadline signal');
        observed = signal;
        await new Promise<void>((_ok, fail) => {
          const aborted = () => fail(signal.reason);
          signal.addEventListener('abort', aborted, { once: true });
          if (signal.aborted) aborted();
        });
      },
    });
    await expect(f.release()).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(observed?.aborted).toBe(true);
    expect(f.calls).toEqual({ release: 1, activate: 0, resume: 0 });
    expect(f.row()).toMatchObject({ stage: 'releasing', quiesced_at: f.quiescedAt });
    expect(() => f.writer.assert()).not.toThrow();
    await f.assertBindingUnchanged();
  });

  it('rejects an expired original quiesce deadline before any Owner release', async () => {
    const f = await fixture({
      remainingMs: -1,
      release: async () => {
        throw new Error('Expired original deadline must reject before the external port');
      },
    });
    await expect(f.release()).rejects.toMatchObject({ code: 'HANDOFF_CONTROL_BUDGET_EXCEEDED' });
    expect(f.calls).toEqual({ release: 0, activate: 0, resume: 0 });
    expect(f.row()).toMatchObject({ stage: 'quiesced', quiesced_at: f.quiescedAt });
    expect(() => f.writer.assert()).not.toThrow();
    await f.assertBindingUnchanged();
  });

  it('expires the real SQLite writer only after a confirmed external release, without claiming candidate adoption', async () => {
    const candidateRequests: string[] = [];
    const candidate = createServer((request, response) => {
      candidateRequests.push(request.url ?? '');
      request.resume();
      response.writeHead(409, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ code: 'FIXTURE_ADOPTION_IS_NOT_PROVIDED' }));
    });
    await new Promise<void>((ok) => candidate.listen(0, '127.0.0.1', ok));
    cleanups.push(async () => {
      candidate.closeAllConnections();
      await new Promise<void>((ok) => candidate.close(() => ok()));
    });
    const f = await fixture({
      release: async () => undefined,
      candidateOrigin: `http://127.0.0.1:${(candidate.address() as AddressInfo).port}`,
    });
    await expect(f.release()).rejects.toMatchObject({ code: 'COORDINATOR_CANDIDATE_UNCONFIRMED' });
    expect(f.calls).toEqual({ release: 1, activate: 0, resume: 0 });
    expect(
      f.sqlite
        .prepare("SELECT expires_at FROM platform_role_leases WHERE role='state-coordinator'")
        .get(),
    ).toEqual({ expires_at: 0 });
    expect(() => f.writer.assert()).toThrow('COORDINATOR_WRITER_FENCE_EXPIRED');
    expect(f.row()).toMatchObject({ stage: 'releasing', activated_at: null, evidence: null });
    expect(candidateRequests).toEqual(['/internal/coordinator/adopt']);
    await f.assertBindingUnchanged();
  });
});
