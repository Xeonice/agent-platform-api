import { assertDefined } from '../../support/assert-defined';
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { asAgentTaskId, asAutomationId, asProjectId, fromEpochMs } from '@platform/shared-kernel';
import type {
  JobChunk,
  JobHandle,
  SandboxHandle,
  ProviderRegistry,
  RuntimeBusinessAuthorityPort,
} from '@platform/contracts';
import { ProjectApplicationService } from '@platform/project';
import { Automation } from '../../../packages/modules/automation/src/domain/entities/automation.entity';
import { AutomationScheduler } from '../../../packages/modules/automation/src/application/automation.scheduler';
import { AutomationNotifier } from '../../../packages/modules/automation/src/application/automation.notifier';
import type { WebhookSender } from '../../../packages/modules/automation/src/domain/ports/webhook-sender.port';
import type { RunLogReader } from '../../../packages/modules/automation/src/domain/ports/run-log-reader.port';
import { SqliteAutomationRepository } from '../../../packages/modules/automation/src/infrastructure/persistence/sqlite/automation.repository.impl';
import { SqliteAutomationRunRepository } from '../../../packages/modules/automation/src/infrastructure/persistence/sqlite/automation-run.repository.impl';
import { SqliteAutomationLaunchIntents } from '../../../packages/modules/automation/src/infrastructure/persistence/sqlite/automation-launch-intents.impl';
import { SqliteAgentTaskStartIntents } from '../../../packages/modules/sandbox/src/infrastructure/persistence/sqlite/agent-task-start-intents.impl';
import {
  SqliteJobCompletionReceipts,
  completedJobHandleDigest,
  jobCompletionEvidenceDigest,
} from '../../../packages/modules/sandbox/src/infrastructure/persistence/sqlite/job-completion-receipts.impl';
import { AutomationTaskLauncherAdapter } from '../../../packages/modules/sandbox/src/application/automation-task-launcher.adapter';
import { AgentTaskApplicationService } from '../../../packages/modules/sandbox/src/application/agent-task.service';
import { RunAgentTaskWorkflow } from '../../../packages/modules/sandbox/src/application/workflows/run-agent-task.workflow';
import { RuntimeOwnerServer } from '../../../packages/modules/sandbox/src/infrastructure/runtime-rpc/owner-server';
import { RuntimeOwnerProviderRegistry } from '../../../packages/modules/sandbox/src/infrastructure/runtime-rpc/owner-client';
import {
  explicitRuntimeBusinessAuthority,
  withRuntimeBusinessAuthority,
} from '../../../packages/modules/sandbox/src/infrastructure/runtime-rpc/authority-context';
import { ownerRecord } from '../../../packages/modules/sandbox/src/infrastructure/runtime-rpc/wire-codec';
import { harness, waitForStatus } from '../../support/sandbox-rig';
import { deferred, unused, useEnv } from '../../support/strict-ports';
import { NoopAudit } from '../../support/automation-rig';

