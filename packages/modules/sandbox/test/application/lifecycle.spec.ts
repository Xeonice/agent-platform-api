import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpException } from '@nestjs/common';
import type { SandboxId } from '@platform/shared-kernel';
import type { ProcessSpec, ProcessStream, SandboxHandle } from '@platform/contracts';
import { harness, waitForStatus } from './_harness';

/**
 * `POST /api/sandboxes/:id/{start,stop,exec}` — the three lifecycle capabilities of
 * 27 §2 that had a design, an MCP tool row and a frontend contract but no code.
 *
 * ── What each group is actually defending ────────────────────────────────────────
 *  · start — that the answer is 「已受理」 rather than 「已就绪」, and that the ONE legal
 *    edge into `starting` from rest (I-SBX-1) is enforced where the CALLER can see it;
 *  · stop  — that stopping keeps the instance (otherwise `start` has nothing to start)
 *    and that a provider failure cannot strand the aggregate in `stopping`;
 *  · exec  — that a non-zero exit is a RESULT and not an error, and that the deadline
 *    exists on the platform side rather than being delegated to provider goodwill.
 */

/** A stream whose process never exits — the only way to exercise the exec deadline. */
function neverExits(): ProcessStream {
  return {
    ref: 'hanging-exec',
    // ⚠️ 契约必需，此前这个替身缺着（2026-09-05 补）。
    detach: () => undefined,
    onData: () => {},
    onExit: () => {},
    write: () => {},
    resize: () => {},
    kill: async () => {},
  };
}

/** Drive a fresh sandbox all the way to `stopped`, the state `start` operates on. */
async function stoppedSandbox(h: ReturnType<typeof harness>): Promise<string> {
  const dto = await h.service.create({ projectId: 'prj-1', runtime: 'claude-code' });
  await waitForStatus(h.service, dto.id, 'running');
  await h.service.stop(dto.id);
  return dto.id;
}

