import { resolve } from 'node:path';
import { beforeEach, describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { asAgentTaskId, asProjectId, asSandboxId } from '@platform/shared-kernel';
import { Sandbox } from '../../src/domain/entities/sandbox.entity';
import { AgentTask } from '../../src/domain/entities/agent-task.entity';
import { SqliteSandboxRepository } from '../../src/infrastructure/persistence/sqlite/sandbox.repository.impl';
import { SqliteAgentTaskRepository } from '../../src/infrastructure/persistence/sqlite/agent-task.repository.impl';
import { SqliteUnitOfWork } from '../../../../../apps/api/src/platform/persistence/unit-of-work.impl';

/**
 * Real better-sqlite3 + Drizzle + the committed migrations + the real UnitOfWork.
 *
 * What this file is really guarding is the ONE property the whole restart story rests
 * on: `job_handle` and `cursor` must survive a round trip through the database
 * BYTE-FOR-BYTE. They are opaque provider strings, so any "helpful" normalisation on
 * the way in or out silently breaks resumption — and it would only show up as a job
 * that reads from the wrong offset after a crash, which is the hardest possible place
 * to notice it.
 */
function makeHarness() {
  const sqlite = new Database(':memory:');
  const db = drizzle(sqlite) as BetterSQLite3Database<Record<string, never>>;
  migrate(db, { migrationsFolder: resolve(process.cwd(), 'drizzle') });
  const sandboxes = new SqliteSandboxRepository(db);
  const tasks = new SqliteAgentTaskRepository(db);
  const uow = new SqliteUnitOfWork(sqlite);
  return { sqlite, db, sandboxes, tasks, uow };
}

const NOW = new Date('2026-08-22T09:00:00.000Z');
/** An opaque handle with the shape the real provider mints — JSON, with paths in it. */
const JOB_ID = JSON.stringify({
  s: 'platform-job-deadbeefdeadbeef',
  c: 'cmd-42',
  e: '/tmp/.platform-job-0123456789abcdef0123456789abcdef/stderr',
  d: '/tmp/.platform-job-0123456789abcdef0123456789abcdef',
});
const CURSOR = JSON.stringify({ o: 4096, e: 128 });

function seedSandbox(h: ReturnType<typeof makeHarness>, id = 'sbx-task-1'): string {
  const sandbox = Sandbox.create({
    id: asSandboxId(id),
    projectId: asProjectId('prj-1'),
    runtime: 'claude-code',
    provider: 'aio',
    imageRef: 'ghcr.io/agent-infra/sandbox:latest',
    headless: true,
    timeoutMinutes: 30,
    idleTimeoutSec: 1800,
    now: NOW,
  });
  h.uow.run((tx) => h.sandboxes.saveSync(tx, sandbox));
  return id;
}

function seedTask(h: ReturnType<typeof makeHarness>, sandboxId: string, taskId: string): AgentTask {
  const task = AgentTask.start({
    id: asAgentTaskId(taskId),
    sandboxId: asSandboxId(sandboxId),
    runtime: 'claude-code',
    jobHandle: { provider: 'aio', jobId: JOB_ID },
    logPath: `/data/logs/agent-tasks/${taskId}`,
    timeoutMs: 30 * 60_000,
    now: NOW,
  });
  h.uow.run((tx) => h.tasks.saveSync(tx, task));
  return task;
}

describe('SqliteAgentTaskRepository roundtrip', () => {
  let h: ReturnType<typeof makeHarness>;
  beforeEach(() => {
    h = makeHarness();
  });

  it('round-trips the OPAQUE job handle and cursor byte for byte', async () => {
    const sandboxId = seedSandbox(h);
    const task = seedTask(h, sandboxId, 'task-1');
    task.advance(CURSOR, 7, 4096);
    h.uow.run((tx) => h.tasks.saveSync(tx, task));

    const back = await h.tasks.findById(asAgentTaskId('task-1'));
    expect(back!.jobHandle).toEqual({ provider: 'aio', jobId: JOB_ID });
    expect(back!.cursor).toBe(CURSOR);
    expect(back!.lastSeq).toBe(7);
    // the durable log length travels in the SAME row write as the cursor — that pairing
    // is what lets a resume truncate the raw log back to the boundary the cursor admits.
    expect(back!.stdoutBytes).toBe(4096);
    expect(back!.status).toBe('running');
  });

  it('persists the terminal state, artifacts and the session reference', async () => {
    const sandboxId = seedSandbox(h);
    const task = seedTask(h, sandboxId, 'task-2');
    task.bindSessionRef('c1f0e6b2-9d3a-4f77-8a11-2b6c5e90d4aa');
    task.finish({
      status: 'succeeded',
      exitCode: 0,
      artifacts: [{ name: 'out/report.md', size: 1024, modifiedAt: '2026-08-22T09:05:00.000Z' }],
      now: new Date('2026-08-22T09:06:00.000Z'),
    });
    h.uow.run((tx) => h.tasks.saveSync(tx, task));

    const back = await h.tasks.findById(asAgentTaskId('task-2'));
    expect(back!.status).toBe('succeeded');
    expect(back!.exitCode).toBe(0);
    expect(back!.sessionRef).toBe('c1f0e6b2-9d3a-4f77-8a11-2b6c5e90d4aa');
    expect(back!.artifacts).toEqual([
      { name: 'out/report.md', size: 1024, modifiedAt: '2026-08-22T09:05:00.000Z' },
    ]);
    expect(back!.finishedAt?.toISOString()).toBe('2026-08-22T09:06:00.000Z');
  });

  it('`findRunning` returns exactly the tasks a restart must re-attach to', async () => {
    const sandboxId = seedSandbox(h);
    seedTask(h, sandboxId, 'task-running');
    const done = seedTask(h, sandboxId, 'task-done');
    done.finish({ status: 'succeeded', exitCode: 0, now: NOW });
    h.uow.run((tx) => h.tasks.saveSync(tx, done));

    const running = await h.tasks.findRunning();
    expect(running.map((t) => t.id)).toEqual(['task-running']);
  });

  it('a cancel that was requested but not yet landed SURVIVES the round trip', async () => {
    // this is what makes a cancel racing a platform restart still record `killed`.
    const sandboxId = seedSandbox(h);
    const task = seedTask(h, sandboxId, 'task-cancelled');
    task.requestCancel(new Date('2026-08-22T09:02:00.000Z'));
    h.uow.run((tx) => h.tasks.saveSync(tx, task));

    const back = await h.tasks.findById(asAgentTaskId('task-cancelled'));
    expect(back!.cancelRequested).toBe(true);
    expect(back!.isRunning).toBe(true);
  });

  it('the DB refuses a terminal status with no finish time, and vice versa', () => {
    const sandboxId = seedSandbox(h);
    seedTask(h, sandboxId, 'task-ck');
    // the pair IS the "has this landed?" answer, so the two must not disagree.
    expect(() =>
      h.sqlite.prepare(`UPDATE agent_tasks SET status = 'succeeded' WHERE id = 'task-ck'`).run(),
    ).toThrow(/CHECK constraint failed/);
  });

  it('deleting the sandbox takes its tasks with it (CASCADE)', async () => {
    const sandboxId = seedSandbox(h);
    seedTask(h, sandboxId, 'task-cascade');
    h.sqlite.prepare('DELETE FROM sandboxes WHERE id = ?').run(sandboxId);
    expect(await h.tasks.findById(asAgentTaskId('task-cascade'))).toBeNull();
  });
});

describe("the cancel write is ONE column, and it is guarded (`WHERE status='running'`)", () => {
  let h: ReturnType<typeof makeHarness>;
  beforeEach(() => {
    h = makeHarness();
  });

  it('does not rewind the pump’s cursor / lastSeq / stdoutBytes', async () => {
    const sandboxId = seedSandbox(h);
    const task = seedTask(h, sandboxId, 'task-race');
    // the pump advances a long way…
    task.advance(JSON.stringify({ o: 900, e: 0 }), 42, 900);
    h.uow.run((tx) => h.tasks.saveSync(tx, task));

    // …and a cancel arrives holding a copy loaded before any of that happened.
    h.uow.run((tx) =>
      h.tasks.requestCancelSync(tx, asAgentTaskId('task-race'), new Date('2026-08-22T09:03:00Z')),
    );

    const back = await h.tasks.findById(asAgentTaskId('task-race'));
    // ⚠️ MEASURED ON THE FULL-ROW UPSERT: lastSeq 42 → 5 and cursor {"o":900} → {"o":100},
    // so the next restart re-read from byte 100 and re-emitted every event in between
    // with fresh seq numbers. One conditional column carries nothing to write backwards.
    expect(back!.lastSeq).toBe(42);
    expect(back!.cursor).toBe(JSON.stringify({ o: 900, e: 0 }));
    expect(back!.stdoutBytes).toBe(900);
    expect(back!.cancelRequested).toBe(true);
  });

  it('cannot resurrect a task that has already landed', async () => {
    const sandboxId = seedSandbox(h);
    const task = seedTask(h, sandboxId, 'task-landed');
    task.finish({ status: 'succeeded', exitCode: 0, now: new Date('2026-08-22T09:05:00Z') });
    h.uow.run((tx) => h.tasks.saveSync(tx, task));

    h.uow.run((tx) =>
      h.tasks.requestCancelSync(tx, asAgentTaskId('task-landed'), new Date('2026-08-22T09:06:00Z')),
    );

    const back = await h.tasks.findById(asAgentTaskId('task-landed'));
    // ⚠️ A REVIVED ROW PASSES THE CHECK CONSTRAINT — `running` + NULL `finished_at` is
    // internally consistent — so it would sit there claiming to run forever, and the
    // gateway's late-subscriber `exit` branch would never fire for it.
    expect(back!.status).toBe('succeeded');
    expect(back!.isRunning).toBe(false);
    expect(back!.finishedAt).not.toBeNull();
    expect(back!.cancelRequested).toBe(false);
  });

  it('keeps the FIRST timestamp when it is requested twice', async () => {
    const sandboxId = seedSandbox(h);
    seedTask(h, sandboxId, 'task-twice');
    const first = new Date('2026-08-22T09:01:00Z');
    const second = new Date('2026-08-22T09:04:00Z');
    h.uow.run((tx) => h.tasks.requestCancelSync(tx, asAgentTaskId('task-twice'), first));
    h.uow.run((tx) => h.tasks.requestCancelSync(tx, asAgentTaskId('task-twice'), second));

    const back = await h.tasks.findById(asAgentTaskId('task-twice'));
    // "when was it asked for" stays the truth rather than the last click.
    expect(back!.cancelRequestedAt?.toISOString()).toBe(first.toISOString());
  });
});
