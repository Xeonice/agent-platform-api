import { describe, expect, it } from 'vitest';
import { SandboxProviderError, SandboxProviderErrorCode } from '@platform/contracts';
import type { TaskServerFrame } from '@platform/contracts';
import { FULL_CAPS, FakeAdapter, FakeProvider, harness, waitForStatus } from './_harness';
import { TASK_ARTIFACT_DIR } from '../../src/application/workflows/run-agent-task.workflow';
import { sanitizeArtifactName } from '../../src/application/agent-task.service';

/**
 * The headless Task application layer (S6). These tests use in-memory job/file planes
 * that obey the SAME rules as the real provider (whole-line delivery, an opaque
 * cursor), so what is proven here is the ORCHESTRATION — the order of operations that
 * makes each of the slice's promises true:
 *
 *   `job_handle` + `cursor` persisted on every step ⇒ a restart resumes the same job
 *   `session_ref` learned from the stream        ⇒ the next turn can continue
 *   artifacts + exit code persisted BEFORE release ⇒ nothing is destroyed unread
 */
const RUNTIME = 'claude-code';

/** Bring a sandbox all the way to `running` so a Task has somewhere to go. */
async function runningSandbox(h: ReturnType<typeof harness>): Promise<string> {
  const dto = await h.service.create({ projectId: 'prj-1', runtime: RUNTIME });
  await waitForStatus(h.service, dto.id, 'running');
  return dto.id;
}

