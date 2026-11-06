import 'reflect-metadata';
import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { Controller, Get, Module, Sse } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { SANDBOX_PROVIDER_REGISTRY } from '@platform/contracts';
import { RuntimeApplicationService } from '@platform/runtime';
import { CLOCK, CoordinatorWorkRegistry, fromEpochMs } from '@platform/shared-kernel';
import { ControlApplicationRegistry } from '../../../apps/api/src/platform/control-rpc/control-rpc.module';
import { createUpgradeControlStores } from '../../../apps/api/src/platform/upgrade/control-store-factory';
import { UpgradeStore } from '../../../apps/api/src/platform/upgrade/upgrade-store';
import {
  createNormalCoordinatorRetirement,
  installNormalCoordinatorRetirement,
} from '../../../apps/api/src/platform/upgrade/normal-coordinator-retirement';
import {
  freezeUpgradePlan,
  upgradeDigest,
} from '../../../apps/api/src/platform/upgrade/upgrade-trust';
import {
  coordinatorWriterControl,
  fenceCoordinatorConnection,
} from '../../../apps/api/src/platform/persistence/coordinator-lease';
import { planFixtureEnvelope, planFixtureSource } from '../../support/upgrade-plan-fixture';
import { deferred, useEnv } from '../../support/strict-ports';

const cleanups: (() => void)[] = [];
const { Observable } = createRequire(resolve('apps/api/package.json'))(
  'rxjs',
) as typeof import('../../../apps/api/node_modules/rxjs');
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'normal-retirement-')),
    now = Date.parse('2026-10-20T00:00:00Z');
  const clock = { now: () => fromEpochMs(now) },
    instanceId = 'normal-retirement-fixture';
  const restore = useEnv({
    PLATFORM_INSTANCE_ID: instanceId,
    COORDINATOR_GENERATION: undefined,
    COORDINATOR_WRITER_FENCE_VALID: undefined,
    PLATFORM_CONTROLLER_RPC_KEY: 'synthetic-retirement-business-private-key-32',
  });
  const control = new Database(join(root, 'control.db'));
  control.pragma('journal_mode=WAL');
  const stores = createUpgradeControlStores({
    sqlite: control,
    instanceId,
    clock,
    ids: { next: randomUUID },
    claimGuard: () => null,
    dataFormatGuard: () => undefined,
  });
  const source = planFixtureSource(),
    envelope = planFixtureEnvelope(source, '0.2.1'),
    plan = freezeUpgradePlan(envelope, source);
  stores.store.bootstrap(source);
  const accepted = stores.store.accept(
    'fixture-admin',
    {
      requestId: randomUUID(),
      targetReleaseId: envelope.manifest.releaseId,
      targetDigest: envelope.manifestDigest,
      expectedActivationGeneration: 1,
    },
    envelope,
    plan,
  );
  stores.store.claim(accepted.attemptId, 'original-admin-upgrade', 30000);
  const snap = stores.store.snapshot(accepted.attemptId);
  // Exact real deferred state: no physical candidate was started. This exercises
  // the production terminal enum rather than inventing a rolled-back state.
  stores.store.commit(accepted.attemptId, {
    fence: snap.fence,
    generation: snap.attempt.generation,
    expectedSequence: snap.attempt.sequence,
    eventId: randomUUID(),
    kind: 'deferred',
    payload: { reason: 'FIXTURE_NO_CAPACITY' },
  });
  const target = {
    instanceId,
    role: 'coordinator',
    containerId: 'a'.repeat(64),
    hostPid: 123,
    startedAt: clock.now().toISOString(),
    startIdentity: 'fixture-real-coordinator-start',
    artifactDigest: envelope.manifest.components.coordinator.artifactDigest,
    attemptId: accepted.attemptId,
  };
  const operationId = randomUUID(),
    intent = {
      schemaVersion: 1,
      kind: 'normal-retirement',
      instanceId,
      operationId,
      requestId: randomUUID(),
      acceptedUpgradeId: accepted.attemptId,
      acceptedPlanDigest: plan.planDigest,
      target,
      deadline: now + 120000,
      budget: { maxDurationMs: 120000 },
    };
  control.exec(`CREATE TABLE control_authority(instance_id TEXT PRIMARY KEY,epoch,operation_id,kind,holder_id,lease_expires_at,mode);
    CREATE TABLE control_normal_retirements(operation_id TEXT PRIMARY KEY,instance_id,intent,intent_digest,state,retirement_plan,result);`);
  control
    .prepare("INSERT INTO control_authority VALUES(?,7,?,'maintenance','stable-agent',?,'active')")
    .run(instanceId, operationId, now + 30000);
  control
    .prepare("INSERT INTO control_normal_retirements VALUES(?,?,?,?, 'drain-dispatched',NULL,NULL)")
    .run(operationId, instanceId, JSON.stringify(intent), upgradeDigest(intent));
  const reader = new Database(join(root, 'control.db'), { readonly: true }),
    business = new Database(join(root, 'business.db'));
  const fenced = fenceCoordinatorConnection(business, instanceId, clock, { next: randomUUID });
  const store = new UpgradeStore(
    fenced,
    clock,
    { next: randomUUID },
    { instanceId, readonly: true, ledgerSqlite: reader },
  );
  coordinatorWriterControl(fenced).release();
  const registry = new CoordinatorWorkRegistry(),
    body = {
      schemaVersion: 1,
      instanceId,
      operationId,
      epoch: 7,
      executorId: 'stable-agent',
      intentDigest: upgradeDigest(intent),
      target: { startIdentity: target.startIdentity, artifactDigest: target.artifactDigest },
    };
  let admissionClosed = false;
  const identity = () => ({
    instanceId,
    role: 'coordinator',
    pid: process.pid,
    ...body.target,
    coordinatorGeneration: 1,
    activeRequests: 0,
    activeMutations: 0,
    activeStreams: 0,
    activeTransportConnections: 0,
    accepting: !admissionClosed,
  });
  const ports = {
    registry,
    store,
    clock,
    identity,
    closeAdmission: () => {
      admissionClosed = true;
    },
    ownerReferences: () => ({ complete: true, owners: 1, http: 0, observers: 0, renewals: 0 }),
    authCount: () => 0,
    writer: () => {
      try {
        coordinatorWriterControl(fenced).assert();
        return true;
      } catch {
        return false;
      }
    },
  };
  cleanups.push(() => {
    try {
      coordinatorWriterControl(fenced).assert();
      coordinatorWriterControl(fenced).release();
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'COORDINATOR_WRITER_FENCE_EXPIRED')
        throw error;
    }
    reader.close();
    business.close();
    control.close();
    restore();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    ...ports,
    control,
    body,
    instanceId,
    identity,
    get admissionClosed() {
      return admissionClosed;
    },
  };
}

