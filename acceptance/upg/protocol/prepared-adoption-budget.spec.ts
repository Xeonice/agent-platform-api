import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Server } from 'node:http';
import { Controller, Get } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { CoordinatorWorker } from '@platform/shared-kernel';
import {
  prepareCoordinatorHttpTransport,
  preparedCoordinatorBusinessTransportReady,
} from '../../../apps/api/src/roles/coordinator-prepared-main';
import { preparedConnection } from '../../../apps/api/src/platform/persistence/prepared-connection';
import {
  coordinatorWriterControl,
  fenceCoordinatorConnection,
} from '../../../apps/api/src/platform/persistence/coordinator-lease';
import { readPublicNetworkConfig } from '../../../apps/api/src/platform/config/public-network';
import { DeploymentState } from '../../../apps/api/src/platform/deployment/deployment-state';
import { UpgradeStore } from '../../../apps/api/src/platform/upgrade/upgrade-store';
import type { HandoffRow } from '../../../apps/api/src/platform/upgrade/coordinator-handoff';
import { freezeUpgradePlan } from '../../../apps/api/src/platform/upgrade/upgrade-trust';
import { CoordinatorHandoffBudget } from '../../../apps/api/src/platform/upgrade/coordinator-handoff-budget';
import { completePreparedCoordinatorAdoption } from '../../../apps/api/src/platform/upgrade/prepared-coordinator-adoption';
import { planFixtureEnvelope, planFixtureSource } from '../../support/upgrade-plan-fixture';
import { deferred, useEnv } from '../../support/strict-ports';
import { writeInstalledBinding } from '../../../apps/api/src/platform/upgrade/upgrade-atomic-file';
import { UpgradeInternalController } from '../../../apps/api/src/platform/upgrade/upgrade.controller';
import { UpgradeService } from '../../../apps/api/src/platform/upgrade/upgrade-service';
import { UpgradeSecurity } from '../../../apps/api/src/platform/access-passcode/upgrade-security.service';
import { CoordinatorHandoff } from '../../../apps/api/src/platform/upgrade/coordinator-handoff';
import { UpgradeRoleHandoffs } from '../../../apps/api/src/platform/upgrade/upgrade-role-handoffs';
import { UpgradeObserver } from '../../../apps/api/src/platform/upgrade/upgrade-observer';
import { UpgradeOnlineMigration } from '../../../apps/api/src/platform/upgrade/upgrade-online-migration';
import { CoordinatorRecovery } from '../../../apps/api/src/platform/upgrade/coordinator-recovery';

const internalKey = 'prepared-publication-test-controller-key-32';
const internalHeaders = {
  'x-platform-internal-key': internalKey,
  'x-platform-instance-id': 'adoption-budget',
};

const publication = vi.hoisted(() => ({
  directory: null as string | null,
  entered: null as (() => void) | null,
  wait: null as Promise<void> | null,
  failure: null as Error | null,
}));
// Keep real file writes, atomic rename and directory fsync. Only hold the
// original directory-sync Promise after rename to expose concurrent readers.
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...real,
    open: async (...args: Parameters<typeof real.open>) => {
      const handle = await real.open(...args);
      if (args[0] !== publication.directory || args[1] !== 'r') return handle;
      return new Proxy(handle, {
        get(target, key) {
          if (key === 'sync')
            return async () => {
              await target.sync();
              publication.entered?.();
              await publication.wait;
              if (publication.failure) throw publication.failure;
            };
          const value: unknown = Reflect.get(target, key, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
  };
});

@Controller('adoption-proof')
class ProofController {
  @Get() read() {
    return { ready: true };
  }
}
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  publication.directory = null;
  publication.entered = null;
  publication.wait = null;
  publication.failure = null;
  for (const close of cleanups.splice(0).reverse()) await close();
});

