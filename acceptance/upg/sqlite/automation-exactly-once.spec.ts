import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  asAutomationId,
  asSandboxId,
  asProjectId,
  fromEpochMs,
  type Tx,
  type BusinessWriterAuthority,
} from '@platform/shared-kernel';
import type { AutomationTaskLauncher } from '@platform/contracts';
import { ProjectApplicationService } from '@platform/project';
import { AutomationScheduler } from '../../../packages/modules/automation/src/application/automation.scheduler';
import { AutomationNotifier } from '../../../packages/modules/automation/src/application/automation.notifier';
import { Automation } from '../../../packages/modules/automation/src/domain/entities/automation.entity';
import type { AutomationRun } from '../../../packages/modules/automation/src/domain/entities/automation-run.entity';
import type { WebhookSender } from '../../../packages/modules/automation/src/domain/ports/webhook-sender.port';
import type { RunLogReader } from '../../../packages/modules/automation/src/domain/ports/run-log-reader.port';
import { SqliteAutomationRepository } from '../../../packages/modules/automation/src/infrastructure/persistence/sqlite/automation.repository.impl';
import { SqliteAutomationRunRepository } from '../../../packages/modules/automation/src/infrastructure/persistence/sqlite/automation-run.repository.impl';
import { SqliteAutomationLaunchIntents } from '../../../packages/modules/automation/src/infrastructure/persistence/sqlite/automation-launch-intents.impl';
import { SqliteAgentTaskStartIntents } from '../../../packages/modules/sandbox/src/infrastructure/persistence/sqlite/agent-task-start-intents.impl';
import { AutomationTaskLauncherAdapter } from '../../../packages/modules/sandbox/src/application/automation-task-launcher.adapter';
import { harness, waitForStatus } from '../../support/sandbox-rig';
import { deferred, unused, useEnv } from '../../support/strict-ports';
import { NoopAudit } from '../../support/automation-rig';
import {
  fenceCoordinatorConnection,
  coordinatorWriterControl,
} from '../../../apps/api/src/platform/persistence/coordinator-lease';

// Real scheduler, adapter, normal sandbox/task services, SQLite and committed
// migrations. Only the external guest/provider boundary is the declared fixture.
// Native BoxLite/KVM and transport receipts have separate protocol/native gates.
function fixture() {
  const h = harness({ durableStarts: true });
  h.sqlite
    .prepare(
      "INSERT INTO projects(id,name,source_type,clone_status,baseline_path,created_at,updated_at) VALUES('prj-1','fixture','empty','ready','/tmp/upg-fixture-project',0,0)",
    )
    .run();
  const rules = new SqliteAutomationRepository(h.db);
  const runs = new SqliteAutomationRunRepository(h.db);
  const intents = new SqliteAutomationLaunchIntents(h.db);
  const launcher = new AutomationTaskLauncherAdapter(
    h.service,
    h.taskService,
    h.repo,
    h.taskRepo,
    h.clock,
    h.uow,
    h.events,
    h.projectFacade,
    undefined,
    new SqliteAgentTaskStartIntents(h.db),
  );
  const notifier = new AutomationNotifier(
    unused<WebhookSender>('webhook'),
    runs,
    unused<RunLogReader>('log'),
    h.uow,
    unused<ProjectApplicationService>('project'),
  );
  const scheduler = (
    launch: AutomationTaskLauncher = launcher,
    runRepo = runs,
    writer?: BusinessWriterAuthority,
  ) =>
    new AutomationScheduler(
      rules,
      runRepo,
      launch,
      { stateOf: async () => 'active' },
      h.uow,
      h.events,
      h.clock,
      { next: () => randomUUID() },
      new NoopAudit(),
      notifier,
      intents,
      writer,
    );
  const rule = Automation.create({
    id: asAutomationId('aut-upgrade-fixture'),
    projectId: asProjectId('prj-1'),
    name: 'hourly',
    runtimeId: 'claude-code',
    prompt: 'original frozen prompt',
    scheduleKind: 'hourly',
    scheduleConfig: { minute: 0 },
    timezone: 'UTC',
    timeoutMinutes: 30,
    artifactRetentionDays: 7,
    now: h.clock.now(),
  });
  h.uow.run((tx) => rules.saveSync(tx, rule));
  h.advanceClock(60 * 60_000);
  return { h, rules, runs, intents, launcher, scheduler, rule };
}