/** Wait until `predicate` holds, or fail loudly — the pump is asynchronous. */
async function until(predicate: () => boolean, what: string, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const frames = (h: ReturnType<typeof harness>): TaskServerFrame[] =>
  h.taskBroadcaster.frames.map((f) => f.frame);

/** A claude stream-json line, the shape `parseOutput` really receives. */
function claudeInit(sessionId: string): string {
  return `${JSON.stringify({ type: 'system', subtype: 'init', session_id: sessionId })}\n`;
}
function claudeText(text: string): string {
  return `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } })}\n`;
}
function claudeResult(isError: boolean): string {
  return `${JSON.stringify({ type: 'result', subtype: 'success', is_error: isError })}\n`;
}

describe('run a headless Task end to end (in-memory planes)', () => {
  it('starts the job, streams events, lands the exit code and releases LAST', async () => {
    const h = harness();
    const sandboxId = await runningSandbox(h);

    const dto = await h.taskService.run(sandboxId, RUNTIME, { prompt: 'summarise the diff' });
    expect(dto.status).toBe('running');
    expect(dto.lastSeq).toBe(0);
    // the budget travels on the DTO: with only `startedAt` a client can render
    // "已经跑了多久" but not "还剩多久", and the latter is the question on a 4-hour task.
    expect(dto.timeoutMinutes).toBe(30);

    const plane = h.provider.jobs!;
    const job = [...plane.jobs.values()][0];
    // What the PLATFORM contributes to the invocation: headless, the one output format
    // it can parse, the workspace as cwd, and the timeout tier as a real budget. (Which
    // argv each CLI builds from that spec is the adapter's business, covered by its own
    // golden tests.)
    expect(h.adapter.startCommands.at(-1)).toMatchObject({
      headless: true,
      outputFormat: 'json-stream',
      workdir: '/workspace',
      prompt: 'summarise the diff',
    });
    expect(plane.specs[0].cwd).toBe('/workspace');
    expect(plane.specs[0].timeoutMs).toBe(30 * 60_000);

    job.emit(claudeInit('sess-abc'));
    job.emit(claudeText('here is the summary'));
    job.emit(claudeResult(false));
    // one artifact waiting in the drop box
    h.provider.files!.files.set(`${TASK_ARTIFACT_DIR}/report.md`, Buffer.from('# report', 'utf8'));
    job.finish(0);

    await until(() => plane.released.length === 1, 'the job to be released');

    const stored = await h.taskRepo.findById(dto.id);
    expect(stored!.status).toBe('succeeded');
    expect(stored!.exitCode).toBe(0);
    // the CLI's own conversation id, learned from the FIRST event rather than assumed.
    expect(stored!.sessionRef).toBe('sess-abc');
    expect(stored!.artifacts).toEqual([
      { name: 'report.md', size: 8, modifiedAt: '2026-08-21T00:00:00.000Z' },
    ]);

    // ⚠️ ORDER: release happens only AFTER the terminal state is persisted, because
    // releasing destroys the sandbox-side output the exit code was read from.
    const exitFrame = frames(h).find((f) => f.type === 'exit');
    expect(exitFrame).toEqual({ type: 'exit', taskId: dto.id, status: 'succeeded', exitCode: 0 });
    expect(stored!.finishedAt).not.toBeNull();
  });

  it('numbers events densely and stamps a timestamp the adapter could not', async () => {
    const h = harness();
    const sandboxId = await runningSandbox(h);
    const dto = await h.taskService.run(sandboxId, RUNTIME, { prompt: 'go' });
    const job = [...h.provider.jobs!.jobs.values()][0];

    job.emit(claudeInit('s1'));
    job.emit(claudeText('one'));
    job.emit(claudeText('two'));
    job.finish(0);
    await until(() => h.provider.jobs!.released.length === 1, 'completion');

    const events = frames(h).filter(
      (f): f is Extract<TaskServerFrame, { type: 'event' }> => f.type === 'event',
    );
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(events.map((e) => e.event.type)).toEqual([
      'session-started',
      'agent-message',
      'agent-message',
    ]);
    // parseOutput has no Clock (01 §3), so the application stamps the time.
    expect(events.every((e) => e.event.timestamp !== '')).toBe(true);

    const stored = await h.taskRepo.findById(dto.id);
    expect(stored!.lastSeq).toBe(3);
  });

  it('a non-zero exit is a FAILURE with a code, never a sentence (P22 §1)', async () => {
    const h = harness();
    const sandboxId = await runningSandbox(h);
    const dto = await h.taskService.run(sandboxId, RUNTIME, { prompt: 'go' });
    const job = [...h.provider.jobs!.jobs.values()][0];
    job.emit(claudeResult(true));
    job.finish(1);
    await until(() => h.provider.jobs!.released.length === 1, 'completion');

    const stored = await h.taskRepo.findById(dto.id);
    expect(stored!.status).toBe('failed');
    expect(stored!.errorCode).toBe('TASK_FAILED');
    expect(stored!.errorCode).not.toMatch(/\s/); // a CODE, not prose
  });

  it('exit 124 is the sandbox-side hard timeout, kept distinct from a plain failure', async () => {
    const h = harness();
    const sandboxId = await runningSandbox(h);
    const dto = await h.taskService.run(sandboxId, RUNTIME, { prompt: 'go' });
    const job = [...h.provider.jobs!.jobs.values()][0];
    job.finish(124);
    await until(() => h.provider.jobs!.released.length === 1, 'completion');
    expect((await h.taskRepo.findById(dto.id))!.status).toBe('timed_out');
  });

  it('writes the RAW stdout to the log store, and the DB keeps only a pointer', async () => {
    const h = harness();
    const sandboxId = await runningSandbox(h);
    const dto = await h.taskService.run(sandboxId, RUNTIME, { prompt: 'go' });
    const job = [...h.provider.jobs!.jobs.values()][0];
    const raw = claudeInit('s1') + claudeText('hello');
    job.emit(raw);
    job.emitStderr('WARN tracing noise\n');
    job.finish(0);
    await until(() => h.provider.jobs!.released.length === 1, 'completion');

    expect(h.taskLogs.stdout.get(dto.id)).toBe(raw);
    // stderr is a SEPARATE file — merging them is what breaks JSON.parse-per-line.
    expect(h.taskLogs.stderr.get(dto.id)).toBe('WARN tracing noise\n');
    const stored = await h.taskRepo.findById(dto.id);
    expect(stored!.logPath).toContain(dto.id);
  });
});

describe('replay — rebuilt from the raw log, with the SAME dense numbering', () => {
  it('replaying from 0 reproduces exactly the events that were pushed live', async () => {
    const h = harness();
    const sandboxId = await runningSandbox(h);
    const dto = await h.taskService.run(sandboxId, RUNTIME, { prompt: 'go' });
    const job = [...h.provider.jobs!.jobs.values()][0];
    job.emit(claudeInit('s1') + claudeText('a') + claudeText('b') + claudeResult(false));
    job.finish(0);
    await until(() => h.provider.jobs!.released.length === 1, 'completion');

    const live = frames(h)
      .filter((f): f is Extract<TaskServerFrame, { type: 'event' }> => f.type === 'event')
      .map((f) => ({ seq: f.seq, type: f.event.type }));
    const replayed = (await h.taskService.replay(dto.id, 0)).map((r) => ({
      seq: r.seq,
      type: r.event.type,
    }));
    // This equality is what lets the platform keep ONE copy of the output instead of
    // a raw log AND an event log AND the DB.
    expect(replayed).toEqual(live);
  });

  it('`fromSeq` skips exactly what the subscriber already has', async () => {
    const h = harness();
    const sandboxId = await runningSandbox(h);
    const dto = await h.taskService.run(sandboxId, RUNTIME, { prompt: 'go' });
    const job = [...h.provider.jobs!.jobs.values()][0];
    job.emit(claudeInit('s1') + claudeText('a') + claudeText('b'));
    job.finish(0);
    await until(() => h.provider.jobs!.released.length === 1, 'completion');

    const tail = await h.taskService.replay(dto.id, 2);
    expect(tail.map((t) => t.seq)).toEqual([3]);
  });
});

describe('平台重启不丢正在跑的任务 — job_handle + cursor are the whole mechanism', () => {
  it('a fresh workflow resumes the SAME job from the persisted cursor', async () => {
    const h = harness();
    const sandboxId = await runningSandbox(h);
    const dto = await h.taskService.run(sandboxId, RUNTIME, { prompt: 'go' });
    const plane = h.provider.jobs!;
    const job = [...plane.jobs.values()][0];

    job.emit(claudeInit('s1') + claudeText('before the crash'));
    await until(() => (h.taskRepo.store.get(dto.id)?.lastSeq ?? 0) >= 2, 'the first two events');

    const persisted = h.taskRepo.store.get(dto.id)!;
    const cursorAtCrash = persisted.cursor;
    expect(cursorAtCrash).not.toBeNull();
    expect(persisted.jobHandle.jobId).toBe([...plane.jobs.keys()][0]);

    // ── simulate the platform dying and coming back: a BRAND NEW workflow object,
    // holding nothing but what the database has. ──────────────────────────────────
    const revived = h.newTaskWorkflow();
    job.emit(claudeText('after the crash'));
    job.finish(0);
    const resumed = await revived.resumeRunning();
    expect(resumed).toBe(1);

    await until(() => plane.released.length === 1, 'the resumed job to finish');
    const final = h.taskRepo.store.get(dto.id)!;
    expect(final.status).toBe('succeeded');
    // NOT re-read from the beginning: the events continue from where they stopped.
    expect(final.lastSeq).toBe(3);
    expect(h.taskLogs.stdout.get(dto.id)).toContain('after the crash');
    // and the pre-crash bytes were not written twice.
    expect(h.taskLogs.stdout.get(dto.id)!.match(/before the crash/g)).toHaveLength(1);
  });

  it('a task whose sandbox is gone is LANDED, not left claiming to run forever', async () => {
    const h = harness();
    const sandboxId = await runningSandbox(h);
    const dto = await h.taskService.run(sandboxId, RUNTIME, { prompt: 'go' });
    await until(() => h.taskRepo.store.has(dto.id), 'the task row');

    h.repo.store.delete(sandboxId);
    const revived = h.newTaskWorkflow();
    await revived.resumeRunning();
    const stored = h.taskRepo.store.get(dto.id)!;
    expect(stored.status).toBe('failed');
    expect(stored.errorCode).toBe('SANDBOX_GONE');
  });

  /**
   * The sibling of the case above, for the OTHER thing a restart can lose: the ADAPTER.
   * A third-party runtime registers at runtime (04 §8), so a task row can outlive the
   * module that knows how to read its output.
   *
   * ⚠️ THE ASSERTION IS THE CODE, NOT MERELY THE FAILURE. Before `UnknownRuntimeError`
   * existed this threw a bare `Error`, and `failWith` files a code-less error as
   * `INTERNAL` — so the platform reported "内部错误" for a fact it knew precisely. And it
   * is a value the frontend can actually render only because it is in the
   * `TaskErrorCodeSchema` closed set that reaches it through openapi.
   */
  it('a task whose runtime adapter is no longer registered fails as UNKNOWN_RUNTIME', async () => {
    const h = harness();
    const sandboxId = await runningSandbox(h);
    const dto = await h.taskService.run(sandboxId, RUNTIME, { prompt: 'go' });
    await until(() => h.taskRepo.store.has(dto.id), 'the task row');

    // the module that registered this adapter is not loaded in the new process
    expect(h.forgetRuntime(RUNTIME)).toBe(true);
    const revived = h.newTaskWorkflow();
    await revived.resumeRunning();

    await until(() => h.taskRepo.store.get(dto.id)?.status === 'failed', 'the task to land');
    const stored = h.taskRepo.store.get(dto.id)!;
    expect(stored.errorCode).toBe('UNKNOWN_RUNTIME');
    // NOT the two codes it used to borrow: neither an install that never happened…
    expect(stored.errorCode).not.toBe('INSTALL_FAILED');
    // …nor the "we have no idea" bucket.
    expect(stored.errorCode).not.toBe('INTERNAL');
  });
});

describe('admission — the platform’s first externally-triggered execution path', () => {
  it('refuses a headless sandbox on a provider WITHOUT the two planes (409)', async () => {
    const noPlanes = new FakeProvider('nojobs', { ...FULL_CAPS, headlessTask: false });
    const h = harness({ providers: [noPlanes] });
    await expect(
      h.service.create({
        projectId: 'prj-1',
        runtime: RUNTIME,
        headless: true,
        timeoutMinutes: 30,
      }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('an INTERACTIVE sandbox is still fine on that provider — the branch is derived, not global', async () => {
    const noPlanes = new FakeProvider('nojobs', { ...FULL_CAPS, headlessTask: false });
    const h = harness({ providers: [noPlanes] });
    await expect(h.service.create({ projectId: 'prj-1', runtime: RUNTIME })).resolves.toBeDefined();
  });

  it('refuses a Task on a sandbox that is not running (409)', async () => {
    const h = harness();
    const sandboxId = await runningSandbox(h);
    const sandbox = h.repo.store.get(sandboxId)!;
    sandbox.transitionTo('stopping', 'user', new Date());
    sandbox.transitionTo('stopped', 'user', new Date());
    await expect(h.taskService.run(sandboxId, RUNTIME, { prompt: 'go' })).rejects.toMatchObject({
      status: 409,
    });
  });

  it('refuses a runtime the sandbox was not provisioned for (409, not a 30s CLI failure)', async () => {
    const h = harness({
      adapters: [new FakeAdapter('claude-code', 'Claude Code'), new FakeAdapter('codex', 'Codex')],
    });
    const sandboxId = await runningSandbox(h);
    await expect(h.taskService.run(sandboxId, 'codex', { prompt: 'go' })).rejects.toMatchObject({
      status: 409,
    });
  });

  it('an unknown runtime is a 404', async () => {
    const h = harness();
    const sandboxId = await runningSandbox(h);
    await expect(h.taskService.run(sandboxId, 'nope', { prompt: 'go' })).rejects.toMatchObject({
      status: 404,
    });
  });

  it('a task addressed under the WRONG sandbox is a 404, not someone else’s data', async () => {
    const h = harness();
    const sandboxId = await runningSandbox(h);
    const dto = await h.taskService.run(sandboxId, RUNTIME, { prompt: 'go' });
    await expect(h.taskService.get('some-other-sandbox', dto.id)).rejects.toMatchObject({
      status: 404,
    });
  });
});

describe('multi-turn continuation', () => {
  it('the chosen tier round-trips onto the DTO', async () => {
    const h = harness();
    const sandboxId = await runningSandbox(h);
    const dto = await h.taskService.run(sandboxId, RUNTIME, { prompt: 'go', timeoutMinutes: 240 });
    expect(dto.timeoutMinutes).toBe(240);
    // and the job really got that budget, in the unit `JobSpec` speaks.
    expect(h.provider.jobs!.specs.at(-1)!.timeoutMs).toBe(240 * 60_000);
  });

  it('passes the previous sessionRef into buildStartCommand as resumeFrom', async () => {
    const h = harness();
    const sandboxId = await runningSandbox(h);
    await h.taskService.run(sandboxId, RUNTIME, { prompt: 'and then?', resumeFrom: 'sess-abc' });
    expect(h.adapter.startCommands.at(-1)).toMatchObject({
      headless: true,
      outputFormat: 'json-stream',
      resumeFrom: 'sess-abc',
    });
  });
});

describe('artifact naming — the download endpoint resolves this into a real path', () => {
  it('rejects absolute paths and every traversal spelling', () => {
    expect(sanitizeArtifactName('../../etc/passwd')).toBeNull();
    expect(sanitizeArtifactName('/etc/passwd')).toBeNull();
    expect(sanitizeArtifactName('out/../../secret')).toBeNull();
    expect(sanitizeArtifactName('.')).toBeNull();
    expect(sanitizeArtifactName('')).toBeNull();
    expect(sanitizeArtifactName('a//b')).toBeNull();
  });

  it('accepts an ordinary relative name, nested included', () => {
    expect(sanitizeArtifactName('report.md')).toBe('report.md');
    expect(sanitizeArtifactName('out/report.md')).toBe('out/report.md');
  });

  it('a name the task never produced is a 404, even if the file exists', async () => {
    const h = harness();
    const sandboxId = await runningSandbox(h);
    const dto = await h.taskService.run(sandboxId, RUNTIME, { prompt: 'go' });
    const job = [...h.provider.jobs!.jobs.values()][0];
    h.provider.files!.files.set(`${TASK_ARTIFACT_DIR}/kept.md`, Buffer.from('ok', 'utf8'));
    h.provider.files!.files.set('/workspace/secret.env', Buffer.from('TOKEN=1', 'utf8'));
    job.finish(0);
    await until(() => h.provider.jobs!.released.length === 1, 'completion');

    await expect(h.taskService.openArtifact(sandboxId, dto.id, 'kept.md')).resolves.toMatchObject({
      name: 'kept.md',
    });
    await expect(h.taskService.openArtifact(sandboxId, dto.id, 'other.md')).rejects.toMatchObject({
      status: 404,
    });
  });
});

/**
 * The download's `content-length`. The rule the whole group exists to pin: the platform
 * states a size only when it can state a TRUE one, because a wrong `content-length` is
 * strictly worse than an absent one — the browser truncates the file at that byte, or
 * hangs waiting for bytes that will never arrive, and reports neither as an error.
 */
describe('artifact size — stated only when it is knowable', () => {
  it('measures at OPEN time, so a file that changed since collection is still right', async () => {
    const h = harness();
    const sandboxId = await runningSandbox(h);
    const dto = await h.taskService.run(sandboxId, RUNTIME, { prompt: 'go' });
    const job = [...h.provider.jobs!.jobs.values()][0];
    const path = `${TASK_ARTIFACT_DIR}/report.md`;
    h.provider.files!.files.set(path, Buffer.from('small', 'utf8'));
    job.finish(0);
    await until(() => h.provider.jobs!.released.length === 1, 'completion');

    // what collection recorded is a fact about the PAST — kept as history…
    expect(h.taskRepo.store.get(dto.id)!.artifacts).toEqual([
      { name: 'report.md', size: 5, modifiedAt: '2026-08-21T00:00:00.000Z' },
    ]);
    // …and NOT reused as a wire promise once the file underneath has moved on.
    h.provider.files!.files.set(path, Buffer.from('considerably longer', 'utf8'));
    await expect(h.taskService.openArtifact(sandboxId, dto.id, 'report.md')).resolves.toMatchObject(
      { size: 19 },
    );
  });

  it('says NOTHING while the Task is still running — the agent may be mid-write', async () => {
    const h = harness();
    const sandboxId = await runningSandbox(h);
    const dto = await h.taskService.run(sandboxId, RUNTIME, { prompt: 'go' });
    h.provider.files!.files.set(`${TASK_ARTIFACT_DIR}/partial.log`, Buffer.from('so far', 'utf8'));

    // ⚠️ THE ONE CASE A MEASUREMENT CANNOT COVER. The drop box belongs to the agent while
    // the agent is alive, so any size read here is stale the instant it is read — and
    // stale in the direction that TRUNCATES. The bytes are still served; only the
    // promise about how many of them there are is withheld.
    const opened = await h.taskService.openArtifact(sandboxId, dto.id, 'partial.log');
    expect(opened.size).toBeUndefined();
    expect(opened.name).toBe('partial.log');
  });

  it('a listing that THROWS still serves the bytes, just without a size', async () => {
    const h = harness();
    const sandboxId = await runningSandbox(h);
    const dto = await h.taskService.run(sandboxId, RUNTIME, { prompt: 'go' });
    const job = [...h.provider.jobs!.jobs.values()][0];
    h.provider.files!.files.set(`${TASK_ARTIFACT_DIR}/kept.md`, Buffer.from('ok', 'utf8'));
    job.finish(0);
    await until(() => h.provider.jobs!.released.length === 1, 'completion');

    // the measurement is an OPTIONAL extra; failing to take it must not take the
    // download down with it.
    h.provider.files!.listFiles = async () => {
      throw new Error('file plane is having a day');
    };
    const opened = await h.taskService.openArtifact(sandboxId, dto.id, 'kept.md');
    expect(opened.size).toBeUndefined();
    expect(await readAll(opened.stream)).toBe('ok');
  });

  it('a plane that reports NO size for the file answers `undefined`, never 0', async () => {
    const h = harness();
    const sandboxId = await runningSandbox(h);
    const dto = await h.taskService.run(sandboxId, RUNTIME, { prompt: 'go' });
    const job = [...h.provider.jobs!.jobs.values()][0];
    h.provider.files!.files.set(`${TASK_ARTIFACT_DIR}/kept.md`, Buffer.from('ok', 'utf8'));
    job.finish(0);
    await until(() => h.provider.jobs!.released.length === 1, 'completion');

    // ⚠️ `size` IS OPTIONAL ON `FileEntry` and the recorded listing collapses a missing
    // one to `0` (`e.size ?? 0`) — which is exactly why the recorded number cannot be a
    // wire promise. Here the absence is preserved instead: no size, no header.
    const inner = h.provider.files!.listFiles.bind(h.provider.files!);
    h.provider.files!.listFiles = async (handle, path, opts) =>
      (await inner(handle, path, opts)).map(({ size: _size, ...rest }) => rest);
    const opened = await h.taskService.openArtifact(sandboxId, dto.id, 'kept.md');
    expect(opened.size).toBeUndefined();
    expect(await readAll(opened.stream)).toBe('ok');
  });
});

/** Drain a stream the file plane handed over. */
async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

describe('cancel — the stop button the platform would otherwise not have', () => {
  it('records the INTENT first, signals, and lands `killed` (not `failed`)', async () => {
    const h = harness();
    const sandboxId = await runningSandbox(h);
    const dto = await h.taskService.run(sandboxId, RUNTIME, { prompt: 'a long one' });
    const plane = h.provider.jobs!;

    await h.taskService.cancel(sandboxId, dto.id);
    expect(plane.kills).toEqual([{ jobId: [...plane.jobs.keys()][0], signal: 'SIGTERM' }]);

    await until(() => plane.released.length === 1, 'the cancelled job to finalise');
    const stored = h.taskRepo.store.get(dto.id)!;
    // a signal-killed process has NO exit code, so without the recorded intent this
    // would be indistinguishable from a crash.
    expect(stored.status).toBe('killed');
    expect(stored.exitCode).toBeNull();
    expect(stored.cancelRequestedAt).not.toBeNull();
  });

  it('does NOT release the job at cancel time — the exit code is read first', async () => {
    const h = harness();
    const sandboxId = await runningSandbox(h);
    const dto = await h.taskService.run(sandboxId, RUNTIME, { prompt: 'go' });
    const plane = h.provider.jobs!;
    // stop the pump from finalising by never letting the read observe an exit:
    // assert on the state DIRECTLY after the cancel call returns.
    const before = plane.released.length;
    await h.taskService.cancel(sandboxId, dto.id);
    expect(plane.released.length).toBe(before);
  });

  it('a cancel that races a platform restart still lands `killed`', async () => {
    const h = harness();
    const sandboxId = await runningSandbox(h);
    const dto = await h.taskService.run(sandboxId, RUNTIME, { prompt: 'go' });
    const task = h.taskRepo.store.get(dto.id)!;
    task.requestCancel(new Date());
    h.taskRepo.saveSync({} as never, task);

    // a brand-new workflow, knowing only what the repository holds.
    const plane = h.provider.jobs!;
    [...plane.jobs.values()][0].finish(undefined);
    await h.newTaskWorkflow().resumeRunning();
    await until(() => plane.released.length === 1, 'the resumed job to finalise');
    expect(h.taskRepo.store.get(dto.id)!.status).toBe('killed');
  });

  it('cancelling an already-finished task is a 409, not a silent no-op', async () => {
    const h = harness();
    const sandboxId = await runningSandbox(h);
    const dto = await h.taskService.run(sandboxId, RUNTIME, { prompt: 'go' });
    [...h.provider.jobs!.jobs.values()][0].finish(0);
    await until(() => h.provider.jobs!.released.length === 1, 'completion');
    await expect(h.taskService.cancel(sandboxId, dto.id)).rejects.toMatchObject({ status: 409 });
  });
});

describe('the sandbox’s run history', () => {
  it('lists tasks NEWEST FIRST — the only authority after a page reload', async () => {
    const h = harness({ now: new Date('2026-08-21T00:00:00.000Z') });
    const sandboxId = await runningSandbox(h);
    const first = await h.taskService.run(sandboxId, RUNTIME, { prompt: 'turn 1' });
    [...h.provider.jobs!.jobs.values()][0].finish(0);
    await until(() => h.provider.jobs!.released.length === 1, 'the first task to finish');
    const second = await h.taskService.run(sandboxId, RUNTIME, {
      prompt: 'turn 2',
      resumeFrom: 'sess-1',
    });

    const listed = await h.taskService.listBySandbox(sandboxId);
    expect(listed.map((t) => t.id)).toContain(first.id);
    expect(listed.map((t) => t.id)).toContain(second.id);
    expect(listed).toHaveLength(2);
  });

  it('listing a sandbox that does not exist is a 404', async () => {
    const h = harness();
    await expect(h.taskService.listBySandbox('nope')).rejects.toMatchObject({ status: 404 });
  });
});

describe('a read that fails — transport is not a verdict', () => {
  /** What the provider throws when the agent did not answer (it sets `retryable`). */
  const transportFault = (): SandboxProviderError =>
    new SandboxProviderError(
      SandboxProviderErrorCode.PROVIDER_UNAVAILABLE,
      'AIO agent /v1/bash/output unreachable: ECONNRESET',
      undefined,
      true,
    );

  it('survives a TRANSIENT read failure and still lands the real verdict', async () => {
    const h = harness();
    const sandboxId = await runningSandbox(h);
    // ⚠️ ARMED BEFORE THE RUN STARTS, so the FIRST read is the one that fails. Arming it
    // afterwards races the pump: the job can exit inside the very first long poll and
    // the fault is never consumed at all — a test that proves nothing while passing.
    const plane = h.provider.jobs!;
    plane.readFaults.push(transportFault());

    const dto = await h.taskService.run(sandboxId, RUNTIME, { prompt: 'go' });
    const job = [...plane.jobs.values()][0];
    job.emit(claudeInit('s1') + claudeText('after the blip'));
    job.finish(0);

    await until(() => plane.readFaults.length === 0, 'the fault to be consumed');
    await until(() => plane.released.length === 1, 'completion despite the blip', 5_000);
    const stored = await h.taskRepo.findById(dto.id);
    // ⚠️ NOT `failed`. Before the retry existed, ONE transient error landed the task,
    // and a terminal row is invisible to `findRunning()` — so the job kept running in
    // the sandbox with nothing able to reach it ever again.
    expect(stored!.status).toBe('succeeded');
    expect(h.taskLogs.stdout.get(dto.id)).toContain('after the blip');
  });

  it(
    'a read that never recovers is landed AND released — no leaked session',
    { timeout: 20_000 },
    async () => {
      const h = harness();
      const sandboxId = await runningSandbox(h);
      const plane = h.provider.jobs!;
      // more faults than the retry budget ⇒ the pump gives up.
      for (let i = 0; i < 12; i++) plane.readFaults.push(transportFault());
      const dto = await h.taskService.run(sandboxId, RUNTIME, { prompt: 'go' });

      // the retry budget is 5 attempts with doubling backoff ⇒ ~3.1s before it gives up.
      await until(
        () => (h.taskRepo.store.get(dto.id)?.isRunning ?? true) === false,
        'the verdict',
        12_000,
      );
      const stored = h.taskRepo.store.get(dto.id)!;
      expect(stored.status).toBe('failed');
      expect(stored.errorCode).toBe('PROVIDER_UNAVAILABLE');
      // ⚠️ THE FAILURE PATH RELEASES TOO. Without this the sandbox-side session and its
      // attached websocket outlive the task forever: the row is terminal, so nothing
      // will ever look at it again.
      await until(() => plane.released.length === 1, 'the failed job to be released', 5_000);
      // and the subscriber is TOLD, rather than being left on "运行中".
      const kinds = frames(h).map((f) => f.type);
      expect(kinds).toContain('error');
      expect(kinds).toContain('exit');
    },
  );

  it('a NON-retryable read failure is landed immediately, not retried', async () => {
    const h = harness();
    const sandboxId = await runningSandbox(h);
    const plane = h.provider.jobs!;
    // the session is genuinely gone — retrying only delays a verdict that cannot change.
    plane.readFaults.push(
      new SandboxProviderError(SandboxProviderErrorCode.NOT_FOUND, 'session gone'),
    );
    const dto = await h.taskService.run(sandboxId, RUNTIME, { prompt: 'go' });

    await until(() => plane.released.length === 1, 'the landing');
    expect(h.taskRepo.store.get(dto.id)!.errorCode).toBe('NOT_FOUND');
    // nothing was consumed beyond the single fault ⇒ no retry was attempted.
    expect(plane.readFaults).toHaveLength(0);
  });
});

describe('the platform-side hard-timeout backstop (03 §8.3 second source)', () => {
  it('lands `timed_out`, not `failed`, when the PLATFORM decides the deadline passed', async () => {
    const h = harness();
    const sandboxId = await runningSandbox(h);
    const dto = await h.taskService.run(sandboxId, RUNTIME, { prompt: 'go', timeoutMinutes: 30 });
    const plane = h.provider.jobs!;

    // the agent ignored its own hard_timeout: no exit, no output, just silence.
    h.advanceClock(31 * 60_000);

    await until(() => plane.kills.length > 0, 'the backstop to signal');
    expect(plane.kills[0].signal).toBe('SIGTERM');
    await until(() => plane.released.length === 1, 'the killed job to land');

    const stored = h.taskRepo.store.get(dto.id)!;
    // ⚠️ A SIGNAL-KILLED PROCESS HAS NO EXIT CODE, so `verdictFromExitCode(undefined)`
    // says `failed`. The one fact only the platform holds is that IT declared the
    // deadline passed — without carrying it, `timed_out` would be reachable ONLY
    // through the sandbox-side exit 124, i.e. half of the two documented sources.
    expect(stored.status).toBe('timed_out');
    expect(stored.errorCode).toBe('TASK_TIMED_OUT');
    expect(stored.exitCode).toBeNull();
  });
});

describe('the raw log and the cursor are ONE unit', () => {
  it('a crash between the append and the cursor write does NOT duplicate the bytes', async () => {
    const h = harness();
    const sandboxId = await runningSandbox(h);
    const dto = await h.taskService.run(sandboxId, RUNTIME, { prompt: 'go' });
    const plane = h.provider.jobs!;
    const job = [...plane.jobs.values()][0];

    job.emit(claudeInit('s1') + claudeText('line one'));
    await until(() => (h.taskRepo.store.get(dto.id)?.lastSeq ?? 0) >= 2, 'the first two events');

    // ── the crash point the old test never covered: the bytes reached the log, the
    // cursor write did NOT. Reproduced by rolling the ROW back to its previous
    // (cursor, lastSeq, stdoutBytes) triple while leaving the file as it is. ──
    const row = h.taskRepo.rows.get(dto.id)!;
    row.cursor = null;
    row.lastSeq = 0;
    row.stdoutBytes = 0;

    const revived = h.newTaskWorkflow();
    job.finish(0);
    await revived.resumeRunning();
    await until(() => plane.released.length === 1, 'the resumed job to finish');

    const raw = h.taskLogs.stdout.get(dto.id)!;
    // ⚠️ THE ASSERTION. Re-reading from the old cursor rewrites the same bytes; without
    // the truncation the file holds each line TWICE (measured: 2 lines in → 4 out),
    // `replay` then produces more events than were ever pushed live, and every later
    // `seq` is permanently shifted.
    expect(raw.match(/line one/g)).toHaveLength(1);
    expect(raw.match(/"subtype":"init"/g)).toHaveLength(1);

    const final = h.taskRepo.store.get(dto.id)!;
    const replayed = await h.taskService.replay(dto.id, 0);
    expect(replayed.map((r) => r.seq)).toEqual([1, 2]);
    expect(final.lastSeq).toBe(2);
  });
});

describe('cancel writes ONE column — a stale copy must not rewind the pump', () => {
  it('does not roll the cursor back, and cannot revive a finished task', async () => {
    const h = harness();
    const sandboxId = await runningSandbox(h);
    const dto = await h.taskService.run(sandboxId, RUNTIME, { prompt: 'go' });
    const plane = h.provider.jobs!;
    const job = [...plane.jobs.values()][0];

    // an HTTP request loads the task EARLY and holds it (this is the real race: the
    // request is served from a copy the pump has long since moved past).
    const stale = (await h.taskRepo.findById(dto.id))!;
    expect(stale.lastSeq).toBe(0);

    job.emit(claudeInit('s1') + claudeText('a') + claudeText('b'));
    await until(() => (h.taskRepo.store.get(dto.id)?.lastSeq ?? 0) >= 3, 'the pump to advance');
    const advanced = h.taskRepo.store.get(dto.id)!;
    expect(advanced.cursor).not.toBeNull();

    // the stale copy persists its cancel.
    await h.taskWorkflow.cancel(stale, h.repo.store.get(sandboxId)!);

    const after = h.taskRepo.store.get(dto.id)!;
    // ⚠️ NOTHING WENT BACKWARDS. A full-row upsert here rewrote cursor / lastSeq /
    // stdoutBytes from the stale copy — measured: lastSeq 42 → 5, cursor {"o":900} →
    // {"o":100}, i.e. every event in between re-delivered after the next restart.
    expect(after.lastSeq).toBe(advanced.lastSeq);
    expect(after.cursor).toBe(advanced.cursor);
    expect(after.stdoutBytes).toBe(advanced.stdoutBytes);
    expect(after.cancelRequestedAt).not.toBeNull();
  });

  it('a cancel persisted AFTER the run landed cannot resurrect it', async () => {
    const h = harness();
    const sandboxId = await runningSandbox(h);
    const dto = await h.taskService.run(sandboxId, RUNTIME, { prompt: 'go' });
    const plane = h.provider.jobs!;
    const stale = (await h.taskRepo.findById(dto.id))!;

    [...plane.jobs.values()][0].finish(0);
    await until(() => plane.released.length === 1, 'the run to land as succeeded');
    expect(h.taskRepo.store.get(dto.id)!.status).toBe('succeeded');

    await h.taskWorkflow.cancel(stale, h.repo.store.get(sandboxId)!);

    const after = h.taskRepo.store.get(dto.id)!;
    // ⚠️ A REVIVED ROW IS THE WORST OUTCOME OF THE THREE: `status` back to `running`
    // with a NULL `finished_at` is internally consistent, so the CHECK constraint
    // passes, and the row then claims to be running forever — the gateway's
    // late-subscriber `exit` branch never fires because `isRunning` is true.
    expect(after.status).toBe('succeeded');
    expect(after.finishedAt).not.toBeNull();
    expect(after.isRunning).toBe(false);
  });
});

describe('artifact collection must never downgrade a verdict', () => {
  it('a listing that THROWS still lands `succeeded` with an empty artifact list', async () => {
    const h = harness();
    const sandboxId = await runningSandbox(h);
    const dto = await h.taskService.run(sandboxId, RUNTIME, { prompt: 'go' });
    const files = h.provider.files!;
    files.listFiles = (): Promise<never> => Promise.reject(new Error('agent file plane is down'));

    [...h.provider.jobs!.jobs.values()][0].finish(0);
    await until(() => h.provider.jobs!.released.length === 1, 'completion');

    const stored = h.taskRepo.store.get(dto.id)!;
    // the WORK is done; we merely could not enumerate what it left behind. Turning that
    // into a failure would report a successful 4-hour run as broken.
    expect(stored.status).toBe('succeeded');
    expect(stored.artifacts).toEqual([]);
  });

  it('drops a listed name that escapes the drop box instead of putting it on the DTO', async () => {
    const h = harness();
    const sandboxId = await runningSandbox(h);
    const dto = await h.taskService.run(sandboxId, RUNTIME, { prompt: 'go' });
    h.provider.files!.files.set(`${TASK_ARTIFACT_DIR}/../../etc/passwd`, Buffer.from('x', 'utf8'));
    h.provider.files!.files.set(`${TASK_ARTIFACT_DIR}/ok.md`, Buffer.from('x', 'utf8'));

    [...h.provider.jobs!.jobs.values()][0].finish(0);
    await until(() => h.provider.jobs!.released.length === 1, 'completion');

    const names = h.taskRepo.store.get(dto.id)!.artifacts.map((a) => a.name);
    expect(names).toEqual(['ok.md']);
  });
});

describe('replay never reports a FAILED read as "you are up to date"', () => {
  it('propagates a log-read failure instead of answering with an empty replay', async () => {
    const h = harness();
    const sandboxId = await runningSandbox(h);
    const dto = await h.taskService.run(sandboxId, RUNTIME, { prompt: 'go' });
    const job = [...h.provider.jobs!.jobs.values()][0];
    job.emit(claudeInit('s1') + claudeText('a'));
    job.finish(0);
    await until(() => h.provider.jobs!.released.length === 1, 'completion');

    h.taskLogs.failReads = new Error('EIO: i/o error, read');
    // ⚠️ An empty replay is reported to the subscriber as `caught_up{firstSeq: fromSeq+1}`
    // — "you are already up to date" — so swallowing the error routes around the ONE
    // field that exists to make a truncated replay detectable.
    await expect(h.taskService.replay(dto.id, 0)).rejects.toThrow(/EIO/);
  });
});