async function fixture(hook: () => Promise<void> = async () => {}) {
  const directory = mkdtempSync(join(tmpdir(), 'upg-adoption-deadline-'));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  cleanups.push(
    useEnv({
      PLATFORM_INSTANCE_ID: 'adoption-budget',
      COORDINATOR_GENERATION: undefined,
      COORDINATOR_WRITER_FENCE_VALID: undefined,
      PLATFORM_CONTROLLER_RPC_KEY: internalKey,
    }),
  );
  const clock = { now: () => new Date() },
    ids = { next: randomUUID };
  const source = fenceCoordinatorConnection(
    new Database(join(directory, 'state.db')),
    'adoption-budget',
    clock,
    ids,
  );
  migrate(drizzle(source), { migrationsFolder: resolve('drizzle') });
  cleanups.push(() => {
    source.close();
  });
  const original = new UpgradeStore(source, clock, ids);
  const installed = planFixtureSource(
    Number(
      (source.prepare('SELECT count(*) n FROM __drizzle_migrations').get() as { n: number }).n,
    ),
  );
  // The real accepted upgrade/claim supplies all authority. Only the handoff
  // stage is seeded as this function's explicit input boundary, not a full upgrade.
  original.bootstrap(installed);
  const envelope = planFixtureEnvelope(installed, '0.2.1'),
    plan = freezeUpgradePlan(envelope, installed);
  const accepted = original.accept(
    'test-actor',
    {
      requestId: randomUUID(),
      targetReleaseId: envelope.manifest.releaseId,
      targetDigest: envelope.manifestDigest,
      expectedActivationGeneration: 1,
    },
    envelope,
    plan,
  );
  const claim = original.claim(accepted.attemptId, 'original-controller', 120000);
  const prepared = preparedConnection(join(directory, 'state.db'), 'adoption-budget');
  cleanups.push(() => {
    prepared.connection.sqlite.close();
  });
  const currentStore: { value?: UpgradeStore } = {};
  const module = await Test.createTestingModule({
    controllers: [ProofController, UpgradeInternalController],
    providers: [
      DeploymentState,
      { provide: 'real-init-hook', useValue: { onApplicationBootstrap: hook } },
      {
        provide: UpgradeService,
        useValue: {
          get store() {
            if (!currentStore.value) throw new Error('FIXTURE_WRITER_NOT_ACQUIRED');
            return currentStore.value;
          },
          security: { internal: UpgradeSecurity.prototype.internal },
        },
      },
      // These unrelated controller collaborators are never called. Renew uses
      // the real production route/authenticator and accepted/fenced SQLite Store.
      ...[
        CoordinatorHandoff,
        UpgradeRoleHandoffs,
        UpgradeObserver,
        UpgradeOnlineMigration,
        CoordinatorRecovery,
      ].map((provide) => ({ provide, useValue: {} })),
    ],
  }).compile();
  const app = module.createNestApplication();
  cleanups.push(() => app.close());
  let ready = false;
  const initialize = await prepareCoordinatorHttpTransport(
    app,
    readPublicNetworkConfig(),
    { host: '127.0.0.1', port: 0 },
    () => ready,
  );
  const path = join(directory, 'binding.json');
  await writeInstalledBinding(path, { state: 'quiescing', generation: 1 });
  coordinatorWriterControl(source).release();
  const generation = prepared.activate();
  const store = new UpgradeStore(prepared.connection.sqlite, clock, ids);
  currentStore.value = store;
  const row: HandoffRow = {
    attempt_id: accepted.attemptId,
    operation_id: randomUUID(),
    plan_digest: plan.planDigest,
    candidate: '{}',
    stage: 'adopting',
    source_generation: 1,
    target_generation: generation,
    quiesced_at: Date.now(),
    activated_at: null,
    evidence: null,
  };
  prepared.connection.sqlite
    .prepare(
      'INSERT INTO coordinator_handoffs(attempt_id,operation_id,plan_digest,candidate,stage,source_generation,target_generation,quiesced_at,activated_at,evidence) VALUES(?,?,?,?,?,?,?,?,?,?)',
    )
    .run(
      row.attempt_id,
      row.operation_id,
      row.plan_digest,
      row.candidate,
      row.stage,
      row.source_generation,
      row.target_generation,
      row.quiesced_at,
      row.activated_at,
      row.evidence,
    );
  const worker = new CoordinatorWorker('test.prepared-adoption');
  return {
    app,
    source,
    store,
    row,
    claim,
    clock,
    initialize,
    path,
    worker,
    generation,
    directory,
    renew: () =>
      request(app.getHttpServer())
        .post('/internal/upgrades/' + accepted.attemptId + '/renew')
        .set(internalHeaders)
        .send({ fence: claim.fence, controllerId: 'original-controller' }),
    input: (
      duration: number,
      continuity: () => Promise<Record<string, unknown>> = async () => ({ qualified: true }),
    ) => {
      // Each fixture uses the same frozen two-second plan. Move its explicit
      // quiesced input earlier to exercise only the original remaining budget.
      row.quiesced_at = Date.now() + duration - plan.policy.requestDeadlineMs;
      store.sqlite
        .prepare('UPDATE coordinator_handoffs SET quiesced_at=? WHERE attempt_id=?')
        .run(row.quiesced_at, row.attempt_id);
      return {
        store,
        row,
        fence: claim.fence,
        generation,
        clock,
        budget: new CoordinatorHandoffBudget(
          Number(row.quiesced_at) + plan.policy.requestDeadlineMs,
          clock,
          (work) => worker.run(work),
        ),
        // Explicit external authority port; real Owner HTTP/SQLite semantics are
        // separately covered in owner-handoff-deadline.spec.ts.
        owners: { activateBusinessAuthority: async () => {} },
        initialize,
        seal: () => {},
        continuity,
        assertAuthority: () => coordinatorWriterControl(prepared.connection.sqlite).assert(),
        transportReady: () => preparedCoordinatorBusinessTransportReady(app),
        setBusinessReady: (value: boolean) => {
          ready = value;
        },
        binding: { path, origin: 'http://127.0.0.1', artifactDigest: null },
      };
    },
  };
}

