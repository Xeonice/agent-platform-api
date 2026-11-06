import 'reflect-metadata';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CoordinatorWorker, type Clock } from '@platform/shared-kernel';
import type {
  ProviderRegistry,
  SandboxExecFn,
  SandboxExecPort,
  SandboxProvider,
} from '@platform/contracts';
import { RuntimeOwnerServer } from '../../../packages/modules/sandbox/src/infrastructure/runtime-rpc/owner-server';
import { RuntimeOwnerProviderRegistry } from '../../../packages/modules/sandbox/src/infrastructure/runtime-rpc/owner-client';
import { UpgradeStore } from '../../../apps/api/src/platform/upgrade/upgrade-store';
import { UpgradeInspector } from '../../../apps/api/src/platform/upgrade/upgrade-inspector';
import { UpgradeOnlineMigration } from '../../../apps/api/src/platform/upgrade/upgrade-online-migration';
import { CoordinatorHandoffBudget } from '../../../apps/api/src/platform/upgrade/coordinator-handoff-budget';
import { freezeUpgradePlan } from '../../../apps/api/src/platform/upgrade/upgrade-trust';
import { planFixtureEnvelope, planFixtureSource } from '../../support/upgrade-plan-fixture';
import { deferred, unused, useEnv } from '../../support/strict-ports';

const clock: Clock = { now: () => new Date() };
const key = 'isolated-continuity-owner-http-test-key';
const instanceId = 'continuity-budget-instance';
const proof = '711:$2:1001';
const closeFixtures: (() => Promise<void>)[] = [];
type ExecResult = Awaited<ReturnType<SandboxExecFn>>;

/** Explicit external exec port: there is no actual Guest, tmux or PTY here. */
function externalExec(controlled: boolean, badTerminal?: string) {
  const pending = new Map<string, ReturnType<typeof deferred<ExecResult>>>();
  const calls: { sandboxId: string; command: string[]; timeoutMs: number | undefined }[] = [];
  let active = 0;
  let maximum = 0;
  const result = (sandboxId: string): ExecResult => ({
    stdout: sandboxId === badTerminal ? '712:$2:1001\n' : proof + '\n',
    stderr: '',
    exitCode: 0,
  });
  const port: SandboxExecPort = {
    execFor: async (sandboxId) => {
      const execute: SandboxExecFn = async (command, options) => {
        calls.push({ sandboxId, command, timeoutMs: options?.timeoutMs });
        active++;
        maximum = Math.max(maximum, active);
        try {
          if (!controlled) return result(sandboxId);
          const gate = deferred<ExecResult>();
          pending.set(sandboxId, gate);
          return await gate.promise;
        } finally {
          pending.delete(sandboxId);
          active--;
        }
      };
      return execute;
    },
    bindingOf: async () => {
      throw new Error('Runtime binding is outside the continuity exec port scenario');
    },
  };
  return {
    port,
    calls,
    get active() {
      return active;
    },
    get maximum() {
      return maximum;
    },
    complete(sandboxId: string) {
      const gate = pending.get(sandboxId);
      if (!gate) throw new Error('Expected an actual pending external exec');
      gate.resolve(result(sandboxId));
    },
    completeAll() {
      for (const [sandboxId, gate] of pending) gate.resolve(result(sandboxId));
    },
  };
}