describe('normal Coordinator private maintenance, actual SQLite and HTTP boundaries (not Native qualification)', () => {
  it('accepts real deferred attempt authority, closes future ticks and retains a running original Promise plus final log flush', async () => {
    const f = fixture(),
      worker = f.registry.register('test.background'),
      finish = deferred<void>(),
      flush = deferred<void>();
    let flushStarted = false;
    f.registry.registerFinalizer('platform.logging', async () => {
      flushStarted = true;
      await flush.promise;
    });
    f.registry.seal(['test.background', 'platform.logging']);
    worker.ownInterval(setInterval(() => undefined, 10000));
    const task = worker.run(() => finish.promise),
      manager = createNormalCoordinatorRetirement(f);
    expect(manager.census()).toMatchObject({ complete: true, writer: false, drain: null });
    await expect(manager.close(f.body)).rejects.toThrow('RETIREMENT_REFERENCES_STILL_ACTIVE');
    expect(f.admissionClosed).toBe(false);
    finish.resolve();
    await task;
    expect((await manager.close(f.body)).accepted).toBe(true);
    expect(f.admissionClosed).toBe(true);
    expect(manager.census()).toMatchObject({ drain: { admissionClosed: true, settled: false } });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(flushStarted).toBe(true);
    expect(manager.census().counts.workers).toBeGreaterThan(0);
    flush.resolve();
    await f.registry.stop();
    expect(manager.census()).toMatchObject({ counts: { workers: 0 }, drain: { settled: true } });
  });
  it('never accepts the business key alone, stale epoch, foreign target, changed intent or an active writer', async () => {
    const f = fixture();
    f.registry.seal([]);
    const manager = createNormalCoordinatorRetirement(f);
    await expect(manager.close({ ...f.body, epoch: 6 })).rejects.toThrow(
      'RETIREMENT_MAINTENANCE_AUTHORITY_REQUIRED',
    );
    await expect(
      manager.close({ ...f.body, target: { ...f.body.target, startIdentity: 'foreign-process' } }),
    ).rejects.toThrow('RETIREMENT_TARGET_CHANGED');
    f.control
      .prepare('UPDATE control_normal_retirements SET intent_digest=?')
      .run('sha256:' + '0'.repeat(64));
    await expect(manager.close(f.body)).rejects.toThrow('RETIREMENT_INTENT_REQUIRED');
    f.control
      .prepare('UPDATE control_normal_retirements SET intent_digest=?')
      .run(f.body.intentDigest);
    coordinatorWriterControl(f.store.sqlite).reacquire();
    await expect(manager.close(f.body)).rejects.toThrow('RETIREMENT_WRITER_STILL_ACTIVE');
    expect(f.admissionClosed).toBe(false);
  });
  it('keeps unknown manifest or Owner observations unknown even after all known counts are zero', async () => {
    const f = fixture();
    f.registry.seal(['missing.worker']);
    const manager = createNormalCoordinatorRetirement(f);
    expect(manager.census().complete).toBe(false);
    await expect(manager.close(f.body)).rejects.toThrow('RETIREMENT_REFERENCES_STILL_ACTIVE');
    expect(f.admissionClosed).toBe(false);
  });
  it('an actual aborted HTTP response retains its handler Promise; drain uses only maintenance authority and returns 202 without waiting for background work', async () => {
    const f = fixture(),
      entered = deferred<void>(),
      finish = deferred<void>(),
      streamFinish = deferred<void>();
    let streamCleanups = 0;
    @Controller('work')
    class WorkController {
      @Get() async read() {
        entered.resolve();
        await finish.promise;
        return { done: true };
      }
      @Sse('events') events() {
        // Finite observable forwarding fixture only. Production Coordinators
        // reject unreviewed permanent @Sse subscriptions in the DI audit.
        return new Observable<{ data: { seq: number } }>((subscriber) => {
          subscriber.next({ data: { seq: 1 } });
          queueMicrotask(() => {
            subscriber.next({ data: { seq: 2 } });
          });
          void streamFinish.promise.then(() => {
            subscriber.complete();
          });
          return () => {
            streamCleanups++;
          };
        });
      }
    }
    @Module({
      controllers: [WorkController],
      providers: [
        {
          provide: ControlApplicationRegistry,
          useValue: { identity: f.identity, closeRetirementAdmission: f.closeAdmission },
        },
        { provide: UpgradeStore, useValue: f.store },
        { provide: CLOCK, useValue: f.clock },
        {
          provide: SANDBOX_PROVIDER_REGISTRY,
          useValue: { transportReferences: f.ownerReferences },
        },
        { provide: RuntimeApplicationService, useValue: { activeAuthCount: () => 0 } },
      ],
    })
    class TestModule {}
    const module = await Test.createTestingModule({ imports: [TestModule] }).compile();
    const app = module.createNestApplication({ logger: false });
    try {
      installNormalCoordinatorRetirement(app, f.registry);
      f.registry.seal(['platform.http']);
      await app.listen(0, '127.0.0.1');
      const origin = await app.getUrl(),
        controller = new AbortController();
      const request = fetch(origin + '/work', { signal: controller.signal }).catch(() => undefined);
      await entered.promise;
      controller.abort();
      await request;
      const headers = {
        'x-platform-internal-key': String(process.env.PLATFORM_CONTROLLER_RPC_KEY),
        'x-platform-instance-id': f.instanceId,
        'content-type': 'application/json',
      };
      const read = async () =>
        (await fetch(origin + '/internal/application/retirement', { headers }).then((r) =>
          r.json(),
        )) as { counts: { userOperations: number }; drain: { settled: boolean } };
      expect((await read()).counts.userOperations).toBeGreaterThan(0);
      expect(
        (
          await fetch(origin + '/internal/application/retirement-drain', {
            method: 'POST',
            headers,
            body: JSON.stringify(f.body),
          })
        ).status,
      ).toBe(409);
      expect(
        (
          await fetch(origin + '/internal/application/retirement', {
            headers: { ...headers, 'x-platform-internal-key': 'foreign-key' },
          })
        ).status,
      ).toBe(403);
      finish.resolve();
      await new Promise<void>((resolve) => setImmediate(resolve));
      const streamAbort = new AbortController(),
        stream = await fetch(origin + '/work/events', { signal: streamAbort.signal });
      if (!stream.body) throw new Error('FIXTURE_SSE_BODY_MISSING');
      const reader = stream.body.getReader();
      let frames = '';
      while (!frames.includes('"seq":2')) {
        frames += new TextDecoder().decode((await reader.read()).value);
      }
      expect(frames).toContain('"seq":1');
      expect(frames).toContain('"seq":2');
      expect((await read()).counts.userOperations).toBeGreaterThan(0);
      streamAbort.abort();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(streamCleanups).toBe(0);
      expect((await read()).counts.userOperations).toBeGreaterThan(0);
      expect(
        (
          await fetch(origin + '/internal/application/retirement-drain', {
            method: 'POST',
            headers,
            body: JSON.stringify(f.body),
          })
        ).status,
      ).toBe(409);
      streamFinish.resolve();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(streamCleanups).toBe(1);
      expect(
        (
          await fetch(origin + '/internal/application/retirement-drain', {
            method: 'POST',
            headers,
            body: JSON.stringify(f.body),
          })
        ).status,
      ).toBe(202);
      await f.registry.stop();
      expect((await read()).drain.settled).toBe(true);
      const refused = await fetch(origin + '/work');
      expect(refused.status).toBe(503);
      expect(await refused.json()).toMatchObject({
        code: 'COORDINATOR_WORKER_DRAINING',
        retryable: false,
        sideEffectFree: true,
      });
    } finally {
      finish.resolve();
      streamFinish.resolve();
      await app.close();
    }
  });
  it('exits normally on actual SIGTERM after real registry drain and real Runtime auth/logging shutdown hooks', async () => {
    // Process/lifecycle qualification only: unused resource ports throw, no SDK,
    // Owner or Guest is created and no Native continuity claim is made.
    const directory = mkdtempSync(join(tmpdir(), 'coordinator-sigterm-'));
    const script = `
      const {createRequire}=require('node:module'),p=require('node:path'),api=process.argv[1],root=process.argv[2];
      const req=createRequire(p.join(api,'apps/api/package.json'));
      require(p.join(api,'node_modules/reflect-metadata'));
      const {NestFactory}=req('@nestjs/core'),{Module,Global}=req('@nestjs/common');
      const {CoordinatorWorkRegistry,installCoordinatorWorkRegistry,CLOCK}=require(p.join(api,'packages/shared-kernel/dist'));
      const registry=new CoordinatorWorkRegistry();installCoordinatorWorkRegistry(registry);
      const {RuntimeApplicationService}=require(p.join(api,'packages/modules/runtime/dist/application/runtime-application.service'));
      const {AuthSessionStore}=require(p.join(api,'packages/modules/runtime/dist/application/auth-session.store'));
      const {LoggingModule}=require(p.join(api,'apps/api/dist/platform/logging/logging.module'));
      const {RUNTIME_LOG_WRITER}=require(p.join(api,'apps/api/dist/platform/logging/logging.tokens'));
      const clock={now:()=>new Date()},unused=new Proxy({},{get(){throw Error('UNEXPECTED_FIXTURE_RESOURCE_ACCESS')}});
      class ClockModule{};Global()(ClockModule);Module({providers:[{provide:CLOCK,useValue:clock}],exports:[CLOCK]})(ClockModule);
      class Fixture{};Module({imports:[ClockModule,LoggingModule.forRoot({dir:root,maxBytes:64,maxFiles:3})],providers:[{provide:RuntimeApplicationService,useFactory:()=>new RuntimeApplicationService(unused,unused,unused,new AuthSessionStore(),unused,unused,unused,clock,unused)}]})(Fixture);
      (async()=>{const app=await NestFactory.create(Fixture,{logger:false});app.enableShutdownHooks();await app.listen(0,'127.0.0.1');
        app.get(RUNTIME_LOG_WRITER).write('actual-final-line');registry.seal(['runtime.auth','platform.logging']);await registry.stop();
        if(registry.snapshot().state!=='drained')throw Error('FIXTURE_NOT_DRAINED');process.stdout.write('DRAINED\\n');
      })().catch(e=>{console.error(e);process.exit(1)});
    `;
    const child = spawn(process.execPath, ['-e', script, resolve('.'), directory], {
      env: { ...process.env, PLATFORM_PROCESS_ROLE: 'coordinator' },
      stdio: 'pipe',
    });
    let output = '',
      errors = '';
    child.stdout.on('data', (bytes) => {
      output += String(bytes);
    });
    child.stderr.on('data', (bytes) => {
      errors += String(bytes);
    });
    try {
      await new Promise<void>((ok, fail) => {
        const timeout = setTimeout(
          () => fail(new Error('SIGTERM_FIXTURE_START_TIMEOUT:' + errors)),
          5000,
        );
        child.stdout.on('data', () => {
          if (output.includes('DRAINED')) {
            clearTimeout(timeout);
            ok();
          }
        });
        child.once('exit', (code) => {
          clearTimeout(timeout);
          fail(new Error('SIGTERM_FIXTURE_EARLY_EXIT:' + code + ':' + errors));
        });
      });
      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((ok) =>
        child.once('exit', (code, signal) => ok({ code, signal })),
      );
      child.kill('SIGTERM');
      const result = await exited;
      expect(result.code === 0 || result.signal === 'SIGTERM').toBe(true);
      expect(errors).not.toContain('COORDINATOR_WORKER_DRAINING');
      expect(readFileSync(join(directory, 'runtime.log'), 'utf8')).toContain('actual-final-line');
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
