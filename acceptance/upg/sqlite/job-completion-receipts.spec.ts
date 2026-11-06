import { assertDefined } from '../../support/assert-defined';
import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { SandboxProviderError, SandboxProviderErrorCode } from '@platform/contracts';
import type { JobChunk } from '@platform/contracts';
import { asAgentTaskId } from '@platform/shared-kernel';
import {
  completedJobHandleDigest,
  jobCompletionEvidenceDigest,
} from '../../../packages/modules/sandbox/src/infrastructure/persistence/sqlite/job-completion-receipts.impl';
import { harness, waitForStatus } from '../../support/sandbox-rig';
import { deferred } from '../../support/strict-ports';
import {
  explicitRuntimeBusinessAuthority,
  withRuntimeBusinessAuthority,
} from '../../../packages/modules/sandbox/src/infrastructure/runtime-rpc/authority-context';

const authority = { run: withRuntimeBusinessAuthority, current: explicitRuntimeBusinessAuthority };

// Actual application, repositories, committed SQLite migrations and finalization.
// The guest Job plane is the external fixture; this does not replace native gates.
async function fixture() {
  const h = harness({ durableStarts: true, authority });
  const sandbox = await h.service.create({ projectId: 'prj-1', runtime: 'claude-code' });
  await waitForStatus(h.service, sandbox.id, 'running');
  const task = await h.taskService.run(sandbox.id, 'claude-code', {
    prompt: 'original task',
    timeoutMinutes: 30,
  });
  const original = assertDefined(await h.taskRepo.findById(asAgentTaskId(task.id)));
  return { h, sandbox, task, original };
}