describe('REQ-UPG-001/006/008 — persisted automation occurrences and accepted launch identity', () => {
  it('a retained A sweep cannot overwrite B’s completed original run when A’s old accepted create acknowledgement arrives after rollback ownership', async () => {
    const f = fixture();
    const original = coordinatorWriterControl(
      fenceCoordinatorConnection(f.h.sqlite, 'late-sweep-writer-fixture', f.h.clock, {
        next: () => randomUUID(),
      }),
    );
    const entered = deferred<void>();
    const ack = deferred<void>();
    const delayed: AutomationTaskLauncher = {
      capacityFor: (input) => f.launcher.capacityFor(input),
      createSandbox: async (input) => {
        const result = await f.launcher.createSandbox(input);
        entered.resolve();
        await ack.promise;
        return result;
      },
      startTask: (id, input) => f.launcher.startTask(id, input),
      phaseOf: (id) => f.launcher.phaseOf(id),
      finishTask: (id, input) => f.launcher.finishTask(id, input),
    };
    const a = f.scheduler(delayed, f.runs, original);
    const oldSweep = a.runOnce();
    let next: ReturnType<typeof coordinatorWriterControl> | undefined;
    let b: AutomationScheduler | undefined;
    try {
      await entered.promise;
      const run = (await f.runs.findLatest(f.rule.id))!;
      const intent = (await f.intents.find(run.id, 0))!;
      await waitForStatus(f.h.service, intent.sandboxId, 'running');
      a.pauseOwnership();
      original.release();
      next = coordinatorWriterControl(
        fenceCoordinatorConnection(f.h.sqlite, 'late-sweep-writer-fixture', f.h.clock, {
          next: () => randomUUID(),
        }),
      );
      b = f.scheduler(f.launcher, new SqliteAutomationRunRepository(f.h.db), next);
      await b.runOnce(); // Restore original pending create reservation.
      await b.runOnce(); // Start the original accepted task once.
      expect(f.h.provider.jobs.jobs.size).toBe(1);
      [...f.h.provider.jobs.jobs.values()][0].finish(0);
      await vi.waitFor(async () =>
        expect((await f.h.taskService.get(intent.sandboxId, intent.taskId)).status).toBe(
          'succeeded',
        ),
      );
      await b.runOnce();
      const completed = (await f.runs.findById(run.id))!;
      expect(completed.status).toBe('success');
      expect(completed.outcomeApplied).toBe(true);
      const stable = {
        status: completed.status,
        at: completed.completedAt,
        applied: completed.outcomeApplied,
      };
      b.pauseOwnership();
      next.release();
      expect(original.reacquire()).toBeGreaterThan(next.generation);
      a.resumeOwnership();
      ack.resolve();
      await oldSweep;
      const after = (await f.runs.findById(run.id))!;
      expect({
        status: after.status,
        at: after.completedAt,
        applied: after.outcomeApplied,
      }).toEqual(stable);
      expect(f.h.provider.jobs.jobs.size).toBe(1);
      expect(
        f.h.sqlite.prepare('SELECT count(*) AS n FROM automation_cron_occurrences').get(),
      ).toEqual({ n: 1 });
    } finally {
      ack.resolve();
      await oldSweep;
      a.pauseOwnership();
      b?.pauseOwnership();
      try {
        original.release();
      } catch {
        /* Already retired. */
      }
      try {
        next?.release();
      } catch {
        /* Already retired. */
      }
    }
  });
  it('a due timer crosses actual SQLite writer epochs and an old Coordinator resumes under a higher rollback epoch without duplicate prompt/job', async () => {
    const restore = useEnv({
      COORDINATOR_GENERATION: undefined,
      COORDINATOR_WRITER_FENCE_VALID: undefined,
      DISABLE_AUTOMATION_SCHEDULER: undefined,
    });
    const f = fixture();
    vi.useFakeTimers();
    let next: ReturnType<typeof coordinatorWriterControl> | undefined;
    const original = coordinatorWriterControl(
      fenceCoordinatorConnection(f.h.sqlite, 'timer-writer-fixture', f.h.clock, {
        next: () => randomUUID(),
      }),
    );
    const oldScheduler = f.scheduler(f.launcher, f.runs, original);
    let newScheduler: AutomationScheduler | undefined;
    const tick = async () => {
      for (let i = 0; i < 12; i++) {
        f.h.advanceClock(5000);
        await vi.advanceTimersByTimeAsync(5000);
      }
    };
    const prompts: string[][] = [];
    const start = f.h.provider.jobs.startJob.bind(f.h.provider.jobs);
    f.h.provider.jobs.startJob = (handle, spec) => {
      prompts.push(spec.cmd);
      return start(handle, spec);
    };
    try {
      oldScheduler.onApplicationBootstrap();
      await tick();
      const run = (await f.runs.findLatest(f.rule.id))!;
      const intent = (await f.intents.find(run.id, 0))!;
      expect(run.sandboxId).toBe(intent.sandboxId);
      expect(f.h.provider.calls.filter((v) => v === 'create')).toHaveLength(1);
      original.release();
      next = coordinatorWriterControl(
        fenceCoordinatorConnection(f.h.sqlite, 'timer-writer-fixture', f.h.clock, {
          next: () => randomUUID(),
        }),
      );
      expect(next.generation).toBeGreaterThan(original.generation);
      await expect(oldScheduler.runOnce()).rejects.toThrow('COORDINATOR_WRITER_FENCE_EXPIRED');
      oldScheduler.pauseOwnership();
      expect(await oldScheduler.runOnce()).toBe(0);
      newScheduler = f.scheduler(f.launcher, new SqliteAutomationRunRepository(f.h.db), next);
      newScheduler.onApplicationBootstrap();
      await tick();
      expect(f.h.provider.jobs.jobs.size).toBe(1);
      expect(f.h.sqlite.prepare('SELECT id FROM agent_tasks').all()).toEqual([
        { id: intent.taskId },
      ]);
      newScheduler.pauseOwnership();
      next.release();
      const rollbackGeneration = original.reacquire();
      expect(rollbackGeneration).toBeGreaterThan(next.generation);
      oldScheduler.resumeOwnership();
      await tick();
      expect(f.h.provider.jobs.jobs.size).toBe(1);
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toContain('original frozen prompt');
      expect(
        f.h.sqlite.prepare('SELECT count(*) AS n FROM automation_cron_occurrences').get(),
      ).toEqual({ n: 1 });
      expect(f.h.provider.calls).not.toContain('stop');
      expect(f.h.provider.calls).not.toContain('destroy');
    } finally {
      oldScheduler.pauseOwnership();
      newScheduler?.pauseOwnership();
      try {
        original.release();
      } catch {
        /* Retired epochs are intentionally fenced. */
      }
      try {
        next?.release();
      } catch {
        /* Retired epochs are intentionally fenced. */
      }
      vi.useRealTimers();
      restore();
    }
  });
  it('a crash inside trigger/run reservation rolls back the slot and a replacement scheduler produces exactly one occurrence', async () => {
    const f = fixture();
    class CrashAfterRunWrite extends SqliteAutomationRunRepository {
      override saveSync(tx: Tx, run: AutomationRun): void {
        super.saveSync(tx, run);
        throw new Error('simulated crash before intent commit');
      }
    }
    const due = (await f.rules.findById(f.rule.id))!.nextTriggerAt;
    await f.scheduler(f.launcher, new CrashAfterRunWrite(f.h.db)).runOnce();
    expect((await f.rules.findById(f.rule.id))!.nextTriggerAt).toEqual(due);
    expect(f.h.sqlite.prepare('SELECT count(*) AS n FROM automation_runs').get()).toEqual({ n: 0 });
    expect(
      f.h.sqlite.prepare('SELECT count(*) AS n FROM automation_cron_occurrences').get(),
    ).toEqual({ n: 0 });
    expect(f.h.sqlite.prepare('SELECT count(*) AS n FROM automation_launch_intents').get()).toEqual(
      { n: 0 },
    );
    expect(f.h.provider.calls).not.toContain('create');
    await f.scheduler().runOnce();
    const run = (await f.runs.findLatest(f.rule.id))!;
    await waitForStatus(f.h.service, run.sandboxId!, 'running');
    expect(
      f.h.sqlite.prepare('SELECT count(*) AS n FROM automation_cron_occurrences').get(),
    ).toEqual({ n: 1 });
    expect(f.h.sqlite.prepare('SELECT count(*) AS n FROM automation_runs').get()).toEqual({ n: 1 });
    expect((await f.intents.find(run.id, 0))?.sandboxId).toBe(run.sandboxId);
    expect(f.h.provider.calls.filter((v) => v === 'create')).toHaveLength(1);
  });

  it('lost create acknowledgement and a rule edit restore the original sandbox and frozen input instead of creating another', async () => {
    const f = fixture();
    const lostAck: AutomationTaskLauncher = {
      capacityFor: (input) => f.launcher.capacityFor(input),
      createSandbox: async (input) => {
        await f.launcher.createSandbox(input);
        throw new Error('create response lost');
      },
      startTask: (id, input) => f.launcher.startTask(id, input),
      phaseOf: (id) => f.launcher.phaseOf(id),
      finishTask: (id, input) => f.launcher.finishTask(id, input),
    };
    await f.scheduler(lostAck).runOnce();
    const original = (await f.runs.findLatest(f.rule.id))!;
    expect(original).toMatchObject({ status: 'pending', sandboxId: null, outcomeApplied: false });
    const intent = (await f.intents.find(original.id, 0))!;
    await waitForStatus(f.h.service, intent.sandboxId, 'running');
    const edited = (await f.rules.findById(f.rule.id))!;
    edited.update(
      { prompt: 'a new prompt must not replace this accepted occurrence' },
      f.h.clock.now(),
    );
    f.h.uow.run((tx) => f.rules.saveSync(tx, edited));
    const replacement = f.scheduler();
    await replacement.runOnce();
    expect((await f.runs.findById(original.id))?.sandboxId).toBe(intent.sandboxId);
    expect(f.h.provider.calls.filter((v) => v === 'create')).toHaveLength(1);
    expect((await f.h.repo.findById(asSandboxId(intent.sandboxId)))?.initialTask.prompt).toBe(
      'original frozen prompt',
    );
    expect(f.h.sqlite.prepare('SELECT count(*) AS n FROM sandboxes').get()).toEqual({ n: 1 });
    expect(f.h.provider.calls).not.toContain('stop');
    expect(f.h.provider.calls).not.toContain('destroy');
  });

  it('two scheduler objects racing the same actual cron slot commit one run and one launch reservation', async () => {
    const f = fixture();
    await Promise.all([f.scheduler().runOnce(), f.scheduler().runOnce()]);
    const run = (await f.runs.findLatest(f.rule.id))!;
    await waitForStatus(f.h.service, run.sandboxId!, 'running');
    expect(
      f.h.sqlite.prepare('SELECT count(*) AS n FROM automation_cron_occurrences').get(),
    ).toEqual({ n: 1 });
    expect(f.h.sqlite.prepare('SELECT count(*) AS n FROM automation_runs').get()).toEqual({ n: 1 });
    expect(f.h.sqlite.prepare('SELECT count(*) AS n FROM automation_launch_intents').get()).toEqual(
      { n: 1 },
    );
    expect(f.h.provider.calls.filter((v) => v === 'create')).toHaveLength(1);
  });

  it('accepted sandbox and task acknowledgements are idempotent across duplicate calls and changed payload is rejected', async () => {
    const f = fixture();
    await f.scheduler().runOnce();
    const run = (await f.runs.findLatest(f.rule.id))!;
    const intent = (await f.intents.find(run.id, 0))!;
    const input = {
      ...(JSON.parse(intent.input) as {
        projectId: string;
        runtimeId: string;
        prompt: string;
        timeoutMinutes: 30;
        automationId: string;
      }),
      runId: run.id,
      retryCount: 0,
      acceptedSandboxId: intent.sandboxId,
      acceptedTaskId: intent.taskId,
      actorId: intent.actorId,
    };
    await waitForStatus(f.h.service, intent.sandboxId, 'running');
    await Promise.all([f.launcher.createSandbox(input), f.launcher.createSandbox(input)]);
    await Promise.all([
      f.launcher.startTask(intent.sandboxId, input),
      f.launcher.startTask(intent.sandboxId, input),
    ]);
    await f.launcher.startTask(intent.sandboxId, input);
    expect(f.h.provider.calls.filter((v) => v === 'create')).toHaveLength(1);
    expect(f.h.provider.jobs.jobs.size).toBe(1);
    expect(f.h.sqlite.prepare('SELECT id FROM agent_tasks').all()).toEqual([{ id: intent.taskId }]);
    await expect(
      f.launcher.startTask(intent.sandboxId, { ...input, prompt: 'changed' }),
    ).rejects.toThrow('TASK_START_INTENT_CONFLICT');
    await expect(f.launcher.createSandbox({ ...input, prompt: 'changed' })).rejects.toThrow(
      'SANDBOX_ADMISSION_INTENT_CONFLICT',
    );
    expect(f.h.provider.jobs.jobs.size).toBe(1);
    await f.launcher.finishTask(intent.sandboxId, {
      automationId: f.rule.id,
      automationName: f.rule.name,
      retentionDays: 7,
      finishedAt: f.h.clock.now(),
    });
    expect(f.h.provider.calls).not.toContain('stop');
    expect(f.h.provider.calls).not.toContain('destroy');
  });

  it('an unknown start outcome remains attached to the original intent with no retry job, false failure or teardown', async () => {
    const f = fixture();
    await f.scheduler().runOnce();
    const run = (await f.runs.findLatest(f.rule.id))!;
    await waitForStatus(f.h.service, run.sandboxId!, 'running');
    const start = f.h.provider.jobs.startJob.bind(f.h.provider.jobs);
    f.h.provider.jobs.startJob = async (...args) => {
      await start(...args);
      throw new Error('guest start acknowledgement unknown');
    };
    await f.scheduler().runOnce();
    expect(f.h.provider.jobs.jobs.size).toBe(1);
    expect(f.h.sqlite.prepare('SELECT count(*) AS n FROM agent_tasks').get()).toEqual({ n: 0 });
    const original = await f.runs.findById(run.id);
    expect(original).toMatchObject({
      status: 'running',
      sandboxId: run.sandboxId,
      outcomeApplied: false,
    });
    expect(await f.launcher.phaseOf(run.sandboxId!)).toEqual({ kind: 'unconfirmed' });
    await f.scheduler().runOnce();
    await f.h.taskService.resumeRunning();
    await f.launcher.reconcileFinished();
    expect(f.h.provider.jobs.jobs.size).toBe(1);
    expect(await f.runs.findById(run.id)).toEqual(original);
    expect((await f.rules.findById(f.rule.id))?.failureCount).toBe(0);
    expect(f.h.provider.calls).not.toContain('stop');
    expect(f.h.provider.calls).not.toContain('destroy');
    expect(f.h.provider.jobs.released).toEqual([]);
  });

  it('a verified capacity retry reserves a new retry identity while retaining frozen input and the same run', async () => {
    const f = fixture();
    f.h.hostCapacity.diskAvailableBytes = 0;
    await f.scheduler().runOnce();
    const run = (await f.runs.findLatest(f.rule.id))!;
    expect(run).toMatchObject({ status: 'resource-exhausted', retryCount: 1, sandboxId: null });
    const first = (await f.intents.find(run.id, 1))!;
    const edited = (await f.rules.findById(f.rule.id))!;
    edited.update({ prompt: 'edited after acceptance' }, f.h.clock.now());
    f.h.uow.run((tx) => f.rules.saveSync(tx, edited));
    f.h.advanceClock(24 * 60_000);
    await f.scheduler().runOnce();
    const second = (await f.intents.find(run.id, 2))!;
    expect(second.input).toBe(first.input);
    expect(second.sandboxId).not.toBe(first.sandboxId);
    expect(second.taskId).not.toBe(first.taskId);
    expect(f.h.sqlite.prepare('SELECT count(*) AS n FROM automation_runs').get()).toEqual({ n: 1 });
    expect(f.h.provider.calls).not.toContain('create');
    expect((await f.rules.findById(f.rule.id))?.failureCount).toBe(0);
  });

  it('cron deduplication does not forbid two distinct manual business runs in the same millisecond', async () => {
    const f = fixture();
    const { AutomationRun } =
      await import('../../../packages/modules/automation/src/domain/entities/automation-run.entity');
    const first = AutomationRun.pending(
      randomUUID(),
      f.rule.id,
      fromEpochMs(f.h.clock.now().getTime()),
    );
    const second = AutomationRun.pending(
      randomUUID(),
      f.rule.id,
      fromEpochMs(first.triggeredAt.getTime()),
    );
    f.h.uow.run((tx) => {
      f.runs.saveSync(tx, first);
      f.runs.saveSync(tx, second);
    });
    expect(f.h.sqlite.prepare('SELECT count(*) AS n FROM automation_runs').get()).toEqual({ n: 2 });
    expect(
      f.h.sqlite.prepare('SELECT count(*) AS n FROM automation_cron_occurrences').get(),
    ).toEqual({ n: 0 });
  });

  it('immutable launch identity conflicts cannot reallocate IDs and a purged sandbox tombstone refuses recreation', async () => {
    const f = fixture();
    await f.scheduler().runOnce();
    const run = (await f.runs.findLatest(f.rule.id))!;
    const intent = (await f.intents.find(run.id, 0))!;
    await waitForStatus(f.h.service, intent.sandboxId, 'running');
    expect(() =>
      f.h.uow.run((tx) => f.intents.reserveSync(tx, { ...intent, taskId: randomUUID() })),
    ).toThrow('AUTOMATION_LAUNCH_INTENT_CONFLICT');
    expect(() =>
      f.h.sqlite
        .prepare('UPDATE automation_launch_intents SET input=? WHERE run_id=?')
        .run('{}', run.id),
    ).toThrow('automation launch identities are immutable');
    expect(await f.intents.find(run.id, 0)).toEqual(intent);
    f.h.sqlite.pragma('foreign_keys = ON');
    f.h.sqlite.prepare('DELETE FROM sandboxes WHERE id=?').run(intent.sandboxId);
    expect(f.h.sqlite.prepare('SELECT count(*) AS n FROM sandbox_admission_intents').get()).toEqual(
      { n: 1 },
    );
    const input = {
      ...(JSON.parse(intent.input) as {
        projectId: string;
        runtimeId: string;
        prompt: string;
        timeoutMinutes: 30;
        automationId: string;
      }),
      runId: run.id,
      retryCount: 0,
      acceptedSandboxId: intent.sandboxId,
      acceptedTaskId: intent.taskId,
      actorId: intent.actorId,
    };
    await expect(f.launcher.createSandbox(input)).rejects.toThrow('not found');
    expect(f.h.provider.calls.filter((v) => v === 'create')).toHaveLength(1);
    expect(f.h.sqlite.prepare('SELECT count(*) AS n FROM sandboxes').get()).toEqual({ n: 0 });
  });

  it('a confirmed zero-effect create-door rejection records one failure without guest work or ambiguous-start cleanup', async () => {
    const f = fixture();
    const rule = (await f.rules.findById(f.rule.id))!;
    rule.update({ runtimeId: 'not-registered-runtime' }, f.h.clock.now());
    f.h.uow.run((tx) => f.rules.saveSync(tx, rule));
    await f.scheduler().runOnce();
    const run = (await f.runs.findLatest(f.rule.id))!;
    expect(run).toMatchObject({ status: 'failed', outcomeApplied: true, sandboxId: null });
    expect((await f.rules.findById(f.rule.id))?.failureCount).toBe(1);
    expect(f.h.provider.calls).not.toContain('create');
    expect(f.h.provider.calls).not.toContain('stop');
    expect(f.h.provider.calls).not.toContain('destroy');
    expect(
      f.h.sqlite.prepare('SELECT count(*) AS n FROM automation_cron_occurrences').get(),
    ).toEqual({ n: 1 });
  });
});