const authority: RuntimeBusinessAuthorityPort = {
  run: withRuntimeBusinessAuthority,
  current: explicitRuntimeBusinessAuthority,
};
const key = 'synthetic-automation-owner-isolated-key-not-production';
async function fixture() {
  const restore = useEnv({
    PLATFORM_INSTANCE_ID: 'automation-protocol-fixture',
    PLATFORM_PROCESS_ROLE: undefined,
  });
  let schedulingOwner: RuntimeOwnerProviderRegistry;
  const ownerScheduling = {
    snapshot: () => schedulingOwner.snapshot(),
    pin: (id: string, owner: string) => schedulingOwner.pin(id, owner),
    originalOwnerId: (id: string) => schedulingOwner.originalOwnerId(id),
    assertCurrent: (observation: Awaited<ReturnType<RuntimeOwnerProviderRegistry['snapshot']>>) =>
      schedulingOwner.assertCurrent(observation),
  };
  const h = harness({ authority, ownerScheduling, durableStarts: true });
  h.sqlite
    .prepare(
      "INSERT INTO projects(id,name,source_type,clone_status,baseline_path,created_at,updated_at) VALUES('prj-1','fixture','empty','ready','/tmp/aut-protocol',0,0)",
    )
    .run();
  h.advanceClock(60 * 60_000);
  const directory = await mkdtemp(join(tmpdir(), 'upg-automation-owner-'));
  const external: ProviderRegistry = {
    defaultProvider: h.provider.name,
    get: (name) => {
      if (name !== h.provider.name) throw new Error('fixture provider only');
      return h.provider;
    },
    has: (name) => name === h.provider.name,
    list: () => [h.provider],
    register: () => {
      throw new Error('fixture registry is fixed');
    },
  };
  const owner = new RuntimeOwnerServer({
    instanceId: 'automation-protocol-fixture',
    ownerId: 'original-guest-owner',
    startIdentity: 'original-guest-owner-start-identity',
    artifactIdentity: {
      artifactDigest: 'sha256:' + 'a'.repeat(64),
      inputFingerprint: 'sha256:' + 'b'.repeat(64),
    },
    capacity: async () => ({
      cores: 64,
      ramMb: 262144,
      diskTotalBytes: 4 * 1024 ** 4,
      diskAvailableBytes: 3 * 1024 ** 4,
    }),
    key,
    journalPath: join(directory, 'owner.sqlite'),
    registry: external,
    clock: h.clock,
  });
  const ownerRequests: { method: string; path: string }[] = [];
  owner.server.on('request', (request) =>
    ownerRequests.push({
      method: request.method ?? '',
      path: new URL(request.url ?? '/', 'http://127.0.0.1').pathname,
    }),
  );
  await owner.listen(0);
  const endpoint = `http://127.0.0.1:${(owner.server.address() as AddressInfo).port}`;
  const clients: RuntimeOwnerProviderRegistry[] = [];
  const workflows: RunAgentTaskWorkflow[] = [h.taskWorkflow];
  const connect = async (generation: number, deferClaim = false) => {
    const registry = new RuntimeOwnerProviderRegistry();
    await registry.addOwner(
      {
        endpoint,
        key,
        instanceId: 'automation-protocol-fixture',
        generation,
        clock: h.clock,
        deferClaim,
      },
      true,
    );
    clients.push(registry);
    return registry;
  };
  let remote = await connect(1);
  const bind = (registry: RuntimeOwnerProviderRegistry) => {
    schedulingOwner = registry;
    h.registry.get = (name) => registry.get(name);
    h.registry.has = (name) => registry.has(name);
    h.registry.list = () => registry.list();
  };
  bind(remote);
  const rules = new SqliteAutomationRepository(h.db);
  const runs = new SqliteAutomationRunRepository(h.db);
  const intents = new SqliteAutomationLaunchIntents(h.db);
  const starts = new SqliteAgentTaskStartIntents(h.db);
  const notifier = new AutomationNotifier(
    unused<WebhookSender>('webhook'),
    runs,
    unused<RunLogReader>('logs'),
    h.uow,
    unused<ProjectApplicationService>('projects'),
  );
  const adapter = (service = h.taskService) =>
    new AutomationTaskLauncherAdapter(
      h.service,
      service,
      h.repo,
      h.taskRepo,
      h.clock,
      h.uow,
      h.events,
      h.projectFacade,
      authority,
      starts,
    );
  const scheduler = (launcher = adapter()) =>
    new AutomationScheduler(
      rules,
      runs,
      launcher,
      { stateOf: async () => 'active' },
      h.uow,
      h.events,
      h.clock,
      { next: () => randomUUID() },
      new NoopAudit(),
      notifier,
      intents,
    );
  const rule = Automation.create({
    id: asAutomationId('aut-http-owner'),
    projectId: asProjectId('prj-1'),
    name: 'owner receipt',
    runtimeId: 'claude-code',
    prompt: 'one original guest job',
    scheduleKind: 'hourly',
    scheduleConfig: { minute: 0 },
    timezone: 'UTC',
    timeoutMinutes: 30,
    artifactRetentionDays: 7,
    now: fromEpochMs(h.clock.now().getTime() - 60 * 60_000),
  });
  h.uow.run((tx) => rules.saveSync(tx, rule));
  const replacement = async (generation: number, retainOriginal = false) => {
    const next = await connect(generation - 1, true);
    for (const workflow of workflows) workflow.shutdown();
    await remote.releaseBusinessAuthority();
    await next.activateBusinessAuthority(generation);
    remote = next;
    bind(next);
    if (retainOriginal) {
      h.taskWorkflow.resumeOwnership();
      return h.taskService;
    }
    const workflow = new RunAgentTaskWorkflow(
      h.taskRepo,
      h.repo,
      h.uow,
      h.events,
      h.clock,
      { next: () => randomUUID() },
      h.registry,
      h.runtimes,
      h.taskLogs,
      { publish: () => {} },
      authority,
      starts,
      new SqliteJobCompletionReceipts(h.db),
    );
    workflows.push(workflow);
    return new AgentTaskApplicationService(h.taskRepo, h.repo, h.registry, h.runtimes, workflow);
  };
  return {
    h,
    owner,
    ownerRequests,
    evidence: async () => {
      const response = await fetch(`${endpoint}/runtime/continuity`, {
        headers: {
          'x-platform-internal-key': key,
          'x-platform-instance-id': 'automation-protocol-fixture',
        },
      });
      expect(response.status).toBe(200);
      const data = ownerRecord(await response.json());
      if (!Array.isArray(data.operations)) throw new Error('owner operation inventory missing');
      return {
        operations: data.operations.map((value) => {
          const op = ownerRecord(value),
            actor = ownerRecord(op.actor);
          if (
            typeof op.id !== 'string' ||
            typeof op.method !== 'string' ||
            typeof op.state !== 'string' ||
            typeof actor.kind !== 'string' ||
            typeof actor.id !== 'string' ||
            typeof op.generation !== 'number' ||
            typeof op.fence !== 'number'
          )
            throw new Error('owner operation evidence invalid');
          return {
            id: op.id,
            method: op.method,
            state: op.state,
            generation: op.generation,
            fence: op.fence,
            actor: { kind: actor.kind, id: actor.id },
          };
        }),
      };
    },
    rules,
    runs,
    intents,
    starts,
    rule,
    adapter,
    scheduler,
    replacement,
    close: async () => {
      for (const workflow of workflows) workflow.shutdown();
      for (const job of h.provider.jobs.jobs.values()) job.finish(0);
      for (const client of clients) client.onModuleDestroy();
      await owner.close();
      restore();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

describe('REQ-UPG-001/006/008 — actual RuntimeOwner HTTP/journal and automation start recovery', () => {
  it('retained A starts a fresh pump at B’s persisted cursor and drops its original late read after A→B→A', async () => {
    const f = await fixture();
    const oldRead = deferred<JobChunk>();
    const bRead = deferred<JobChunk>();
    const restoredRead = deferred<JobChunk>();
    const cursors: (string | undefined)[] = [];
    let oldResponseReturned = false;
    try {
      // Only the external guest plane is a fixture. Both generations use the real
      // Owner HTTP, authority journal, application workflow and migrated SQLite.
      f.h.provider.jobs.readJob = async (
        _handle: SandboxHandle,
        _job: JobHandle,
        cursor?: string,
      ): Promise<JobChunk> => {
        cursors.push(cursor);
        if (cursors.length === 1) return oldRead.promise;
        if (cursors.length === 2)
          return {
            stdout: '{"type":"system","subtype":"init","session_id":"b-state"}\n',
            stderr: '',
            cursor: 'b-cursor',
            status: 'running',
          };
        if (cursors.length === 3) return bRead.promise;
        return restoredRead.promise;
      };
      await f.scheduler().runOnce();
      const run = assertDefined(await f.runs.findLatest(f.rule.id));
      const intent = assertDefined(await f.intents.find(run.id, 0));
      await waitForStatus(f.h.service, intent.sandboxId, 'running');
      const originalJobs = assertDefined(f.h.registry.get(f.h.provider.name).jobs);
      const originalRead = originalJobs.readJob.bind(originalJobs);
      originalJobs.readJob = async (...args) => {
        try {
          return await originalRead(...args);
        } finally {
          oldResponseReturned = true;
        }
      };
      await f.scheduler().runOnce();
      await vi.waitFor(() => expect(cursors).toHaveLength(1));
      const b = await f.replacement(2);
      await b.resumeRunning();
      await vi.waitFor(() => expect(cursors).toHaveLength(3));
      const progressed = assertDefined(await f.h.taskRepo.findById(asAgentTaskId(intent.taskId)));
      expect(progressed.cursor).toBe('b-cursor');
      expect(progressed.lastSeq).toBeGreaterThan(0);
      const a = await f.replacement(3, true);
      await a.resumeRunning();
      await vi.waitFor(() => expect(cursors).toHaveLength(4));
      expect(cursors[3]).toBe('b-cursor');
      oldRead.resolve({
        stdout: '{"type":"system","subtype":"init","session_id":"a-stale"}\n',
        stderr: '',
        cursor: 'a-stale',
        status: 'running',
      });
      await vi.waitFor(() => expect(oldResponseReturned).toBe(true));
      const after = assertDefined(await f.h.taskRepo.findById(asAgentTaskId(intent.taskId)));
      expect({ cursor: after.cursor, seq: after.lastSeq, bytes: after.stdoutBytes }).toEqual({
        cursor: progressed.cursor,
        seq: progressed.lastSeq,
        bytes: progressed.stdoutBytes,
      });
      await a.resumeRunning();
      expect(cursors).toHaveLength(4); // Old finally must not delete the new A pump.
      expect(f.h.provider.jobs.jobs.size).toBe(1);
      expect(f.h.provider.calls).not.toContain('stop');
      expect(f.h.provider.calls).not.toContain('destroy');
      expect(f.h.provider.jobs.released).toEqual([]);
    } finally {
      f.h.taskWorkflow.shutdown();
      const terminal: JobChunk = {
        stdout: '',
        stderr: '',
        cursor: 'close',
        status: 'exited',
        exitCode: 0,
      };
      oldRead.resolve(terminal);
      bRead.resolve(terminal);
      restoredRead.resolve(terminal);
      await f.close();
    }
  });
  it('lost acknowledgement then new writer and rollback writer confirm the same completed owner receipt and original job exactly once', async () => {
    const f = await fixture();
    try {
      await f.scheduler().runOnce();
      const run = assertDefined(await f.runs.findLatest(f.rule.id));
      const intent = assertDefined(await f.intents.find(run.id, 0));
      await waitForStatus(f.h.service, intent.sandboxId, 'running');
      const jobs = assertDefined(f.h.registry.get(f.h.provider.name).jobs);
      const originalStart = jobs.startJob.bind(jobs);
      jobs.startJob = async (...args) => {
        await originalStart(...args);
        throw new Error('completed owner HTTP acknowledgement lost');
      };
      await f.scheduler().runOnce();
      expect(f.h.provider.jobs.jobs.size).toBe(1);
      expect(f.h.sqlite.prepare('SELECT count(*) AS n FROM agent_tasks').get()).toEqual({ n: 0 });
      expect(await f.adapter().phaseOf(intent.sandboxId)).toEqual({ kind: 'unconfirmed' });
      const before = await f.evidence();
      const dispatches = f.ownerRequests.filter(
        (row) => row.method === 'POST' && row.path === '/runtime/call',
      ).length;
      expect(before.operations.filter((v) => v.method === 'jobs.startJob')).toHaveLength(1);
      expect(before.operations.find((v) => v.method === 'jobs.startJob')).toMatchObject({
        state: 'complete',
        actor: { kind: 'automation', id: run.id },
      });
      const fresh = await f.replacement(2);
      await fresh.resumeRunning();
      expect(
        f.ownerRequests.filter((row) => row.method === 'POST' && row.path === '/runtime/call'),
      ).toHaveLength(dispatches);
      expect(
        f.ownerRequests.some(
          (row) => row.method === 'GET' && row.path.startsWith('/runtime/operations/'),
        ),
      ).toBe(true);
      expect(f.h.sqlite.prepare('SELECT id FROM agent_tasks').all()).toEqual([
        { id: intent.taskId },
      ]);
      expect(f.h.provider.jobs.jobs.size).toBe(1);
      await f.scheduler(f.adapter(fresh)).runOnce();
      const rollbackWriter = await f.replacement(3);
      await rollbackWriter.resumeRunning();
      await f.scheduler(f.adapter(rollbackWriter)).runOnce();
      expect(f.h.provider.jobs.jobs.size).toBe(1);
      expect((await f.runs.findById(run.id))?.sandboxId).toBe(intent.sandboxId);
      expect(f.h.provider.calls.filter((v) => v === 'create')).toHaveLength(1);
      expect(f.h.provider.calls).not.toContain('stop');
      expect(f.h.provider.calls).not.toContain('destroy');
      expect(f.h.provider.jobs.released).toEqual([]);
      expect(
        (await f.evidence()).operations.filter((v) => v.method === 'jobs.startJob'),
      ).toHaveLength(1);
      for (const job of f.h.provider.jobs.jobs.values()) job.finish(0);
      await vi.waitFor(async () =>
        expect((await rollbackWriter.get(intent.sandboxId, intent.taskId)).status).toBe(
          'succeeded',
        ),
      );
      const proof = await f.h.jobCompletions.find(intent.taskId);
      const finalized = assertDefined(await f.h.taskRepo.findById(asAgentTaskId(intent.taskId)));
      expect(proof).toMatchObject({
        taskId: intent.taskId,
        sandboxId: intent.sandboxId,
        exitKind: 'natural',
        exitCode: 0,
        jobHandleDigest: completedJobHandleDigest(finalized.jobHandle),
        lastSeq: finalized.lastSeq,
        cursor: finalized.cursor,
      });
      expect(proof?.evidenceDigest).toBe(jobCompletionEvidenceDigest(assertDefined(proof)));
      expect(f.h.provider.jobs.jobs.size).toBe(1);
    } finally {
      await f.close();
    }
  });

  it('owner records an uncertain guest start; repeated observations and replacement never reexecute or tear down that job', async () => {
    const f = await fixture();
    try {
      await f.scheduler().runOnce();
      const run = assertDefined(await f.runs.findLatest(f.rule.id));
      const intent = assertDefined(await f.intents.find(run.id, 0));
      await waitForStatus(f.h.service, intent.sandboxId, 'running');
      const externalStart = f.h.provider.jobs.startJob.bind(f.h.provider.jobs);
      f.h.provider.jobs.startJob = async (...args) => {
        await externalStart(...args);
        throw new Error('external guest response unknown');
      };
      await f.scheduler().runOnce();
      expect(f.h.provider.jobs.jobs.size).toBe(1);
      const dispatches = f.ownerRequests.filter(
        (row) => row.method === 'POST' && row.path === '/runtime/call',
      ).length;
      await f.h.taskService.resumeRunning();
      await f.scheduler().runOnce();
      const fresh = await f.replacement(2);
      await fresh.resumeRunning();
      await fresh.resumeRunning();
      const launcher = f.adapter(fresh);
      await f.scheduler(launcher).runOnce();
      await launcher.reconcileFinished();
      expect(
        f.ownerRequests.filter((row) => row.method === 'POST' && row.path === '/runtime/call'),
      ).toHaveLength(dispatches);
      expect(
        f.ownerRequests.filter(
          (row) => row.method === 'GET' && row.path.startsWith('/runtime/operations/'),
        ).length,
      ).toBeGreaterThan(3);
      expect(f.h.provider.jobs.jobs.size).toBe(1);
      expect(f.h.sqlite.prepare('SELECT count(*) AS n FROM agent_tasks').get()).toEqual({ n: 0 });
      expect(await launcher.phaseOf(intent.sandboxId)).toEqual({ kind: 'unconfirmed' });
      expect((await f.runs.findById(run.id))?.status).toBe('running');
      expect((await f.rules.findById(f.rule.id))?.failureCount).toBe(0);
      const proof = await f.evidence();
      expect(proof.operations.filter((v) => v.method === 'jobs.startJob')).toHaveLength(1);
      expect(proof.operations.find((v) => v.method === 'jobs.startJob')?.state).toBe('unknown');
      expect(f.h.provider.calls).not.toContain('stop');
      expect(f.h.provider.calls).not.toContain('destroy');
      expect(f.h.provider.jobs.released).toEqual([]);
      expect(await f.h.jobCompletions.find(intent.taskId)).toBeNull();
    } finally {
      await f.close();
    }
  });
});