describe('REQ-UPG-001/008 — genuine guest completion survives release of the original job', () => {
  it('persists original identity, cursor and sequence in the same terminal transaction before release, without output or credentials', async () => {
    const f = await fixture();
    const release = f.h.provider.jobs.releaseJob.bind(f.h.provider.jobs);
    let checked = false;
    f.h.provider.jobs.releaseJob = async (handle, job) => {
      const row = assertDefined(await f.h.taskRepo.findById(asAgentTaskId(f.task.id)));
      const proof = await f.h.jobCompletions.find(f.task.id);
      expect(row.status).toBe('succeeded');
      expect(proof).toMatchObject({
        taskId: f.task.id,
        sandboxId: f.sandbox.id,
        provider: job.provider,
        cursor: 'complete',
        lastSeq: row.lastSeq,
        exitCode: 0,
        exitKind: 'natural',
        jobHandleDigest: completedJobHandleDigest(f.original.jobHandle),
      });
      expect(proof?.evidenceDigest).toBe(jobCompletionEvidenceDigest(assertDefined(proof)));
      expect(Object.keys(assertDefined(proof)).sort()).toEqual(
        [
          'cursor',
          'evidenceDigest',
          'exitCode',
          'exitKind',
          'jobHandleDigest',
          'lastSeq',
          'observedAt',
          'provider',
          'sandboxId',
          'taskId',
        ].sort(),
      );
      checked = true;
      return release(handle, job);
    };
    [...f.h.provider.jobs.jobs.values()][0].finish(0);
    await vi.waitFor(() => expect(checked).toBe(true));
    expect(f.h.provider.jobs.released).toEqual([f.original.jobHandle.jobId]);
    expect(() =>
      f.h.sqlite.prepare('UPDATE agent_task_job_completions SET last_seq=99').run(),
    ).toThrow('job completion receipts are immutable');
    expect(() => f.h.sqlite.prepare('DELETE FROM agent_task_job_completions').run()).toThrow(
      'job completion receipts are immutable',
    );
  });

  it('a missing evidence table rolls back terminal status, emits no finished event and never releases the original job; a later resume confirms the same exit', async () => {
    const f = await fixture();
    const schema = f.h.sqlite
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='agent_task_job_completions'",
      )
      .get() as { sql: string };
    const eventsBefore = f.h.publishedEvents.length;
    let observed = 0;
    const save = f.h.jobCompletions.saveObservedSync.bind(f.h.jobCompletions);
    f.h.jobCompletions.saveObservedSync = (...args) => {
      observed++;
      return save(...args);
    };
    f.h.sqlite.exec('DROP TABLE agent_task_job_completions');
    [...f.h.provider.jobs.jobs.values()][0].finish(0);
    await vi.waitFor(() => expect(observed).toBe(1));
    expect((await f.h.taskRepo.findById(asAgentTaskId(f.task.id)))?.status).toBe('running');
    expect(f.h.publishedEvents).toHaveLength(eventsBefore);
    expect(f.h.provider.jobs.released).toEqual([]);
    f.h.sqlite.exec(schema.sql);
    await f.h.taskService.resumeRunning();
    await vi.waitFor(async () =>
      expect((await f.h.jobCompletions.find(f.task.id))?.exitKind).toBe('natural'),
    );
    expect(f.h.provider.jobs.jobs.size).toBe(1);
    expect(f.h.provider.calls).not.toContain('stop');
  });

  it('an unconfirmed observation cannot create completion evidence or a terminal task', async () => {
    const h = harness({ durableStarts: true, authority });
    h.provider.jobs.readJob = async () => {
      throw new SandboxProviderError(SandboxProviderErrorCode.INTERNAL, 'observation unavailable');
    };
    const sandbox = await h.service.create({ projectId: 'prj-1', runtime: 'claude-code' });
    await waitForStatus(h.service, sandbox.id, 'running');
    const task = await h.taskService.run(sandbox.id, 'claude-code', { prompt: 'unchanged job' });
    await h.taskService.resumeRunning();
    expect(await h.jobCompletions.find(task.id)).toBeNull();
    expect((await h.taskRepo.findById(asAgentTaskId(task.id)))?.status).toBe('running');
    expect(h.provider.jobs.released).toEqual([]);
    for (const job of h.provider.jobs.jobs.values()) job.finish(0);
    h.stopPumps();
  });

  it('a database terminal status without a real exited chunk supplies no natural-completion evidence', async () => {
    const f = await fixture();
    f.h.stopPumps();
    f.h.sqlite
      .prepare(
        "UPDATE agent_tasks SET status='succeeded',finished_at=started_at,exit_code=0 WHERE id=?",
      )
      .run(f.task.id);
    await f.h.taskService.resumeRunning();
    expect(await f.h.jobCompletions.find(f.task.id)).toBeNull();
    expect(f.h.provider.jobs.released).toEqual([]);
    [...f.h.provider.jobs.jobs.values()][0].finish(0);
  });

  it('an explicit cancel is classified only after the original guest returns exited', async () => {
    const f = await fixture();
    expect(await f.h.jobCompletions.find(f.task.id)).toBeNull();
    await f.h.taskService.cancel(f.sandbox.id, f.task.id);
    await vi.waitFor(async () =>
      expect((await f.h.jobCompletions.find(f.task.id))?.exitKind).toBe('cancelled'),
    );
    expect((await f.h.taskRepo.findById(asAgentTaskId(f.task.id)))?.status).toBe('killed');
    expect((await f.h.jobCompletions.find(f.task.id))?.jobHandleDigest).toBe(
      completedJobHandleDigest(f.original.jobHandle),
    );
  });

  it('a real platform deadline and guest exited response preserve a timeout receipt instead of inferring exit from elapsed time alone', async () => {
    const h = harness({ durableStarts: true, authority });
    const first = deferred<JobChunk>();
    const read = h.provider.jobs.readJob.bind(h.provider.jobs);
    let reads = 0;
    h.provider.jobs.readJob = (...args) => (++reads === 1 ? first.promise : read(...args));
    const sandbox = await h.service.create({ projectId: 'prj-1', runtime: 'claude-code' });
    await waitForStatus(h.service, sandbox.id, 'running');
    const task = await h.taskService.run(sandbox.id, 'claude-code', {
      prompt: 'deadline task',
      timeoutMinutes: 30,
    });
    h.advanceClock(30 * 60_000 + 1);
    expect(await h.jobCompletions.find(task.id)).toBeNull();
    first.resolve({ stdout: '', stderr: '', cursor: 'before-timeout', status: 'running' });
    await vi.waitFor(async () =>
      expect((await h.jobCompletions.find(task.id))?.exitKind).toBe('timeout'),
    );
    expect(reads).toBe(2);
    expect((await h.taskRepo.findById(asAgentTaskId(task.id)))?.status).toBe('timed_out');
  });
});