describe('REQ-UPG-006 — original prepared adoption deadline and real publication boundary', () => {
  it('serves real HTTP while the published ready binding waits for its original directory fsync', async () => {
    const f = await fixture();
    const entered = deferred<void>(),
      finish = deferred<void>();
    cleanups.push(() => finish.resolve());
    publication.directory = f.directory;
    publication.entered = () => entered.resolve();
    publication.wait = finish.promise;
    const adoption = completePreparedCoordinatorAdoption(f.input(2000));
    await entered.promise;
    expect(JSON.parse(readFileSync(f.path, 'utf8'))).toMatchObject({
      state: 'ready',
      generation: 2,
    });
    try {
      await f.renew().expect(200);
      const observer = new Database(join(f.directory, 'state.db'), { readonly: true });
      try {
        const row = observer.prepare('SELECT stage,evidence FROM coordinator_handoffs').get() as {
          stage: string;
          evidence: string;
        };
        expect(row.stage).toBe('adopting');
        expect(JSON.parse(row.evidence)).toMatchObject({
          phase: 'ready-publication-prepared',
          qualified: true,
          commitKnown: false,
          generation: 2,
          continuity: { qualified: true },
        });
      } finally {
        observer.close();
      }
      await request(f.app.getHttpServer()).get('/api/adoption-proof').expect(200);
      await request(f.app.getHttpServer())
        .post('/internal/upgrades/' + f.row.attempt_id + '/renew')
        .set({ ...internalHeaders, 'x-platform-internal-key': 'wrong' })
        .send({ fence: f.claim.fence, controllerId: 'original-controller' })
        .expect(403);
      await request(f.app.getHttpServer())
        .post('/internal/upgrades/' + f.row.attempt_id + '/renew')
        .set(internalHeaders)
        .send({ fence: f.claim.fence + 1, controllerId: 'original-controller' })
        .expect(409);
    } finally {
      finish.resolve();
      await adoption;
    }
  });

  it('keeps actual authenticated renew closed until the complete continuity proof is durable', async () => {
    const f = await fixture();
    const entered = deferred<void>(),
      finish = deferred<void>();
    cleanups.push(() => finish.resolve());
    const adoption = completePreparedCoordinatorAdoption(
      f.input(2000, async () => {
        entered.resolve();
        await finish.promise;
        return { qualified: true };
      }),
    );
    try {
      await entered.promise;
      await f.renew().expect(425);
      expect(f.store.sqlite.prepare('SELECT evidence FROM coordinator_handoffs').get()).toEqual({
        evidence: null,
      });
    } finally {
      finish.resolve();
    }
    await adoption;
    await f.renew().expect(200);
  });

  it('closes admission on post-rename fsync failure without claiming applied or reversing the binding', async () => {
    const f = await fixture();
    const entered = deferred<void>(),
      finish = deferred<void>();
    cleanups.push(() => finish.resolve());
    publication.directory = f.directory;
    publication.entered = () => entered.resolve();
    publication.wait = finish.promise;
    publication.failure = new Error('DIRECTORY_SYNC_FAILED');
    const adoption = completePreparedCoordinatorAdoption(f.input(2000));
    const rejected = expect(adoption).rejects.toThrow('DIRECTORY_SYNC_FAILED');
    await entered.promise;
    await f.renew().expect(200);
    finish.resolve();
    await rejected;
    await f.renew().expect(425);
    expect(JSON.parse(readFileSync(f.path, 'utf8'))).toMatchObject({
      state: 'ready',
      generation: 2,
    });
    const row = f.store.sqlite.prepare('SELECT stage,evidence FROM coordinator_handoffs').get() as {
      stage: string;
      evidence: string;
    };
    expect(row.stage).toBe('adopting');
    expect(JSON.parse(row.evidence)).toMatchObject({ commitKnown: false });
  });

  it('closes the armed gate at the original deadline and cannot reopen after late directory fsync', async () => {
    const f = await fixture();
    const entered = deferred<void>(),
      finish = deferred<void>();
    cleanups.push(() => finish.resolve());
    publication.directory = f.directory;
    publication.entered = () => entered.resolve();
    publication.wait = finish.promise;
    const adoption = completePreparedCoordinatorAdoption(f.input(300));
    const rejected = expect(adoption).rejects.toThrow('HANDOFF_CONTROL_BUDGET_EXCEEDED');
    await entered.promise;
    await f.renew().expect(200);
    await rejected;
    await f.renew().expect(425);
    expect(f.worker.snapshot().active).toBeGreaterThan(0);
    finish.resolve();
    await vi.waitFor(() => expect(f.worker.snapshot().active).toBe(0));
    await f.renew().expect(425);
    expect(f.store.sqlite.prepare('SELECT stage FROM coordinator_handoffs').get()).toEqual({
      stage: 'adopting',
    });
  });

  it('closes a published candidate when its original writer epoch is superseded during directory fsync', async () => {
    const f = await fixture();
    const entered = deferred<void>(),
      finish = deferred<void>();
    cleanups.push(() => finish.resolve());
    publication.directory = f.directory;
    publication.entered = () => entered.resolve();
    publication.wait = finish.promise;
    const adoption = completePreparedCoordinatorAdoption(f.input(2000));
    const rejected = expect(adoption).rejects.toThrow('COORDINATOR_OPERATION_EPOCH_SUPERSEDED');
    await entered.promise;
    await f.renew().expect(200);
    const writer = coordinatorWriterControl(f.store.sqlite);
    writer.release();
    expect(writer.reacquire()).toBe(3);
    finish.resolve();
    await rejected;
    await f.renew().expect(425);
    expect(f.store.sqlite.prepare('SELECT stage FROM coordinator_handoffs').get()).toEqual({
      stage: 'adopting',
    });
  });

  it('rolls back an adopted marker when the final synchronous authority check rejects', async () => {
    const f = await fixture();
    const input = f.input(2000),
      assertAuthority = input.assertAuthority;
    input.assertAuthority = () => {
      assertAuthority();
      const row = f.store.sqlite.prepare('SELECT stage FROM coordinator_handoffs').get() as {
        stage: string;
      };
      if (row.stage === 'adopted') throw new Error('FINAL_AUTHORITY_CHECK_REJECTED');
    };
    await expect(completePreparedCoordinatorAdoption(input)).rejects.toThrow(
      'FINAL_AUTHORITY_CHECK_REJECTED',
    );
    await f.renew().expect(425);
    expect(f.store.sqlite.prepare('SELECT stage FROM coordinator_handoffs').get()).toEqual({
      stage: 'adopting',
    });
    expect(JSON.parse(readFileSync(f.path, 'utf8'))).toMatchObject({
      state: 'ready',
      generation: 2,
    });
  });

  it('commits only after real Nest hooks, fenced SQLite and successful continuity, then opens actual HTTP', async () => {
    const f = await fixture();
    await request(f.app.getHttpServer()).get('/api/adoption-proof').expect(425);
    const result = await completePreparedCoordinatorAdoption(f.input(2000));
    expect(result).toMatchObject({ qualified: true, singleWriter: true, generation: 2 });
    expect(JSON.parse(readFileSync(f.path, 'utf8'))).toMatchObject({
      state: 'ready',
      generation: 2,
    });
    expect(f.store.sqlite.prepare('SELECT stage FROM coordinator_handoffs').get()).toEqual({
      stage: 'adopted',
    });
    await request(f.app.getHttpServer()).get('/api/adoption-proof').expect(200);
    expect(() => coordinatorWriterControl(f.source).assert()).toThrow(
      'COORDINATOR_WRITER_FENCE_EXPIRED',
    );
  });
  it('retains a late original init Promise in retirement and never publishes ready after its deadline', async () => {
    const blocked = deferred<void>();
    const f = await fixture(() => blocked.promise);
    cleanups.push(() => {
      blocked.resolve();
    });
    const pending = completePreparedCoordinatorAdoption(f.input(70));
    await expect(pending).rejects.toThrow('HANDOFF_CONTROL_BUDGET_EXCEEDED');
    expect(f.worker.snapshot().active).toBeGreaterThan(0);
    blocked.resolve();
    await new Promise<void>((ok) => setTimeout(ok, 20));
    expect(f.worker.snapshot().active).toBe(0);
    expect(JSON.parse(readFileSync(f.path, 'utf8'))).toEqual({ state: 'quiescing', generation: 1 });
    expect(f.store.sqlite.prepare('SELECT stage,evidence FROM coordinator_handoffs').get()).toEqual(
      { stage: 'adopting', evidence: null },
    );
    await request(f.app.getHttpServer()).get('/api/adoption-proof').expect(425);
  });
  it('refuses unqualified continuity and a physically closed reserved listener', async () => {
    const f = await fixture();
    await expect(
      completePreparedCoordinatorAdoption(f.input(2000, async () => ({ qualified: false }))),
    ).rejects.toThrow('HANDOFF_CONTINUITY_UNCONFIRMED');
    expect(JSON.parse(readFileSync(f.path, 'utf8')).state).toBe('quiescing');
    await new Promise<void>((ok, fail) =>
      (f.app.getHttpServer() as Server).close((error) => (error ? fail(error) : ok())),
    );
    await expect(completePreparedCoordinatorAdoption(f.input(2000))).rejects.toThrow(
      'PREPARED_HTTP_LISTENER_CLOSED',
    );
    expect(f.store.sqlite.prepare('SELECT evidence FROM coordinator_handoffs').get()).toEqual({
      evidence: null,
    });
  });
  it('rejects an original continuation after the same process reacquires a different writer epoch', async () => {
    const blocked = deferred<void>();
    let initializing = false;
    const f = await fixture(async () => {
      initializing = true;
      await blocked.promise;
    });
    cleanups.push(() => blocked.resolve());
    const pending = completePreparedCoordinatorAdoption(f.input(2000));
    const rejected = expect(pending).rejects.toThrow('COORDINATOR_OPERATION_EPOCH_SUPERSEDED');
    await vi.waitFor(() => expect(initializing).toBe(true));
    const control = coordinatorWriterControl(f.store.sqlite);
    control.release();
    expect(control.reacquire()).toBe(3);
    blocked.resolve();
    await rejected;
    expect(JSON.parse(readFileSync(f.path, 'utf8')).state).toBe('quiescing');
    expect(f.store.sqlite.prepare('SELECT stage,evidence FROM coordinator_handoffs').get()).toEqual(
      { stage: 'adopting', evidence: null },
    );
    await request(f.app.getHttpServer()).get('/api/adoption-proof').expect(425);
  });
  it('rejects a fresh replacement deadline instead of extending the frozen original budget', async () => {
    const f = await fixture();
    const input = f.input(500);
    input.budget = new CoordinatorHandoffBudget(Date.now() + 2000, f.clock, (work) =>
      f.worker.run(work),
    );
    await expect(completePreparedCoordinatorAdoption(input)).rejects.toThrow(
      'ORIGINAL_HANDOFF_DEADLINE_REQUIRED',
    );
    expect(JSON.parse(readFileSync(f.path, 'utf8')).state).toBe('quiescing');
    expect(f.worker.snapshot().active).toBe(0);
    await request(f.app.getHttpServer()).get('/api/adoption-proof').expect(425);
  });
  it('does not publish after an actual Nest bootstrap hook throws', async () => {
    const f = await fixture(async () => {
      throw new Error('HOOK_FAILED');
    });
    await expect(completePreparedCoordinatorAdoption(f.input(2000))).rejects.toThrow('HOOK_FAILED');
    expect(JSON.parse(readFileSync(f.path, 'utf8')).state).toBe('quiescing');
    expect(f.store.sqlite.prepare('SELECT evidence FROM coordinator_handoffs').get()).toEqual({
      evidence: null,
    });
    await request(f.app.getHttpServer()).get('/api/adoption-proof').expect(425);
  });
});