async function fixture(options: { controlled?: boolean; badTerminal?: string } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'handoff-continuity-budget-'));
  const restore = useEnv({
    PLATFORM_INSTANCE_ID: instanceId,
    PLATFORM_COORDINATOR_RPC_KEY: key,
    PLATFORM_PROCESS_ROLE: undefined,
    COORDINATOR_WRITER_FENCE_VALID: undefined,
  });
  const sqlite = new Database(join(home, 'platform.sqlite'));
  const exec = externalExec(options.controlled === true, options.badTerminal);
  const lifecycle: { owner?: RuntimeOwnerServer } = {};
  const remote = new RuntimeOwnerProviderRegistry();
  closeFixtures.push(async () => {
    exec.completeAll();
    remote.onModuleDestroy();
    await lifecycle.owner?.close();
    sqlite.close();
    restore();
    await rm(home, { recursive: true, force: true });
  });
  sqlite.pragma('journal_mode = WAL');
  migrate(drizzle(sqlite), { migrationsFolder: resolve('drizzle') });
  const store = new UpgradeStore(sqlite, clock, { next: randomUUID });
  const schema = (
    sqlite.prepare('SELECT count(*) n FROM __drizzle_migrations').get() as { n: number }
  ).n;
  const source = planFixtureSource(schema);
  const envelope = planFixtureEnvelope(source, '0.2.1');
  store.bootstrap(source);
  const accepted = store.accept(
    'continuity-test-actor',
    {
      requestId: randomUUID(),
      targetReleaseId: envelope.manifest.releaseId,
      targetDigest: envelope.manifestDigest,
      expectedActivationGeneration: 1,
    },
    envelope,
    freezeUpgradePlan(envelope, source),
  );
  const { fence } = store.claim(accepted.attemptId, 'continuity-controller', 30000);
  const state = { badResource: '' };
  // These are external resource observations with deliberately synthetic
  // identities. The real Owner protocol and private journal surround this port.
  const external: SandboxProvider = {
    name: 'continuity-external-port',
    capabilities: {
      spawnTty: false,
      volumeMount: false,
      updateResources: false,
      pauseResume: false,
      snapshot: false,
      watchEvents: false,
      headlessTask: false,
    },
    create: async (context) => ({
      provider: 'continuity-external-port',
      providerSandboxId: 'external-' + context.sandboxId,
    }),
    inspect: async (handle) => ({
      lifecycleState: 'instance_running',
      raw: {
        runtimeIdentity:
          handle.providerSandboxId === 'external-' + state.badResource
            ? 'changed-external-runtime'
            : 'external-runtime/' + handle.providerSandboxId,
      },
    }),
    start: async () => {
      throw new Error('No Guest start is part of this external port fixture');
    },
    stop: async () => {
      throw new Error('No Guest stop is part of this external port fixture');
    },
    destroy: async () => {
      throw new Error('No Guest destroy is part of this external port fixture');
    },
    spawn: async () => {
      throw new Error('The separate explicit exec port supplies terminal observations');
    },
  };
  const providers: ProviderRegistry = {
    defaultProvider: external.name,
    get: (name) => {
      if (name !== external.name) throw new Error('Unknown external fixture provider');
      return external;
    },
    has: (name) => name === external.name,
    list: () => [external],
    register: () => {
      throw new Error('External resource port is fixed');
    },
  };
  const owner = new RuntimeOwnerServer({
    instanceId,
    ownerId: 'continuity-owner',
    key,
    clock,
    journalPath: join(home, 'owner.sqlite'),
    registry: providers,
  });
  lifecycle.owner = owner;
  const ownerRequests: string[] = [];
  owner.server.on('request', (request) => ownerRequests.push(request.url ?? ''));
  await owner.listen(0);
  await remote.addOwner(
    {
      endpoint: `http://127.0.0.1:${(owner.server.address() as AddressInfo).port}`,
      instanceId,
      key,
      generation: 1,
      clock,
    },
    true,
  );
  const sandboxIds = Array.from({ length: 6 }, (_, i) => 'continuity-sandbox-' + String(i));
  for (const sandboxId of sandboxIds) {
    remote.pin(sandboxId, remote.activeOwnerId);
    const handle = await remote.get(external.name).create({
      sandboxId,
      quota: { cores: 1, ramMb: 128, diskMb: 100 },
      image: { ref: 'external-port@sha256:' + 'a'.repeat(64), digest: 'sha256:' + 'a'.repeat(64) },
      env: {},
    });
    const now = clock.now().getTime();
    sqlite
      .prepare(
        "INSERT INTO sandboxes(id,project_id,runtime,status,headless,provider,provider_handle,provider_state,created_at,updated_at) VALUES(?,?,?,'running',0,?,?,?,?,?)",
      )
      .run(
        sandboxId,
        'continuity-project',
        'claude-code',
        external.name,
        handle.providerSandboxId,
        JSON.stringify(handle.providerState),
        now,
        now,
      );
    sqlite
      .prepare(
        "INSERT INTO terminal_bookmarks(terminal_identity,sandbox_id,kind,private_session_id,runtime_identity) VALUES(?,?,'shell',?,?)",
      )
      .run(
        'terminal-' + sandboxId,
        sandboxId,
        'session-' + sandboxId,
        'external-runtime/' + handle.providerSandboxId + '/tmux:' + proof,
      );
  }
  const inspector = new UpgradeInspector(
    store,
    clock,
    remote,
    new UpgradeOnlineMigration(store, clock),
    unused('authentication evidence'),
    unused('passcode service'),
    unused('job completion receipts'),
    exec.port,
    unused('traffic probe evidence'),
  );
  inspector.recordBaseline(accepted.attemptId, {
    resources: await inspector.resources(),
    tasks: [],
    automations: [],
    terminals: sqlite.prepare('SELECT * FROM terminal_bookmarks ORDER BY terminal_identity').all(),
    transitionsAfter: 0,
    auditAfter: 0,
    observedAt: clock.now().toISOString(),
  });
  const worker = new CoordinatorWorker('test.handoff-continuity');
  return {
    inspector,
    attemptId: accepted.attemptId,
    fence,
    sandboxIds,
    exec,
    worker,
    state,
    ownerRequests,
    budget: (ms = 2000) =>
      new CoordinatorHandoffBudget(clock.now().getTime() + ms, clock, (work) => worker.run(work)),
  };
}