async function rejection(work: Promise<unknown>): Promise<HttpException> {
  const e = await work.then(() => null).catch((err: unknown) => err);
  expect(e).toBeInstanceOf(HttpException);
  return e as HttpException;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('POST /api/sandboxes/:id/stop (27 §2)', () => {
  it('stops the instance, lands `stopped`, and KEEPS the provider handle', async () => {
    const h = harness();
    const dto = await h.service.create({ projectId: 'prj-1', runtime: 'claude-code' });
    await waitForStatus(h.service, dto.id, 'running');

    const stopped = await h.service.stop(dto.id);

    expect(stopped.status).toBe('stopped');
    expect(h.provider.calls).toContain('stop');
    // ⚠️ `destroy` MUST NOT have run. If stopping tore the instance down, `start`
    // below would have nothing to bring back and the pair would silently degrade into
    // 「destroy + recreate」 — a different product promise (P22 §2 keeps the workspace).
    expect(h.provider.calls).not.toContain('destroy');
    const stored = await h.repo.findById(dto.id as SandboxId);
    expect(stored!.providerSandboxId).toBe(`fake-${dto.id}`);
    // and the workspace was never cleaned — `cleanup:` is what the harness logs for it.
    expect(h.wsCalls.some((c) => c.startsWith(`cleanup:${dto.id}`))).toBe(false);
  });

  it('refuses anything that is not running/idle with 409 INVALID_STATE', async () => {
    const h = harness();
    const id = await stoppedSandbox(h);
    const before = h.provider.calls.length;

    const e = await rejection(h.service.stop(id));

    expect(e.getStatus()).toBe(409);
    expect(e.getResponse()).toMatchObject({ code: 'INVALID_STATE', retryable: false });
    // 「被拒」, not 「失败」: the provider was never touched a second time.
    expect(h.provider.calls).toHaveLength(before);
  });

  it('404s an id that does not exist', async () => {
    const h = harness();
    const e = await rejection(h.service.stop('sbx-nope'));
    expect(e.getStatus()).toBe(404);
  });

  it('a provider that fails to stop leaves `failed`, never a wedged `stopping`', async () => {
    const h = harness();
    const dto = await h.service.create({ projectId: 'prj-1', runtime: 'claude-code' });
    await waitForStatus(h.service, dto.id, 'running');
    h.provider.stop = async (): Promise<void> => {
      throw new Error('daemon went away');
    };

    await expect(h.service.stop(dto.id)).rejects.toThrow(/daemon went away/);

    // ⚠️ `stopping` is not a resting state — `destroy` can recover from it, but a
    // sandbox parked there answers no user question. `failed` is both truthful and
    // destroyable.
    const stored = await h.repo.findById(dto.id as SandboxId);
    expect(stored!.status).toBe('failed');
  });
});

describe('POST /api/sandboxes/:id/start (27 §2, I-SBX-1/9)', () => {
  it('answers `starting` — the state the platform is actually in, not `stopped`', async () => {
    const h = harness();
    const id = await stoppedSandbox(h);

    const dto = await h.service.start(id);

    // ⚠️ THIS IS THE LOAD-BEARING ASSERTION OF THE WHOLE ASYNC SHAPE. `restart()`
    // performs its first transition BEFORE its first await, which is what lets the
    // response describe what happened rather than what arrived. If that ever stops
    // holding, the endpoint would report `stopped` while a start was under way — i.e.
    // the frontend would show a [启动] button for a sandbox already starting.
    expect(dto.status).toBe('starting');
    await waitForStatus(h.service, id, 'running');
  });

  it('re-runs the whole `starting` 段 but NOT preparing-workspace (I-SBX-9)', async () => {
    const h = harness();
    const id = await stoppedSandbox(h);
    const prepares = h.wsCalls.filter((c) => c.startsWith('prepare:')).length;
    const installsBefore = h.installInputs.length;

    await h.service.start(id);
    await waitForStatus(h.service, id, 'running');

    // the workspace directory is still there ⇒ no second prepare (03 §4, 23 I-SBX-9)…
    expect(h.wsCalls.filter((c) => c.startsWith('prepare:')).length).toBe(prepares);
    // …and no second instance either: `create` is NOT part of the restart path.
    expect(h.provider.calls.filter((c) => c === 'create')).toHaveLength(1);
    // …but the instance IS a fresh process tree, so the CLI is re-verified.
    expect(h.installInputs.length).toBe(installsBefore + 1);
    const stored = await h.repo.findById(id as SandboxId);
    const tail = stored!.transitions.map((t) => t.to).slice(-3);
    expect(tail).toEqual(['stopped', 'starting', 'running']);
  });

  it('refuses a running sandbox with 409 INVALID_STATE and starts nothing', async () => {
    const h = harness();
    const dto = await h.service.create({ projectId: 'prj-1', runtime: 'claude-code' });
    await waitForStatus(h.service, dto.id, 'running');
    const starts = h.provider.calls.filter((c) => c === 'start').length;

    const e = await rejection(h.service.start(dto.id));

    expect(e.getStatus()).toBe(409);
    expect(e.getResponse()).toMatchObject({ code: 'INVALID_STATE', retryable: false });
    expect(h.provider.calls.filter((c) => c === 'start')).toHaveLength(starts);
  });

  it('refuses a `failed` sandbox — a restart is not the recovery path for one', async () => {
    const h = harness();
    const dto = await h.service.create({ projectId: 'prj-1', runtime: 'claude-code' });
    await waitForStatus(h.service, dto.id, 'running');
    const stored = await h.repo.findById(dto.id as SandboxId);
    stored!.transitionTo('failed', 'health-check', new Date());

    const e = await rejection(h.service.start(dto.id));
    expect(e.getStatus()).toBe(409);
  });

  it('404s an id that does not exist', async () => {
    const h = harness();
    const e = await rejection(h.service.start('sbx-nope'));
    expect(e.getStatus()).toBe(404);
  });

  it('refuses a `stopped` row that never bound an instance, instead of lying (I-SBX-3)', async () => {
    const h = harness();
    // A row the transition table permits but `bindRuntime` never touched. It is not
    // reachable through today's happy path — a migrated row or a hand-edited DB is —
    // and that is exactly why it needs a check rather than an assumption.
    const dto = await h.service.create({ projectId: 'prj-1', runtime: 'claude-code' });
    await waitForStatus(h.service, dto.id, 'running');
    const stored = await h.repo.findById(dto.id as SandboxId);
    stored!.bindRuntime({ providerSandboxId: '', workspacePath: '/tmp/ws', providerState: null });
    stored!.transitionTo('stopping', 'user', new Date());
    stored!.transitionTo('stopped', 'user', new Date());

    const e = await rejection(h.service.start(dto.id));

    // ⚠️ WITHOUT THIS THE CALLER IS TOLD `starting` AND NOTHING STARTS: the background
    // restart dies on `handleOf`'s bare Error and `restartSafely` swallows it. A 409
    // the caller can read beats a log line only the operator can.
    expect(e.getStatus()).toBe(409);
    expect(e.getResponse()).toMatchObject({ code: 'INVALID_STATE' });
    expect((await h.service.get(dto.id)).status).toBe('stopped');
  });

  it('a start that fails leaves `failed` instead of taking the process down', async () => {
    const h = harness();
    const id = await stoppedSandbox(h);
    h.provider.start = async (): Promise<void> => {
      throw new Error('micro-VM refused to boot');
    };

    await h.service.start(id);
    await waitForStatus(h.service, id, 'failed');
  });

  it('…and the background promise RESOLVES, because nobody is there to await it', async () => {
    const h = harness();
    const id = await stoppedSandbox(h);
    const stored = await h.repo.findById(id as SandboxId);
    h.provider.start = async (): Promise<void> => {
      throw new Error('micro-VM refused to boot');
    };

    // ⚠️ ASSERTED DIRECTLY, BECAUSE THE STATE ASSERTION ABOVE DOES NOT COVER IT.
    // `restart` marks `failed` on its way out either way, so a version WITHOUT the
    // catch passes that test and still leaves an unhandled rejection behind — which
    // under Node's default takes the whole process down, i.e. one sandbox that cannot
    // come back would kill the platform. `restartSafely` is the difference, and this
    // is the only line that can see it.
    await expect(h.provision.restartSafely(stored!, h.provider)).resolves.toBeUndefined();
  });
});

describe('POST /api/sandboxes/:id/exec (27 §2, I-SBX-3)', () => {
  it('runs the command through `sh -c` and reports stdout + exit code', async () => {
    const h = harness();
    const dto = await h.service.create({ projectId: 'prj-1', runtime: 'claude-code' });
    await waitForStatus(h.service, dto.id, 'running');
    h.provider.execExitCodes = [{ match: /git status/, exitCode: 0, stdout: 'nothing to commit' }];

    const result = await h.service.exec(dto.id, { command: 'git status --short' });

    expect(result).toEqual({ stdout: 'nothing to commit', stderr: '', exitCode: 0 });
    // shell syntax has to survive to the sandbox — argv-splitting the string here would
    // silently break every pipe and redirect a caller writes.
    expect(h.provider.execCalls.at(-1)).toEqual(['sh', '-c', 'git status --short']);
  });

  it('a NON-ZERO exit is a 200 result, not an error', async () => {
    const h = harness();
    const dto = await h.service.create({ projectId: 'prj-1', runtime: 'claude-code' });
    await waitForStatus(h.service, dto.id, 'running');
    h.provider.execExitCodes = [{ match: /pytest/, exitCode: 3, stdout: '2 failed' }];

    // ⚠️ THE WHOLE POINT OF THE ENDPOINT. `{stdout, stderr, exitCode}` is the contract
    // (10 §7.3); mapping a failing command onto an HTTP error would mean a caller
    // running a test suite could never read the failures — and would make `exitCode`
    // a field that only ever holds 0.
    const result = await h.service.exec(dto.id, { command: 'pytest' });
    expect(result).toEqual({ stdout: '2 failed', stderr: '', exitCode: 3 });
  });

  it('passes a deadline DOWN to the provider so the process dies sandbox-side too', async () => {
    const h = harness();
    const dto = await h.service.create({ projectId: 'prj-1', runtime: 'claude-code' });
    await waitForStatus(h.service, dto.id, 'running');
    let seen: ProcessSpec | undefined;
    const spawn = h.provider.spawn.bind(h.provider);
    h.provider.spawn = async (handle: SandboxHandle, spec: ProcessSpec): Promise<ProcessStream> => {
      seen = spec;
      return spawn(handle, spec);
    };

    await h.service.exec(dto.id, { command: 'true' });

    // without this the platform-side race would still end the REQUEST, but the command
    // would keep running inside the sandbox forever — an orphan nobody can see.
    expect(seen?.timeoutMs).toBe(60_000);
    expect(seen?.tty).toBe(false);
  });

  it('gives up with 504 TIMEOUT when the command never finishes', async () => {
    vi.useFakeTimers();
    const h = harness();
    const dto = await h.service.create({ projectId: 'prj-1', runtime: 'claude-code' });
    await vi.waitFor(async () => {
      expect((await h.service.get(dto.id)).status).toBe('running');
    });
    h.provider.spawn = async (): Promise<ProcessStream> => neverExits();

    const work = h.service.exec(dto.id, { command: 'sleep infinity' });
    const settled = rejection(work);
    await vi.advanceTimersByTimeAsync(60_000);
    const e = await settled;

    // 504 + retryable:true — a timeout is 类 D (基础设施), the one shape in this file
    // where offering [重试] is right.
    expect(e.getStatus()).toBe(504);
    expect(e.getResponse()).toMatchObject({ code: 'TIMEOUT', retryable: true });
  });

  it('refuses a stopped sandbox with 409 and never reaches the provider (I-SBX-3)', async () => {
    const h = harness();
    const id = await stoppedSandbox(h);
    const calls = h.provider.execCalls.length;

    const e = await rejection(h.service.exec(id, { command: 'ls' }));

    expect(e.getStatus()).toBe(409);
    expect(e.getResponse()).toMatchObject({ code: 'INVALID_STATE' });
    // there is no process to spawn into before `start()` (04 §2.3) — the refusal has
    // to happen here, not as a provider error deep inside the exec.
    expect(h.provider.execCalls).toHaveLength(calls);
  });

  it('404s an id that does not exist', async () => {
    const h = harness();
    const e = await rejection(h.service.exec('sbx-nope', { command: 'ls' }));
    expect(e.getStatus()).toBe(404);
  });
});