afterEach(async () => {
  for (const close of closeFixtures.splice(0).reverse()) await close();
});

describe('actual UpgradeInspector continuity uses one handoff budget', () => {
  it('checks six terminals in a replenished pool of four and obtains real HTTP Owner audit', async () => {
    const f = await fixture({ controlled: true });
    const work = f.inspector.continuity(f.attemptId, f.fence, f.budget());
    try {
      await vi.waitFor(() => expect(f.exec.calls).toHaveLength(4));
      expect(f.exec.active).toBe(4);
      expect(f.exec.maximum).toBe(4);
      f.exec.complete(f.exec.calls[0].sandboxId);
      await vi.waitFor(() => expect(f.exec.calls).toHaveLength(5));
      expect(f.exec.active).toBe(4);
      f.exec.complete(f.exec.calls[1].sandboxId);
      await vi.waitFor(() => expect(f.exec.calls).toHaveLength(6));
      expect(f.exec.maximum).toBe(4);
      f.exec.completeAll();
      const result = await work;
      expect(result).toMatchObject({ qualified: true, reasons: [] });
      expect(result.resources).toHaveLength(6);
      expect(result.owner).toMatchObject({ instanceId, activeOwnerId: 'continuity-owner' });
      expect(f.ownerRequests).toContain('/runtime/continuity');
      expect(f.ownerRequests.filter((path) => path === '/runtime/metadata').length).toBeGreaterThan(
        1,
      );
      expect(f.exec.calls.every((call) => call.command[0] === 'tmux')).toBe(true);
      expect(
        f.exec.calls.every((call) => Number(call.timeoutMs) > 0 && Number(call.timeoutMs) <= 2000),
      ).toBe(true);
      expect(f.worker.snapshot().active).toBe(0);
    } finally {
      f.exec.completeAll();
      await work.catch(() => undefined);
    }
  });

  it('keeps a single changed terminal identity unqualified after all six probes finish', async () => {
    const f = await fixture({ badTerminal: 'continuity-sandbox-4' });
    const result = await f.inspector.continuity(f.attemptId, f.fence, f.budget());
    expect(result.qualified).toBe(false);
    expect(result.reasons).toContain('ORIGINAL_TERMINAL_IDENTITY_CHANGED');
    expect(f.exec.calls).toHaveLength(6);
    expect(f.worker.snapshot().active).toBe(0);
  });

  it('keeps a changed original external runtime identity unqualified', async () => {
    const f = await fixture();
    f.state.badResource = 'continuity-sandbox-3';
    const result = await f.inspector.continuity(f.attemptId, f.fence, f.budget());
    expect(result.qualified).toBe(false);
    expect(result.reasons).toContain('ORIGINAL_RUNTIME_UNCONFIRMED');
    expect(f.exec.calls).toHaveLength(6);
  });

  it('retains timed-out original exec Promises until they actually settle and never returns late qualification', async () => {
    const f = await fixture({ controlled: true });
    let qualifiedReturns = 0;
    const budget = f.budget(150);
    const work = f.inspector.continuity(f.attemptId, f.fence, budget).then((result) => {
      if (result.qualified === true) qualifiedReturns++;
      return result;
    });
    const rejected = expect(work).rejects.toMatchObject({
      code: 'HANDOFF_CONTROL_BUDGET_EXCEEDED',
    });
    try {
      await vi.waitFor(() => expect(f.exec.calls).toHaveLength(4));
      await rejected;
      expect(budget.signal.aborted).toBe(true);
      expect(f.worker.snapshot().active).toBe(4);
      expect(f.exec.active).toBe(4);
      await f.worker.stop();
      expect(f.worker.snapshot()).toMatchObject({ active: 4, stopped: true });
      f.exec.completeAll();
      await vi.waitFor(() => expect(f.worker.snapshot().active).toBe(0));
      expect(f.exec.active).toBe(0);
      expect(f.exec.calls).toHaveLength(4);
      expect(qualifiedReturns).toBe(0);
      await rejected;
    } finally {
      f.exec.completeAll();
      await rejected;
    }
  });
});
