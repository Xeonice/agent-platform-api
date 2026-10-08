import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SandboxProviderError, SandboxProviderErrorCode } from '@platform/contracts';
import type {
  ImageFacade,
  ProcessSpec,
  ProcessStream,
  ProviderRegistry,
  SandboxHandle,
  SandboxProvider,
  SandboxProviderContext,
  SandboxRuntimeStatus,
} from '@platform/contracts';
import type { RuntimeCredentialService, RuntimeRefreshDue } from '@platform/credential';
import { HelperContainerSession } from '../../../packages/modules/runtime/src/infrastructure/helper/helper-container.session';
import { ContainerAuthHelper } from '../../../packages/modules/runtime/src/infrastructure/helper/container-auth-helper';
import { CredentialRefreshScanner } from '../../../packages/modules/runtime/src/infrastructure/refresh/credential-refresh.scanner';
import { DefaultRuntimeAdapterRegistry } from '../../../packages/modules/runtime/src/infrastructure/registry/runtime-adapter.registry';
import { CodexAdapter } from '../../../packages/modules/runtime/src/infrastructure/adapters/codex/codex.adapter';
import { ClaudeCodeAdapter } from '../../../packages/modules/runtime/src/infrastructure/adapters/claude-code/claude-code.adapter';
import { HelperUnavailableError } from '../../../packages/modules/runtime/src/domain/ports/auth-helper.port';
import type { AuthHelper } from '../../../packages/modules/runtime/src/domain/ports/auth-helper.port';
import { unused } from '../../support/strict-ports';

const HELPER_NAME = 'box-auth-helper';
/** What BoxLite 0.9.7 reports for an exec into a VM that died behind a running record. */
const DEAD_VM =
  'invalid state: Box process is no longer running (PID file missing, process dead, ' +
  'or start-time mismatch indicating PID reuse)';

function exited(stdout: string, exitCode: number | null): ProcessStream {
  return {
    ref: 'exec',
    onData: (cb) => {
      if (stdout !== '') cb(Buffer.from(stdout));
    },
    onExit: (cb) => cb(exitCode),
    write: () => {},
    resize: () => {},
    kill: async () => {},
    detach: () => {},
  };
}

/**
 * BoxLite-shaped external boundary: box names are unique, every create mints a fresh id,
 * `inspect` reads local state only, and a VM can die while local state still says running.
 */
class FakeBoxlite implements SandboxProvider {
  readonly name = 'boxlite';
  readonly capabilities = {
    spawnTty: true,
    volumeMount: true,
    updateResources: false,
    pauseResume: false,
    snapshot: false,
    watchEvents: false,
    headlessTask: false,
  };
  readonly boxes = new Map<
    string,
    { name: string; status: 'configured' | 'running' | 'stopped' }
  >();
  /** VMs that are gone although BoxLite's local state still reports them running. */
  readonly deadVms = new Set<string>();
  /** Every process spec handed to `spawn`, in order. */
  readonly specs: ProcessSpec[] = [];
  startFailures = 0;
  inspectFailure: Error | null = null;
  inspectHangs = false;
  /** Set ⇒ the next inspect answers from the state it saw, but only once released. */
  private inspectGate: Promise<void> | null = null;
  execDown = false;
  mintExitCode = 0;
  /** The next N commands (other than the `true` probe) fail with a transient INTERNAL. */
  flakyExecs = 0;
  /** The next N mints lose their channel: the stream ends without an exit code. */
  collapsedMints = 0;
  /** The `true` probe never comes back (a helper too busy to answer in time). */
  probeHangs = false;
  /** The interactive login command fails like this (null = it starts). */
  ptyFailure: Error | null = null;
  /** The interactive login command finds its box removed under it. */
  vanishBeforePty = false;
  killFails = false;
  private serial = 0;
  constructor(readonly calls: string[]) {}

  helpers(): string[] {
    return [...this.boxes].filter(([, box]) => box.name === HELPER_NAME).map(([id]) => id);
  }
  holdNextInspect(): () => void {
    let release!: () => void;
    this.inspectGate = new Promise<void>((resolve) => (release = resolve));
    return release;
  }
  async stageImage() {
    this.calls.push('stageImage');
  }
  async destroyBySandboxId(sandboxId: string) {
    this.calls.push('destroyBySandboxId');
    for (const [id, box] of this.boxes) if (box.name === `box-${sandboxId}`) this.boxes.delete(id);
  }
  async create(ctx: SandboxProviderContext): Promise<SandboxHandle> {
    this.calls.push('create');
    const name = `box-${ctx.sandboxId}`;
    if ([...this.boxes.values()].some((box) => box.name === name))
      throw new SandboxProviderError(SandboxProviderErrorCode.INTERNAL, `already exists: ${name}`);
    const id = `vm-${++this.serial}`;
    this.boxes.set(id, { name, status: 'configured' });
    return { provider: this.name, providerSandboxId: id };
  }
  async start(handle: SandboxHandle) {
    this.calls.push('start');
    const box = this.boxes.get(handle.providerSandboxId);
    if (!box) throw new SandboxProviderError(SandboxProviderErrorCode.NOT_FOUND, 'box not found');
    if (this.startFailures > 0) {
      this.startFailures -= 1;
      throw new SandboxProviderError(
        SandboxProviderErrorCode.PROVIDER_UNAVAILABLE,
        `boxlite micro-VM ${handle.providerSandboxId} did not accept an exec in time`,
      );
    }
    box.status = 'running';
  }
  stopHangs = false;
  stopFails = false;
  async stop() {
    this.calls.push('stop');
    if (this.stopHangs) return new Promise<void>(() => {});
    if (this.stopFails)
      throw new SandboxProviderError(SandboxProviderErrorCode.INTERNAL, 'guest did not answer');
  }
  async destroy(handle: SandboxHandle) {
    this.calls.push('destroy');
    this.boxes.delete(handle.providerSandboxId);
  }
  async inspect(handle: SandboxHandle): Promise<SandboxRuntimeStatus> {
    this.calls.push('inspect');
    if (this.inspectHangs) return new Promise<SandboxRuntimeStatus>(() => {});
    if (this.inspectFailure) throw this.inspectFailure;
    const box = this.boxes.get(handle.providerSandboxId);
    const answer: SandboxRuntimeStatus = !box
      ? { lifecycleState: 'instance_missing' }
      : { lifecycleState: box.status === 'running' ? 'instance_running' : 'instance_exited' };
    const gate = this.inspectGate;
    this.inspectGate = null;
    if (gate !== null) await gate;
    return answer;
  }
  async spawn(handle: SandboxHandle, spec: ProcessSpec): Promise<ProcessStream> {
    this.specs.push(spec);
    const probe = spec.cmd.length === 1 && spec.cmd[0] === 'true';
    this.calls.push(spec.tty ? 'spawn:pty' : probe ? 'spawn:probe' : 'spawn:exec');
    if (spec.tty && this.vanishBeforePty) this.boxes.delete(handle.providerSandboxId);
    if (this.execDown || !this.boxes.has(handle.providerSandboxId))
      throw new SandboxProviderError(
        SandboxProviderErrorCode.NOT_FOUND,
        `box ${handle.providerSandboxId} not found`,
      );
    if (this.deadVms.has(handle.providerSandboxId))
      throw new SandboxProviderError(SandboxProviderErrorCode.INTERNAL, DEAD_VM);
    if (probe && this.probeHangs) return { ...exited('', 0), onExit: () => {} };
    if (!probe && this.flakyExecs > 0) {
      this.flakyExecs -= 1;
      throw new SandboxProviderError(
        SandboxProviderErrorCode.INTERNAL,
        'gRPC transport error: transport error',
      );
    }
    if (spec.tty) {
      if (this.ptyFailure) throw this.ptyFailure;
      return {
        ...exited('', 0),
        ref: 'pty',
        kill: async () => {
          if (this.killFails) throw new Error('execution handle invalidated');
        },
      };
    }
    if (spec.cmd.join(' ').includes('mktemp')) {
      if (this.collapsedMints > 0) {
        this.collapsedMints -= 1;
        return exited('', null);
      }
      return exited(this.mintExitCode === 0 ? '/root/auth-helper.X1\n' : '', this.mintExitCode);
    }
    if (spec.cmd.join(' ').includes('cat "$1"')) return exited('{"tokens":{}}', 0);
    return exited('', 0);
  }
}

function rig(options: { registered?: boolean } = {}) {
  const calls: string[] = [];
  const provider = new FakeBoxlite(calls);
  let registered = options.registered ?? true;
  const registry: ProviderRegistry = {
    defaultProvider: provider.name,
    get: () => provider,
    has: (name) => name === provider.name,
    list: () => [provider],
    register: () => {
      throw new Error('fixed provider fixture');
    },
  };
  const images: ImageFacade = {
    resolveForTask: async () => {
      throw new Error('task images are outside this scenario');
    },
    findTaskImage: async () => null,
    findTaskImageSummary: async () => null,
    findRegisteredByRef: async (ref) => {
      calls.push('resolveImage');
      return registered
        ? {
            manifestId: 'builtin',
            ref,
            digest: `sha256:${'a'.repeat(64)}`,
            validationStatus: 'valid',
            isActive: true,
            isBuiltin: true,
          }
        : null;
    },
  };
  return {
    calls,
    provider,
    session: new HelperContainerSession(registry, images),
    register: () => {
      registered = true;
    },
    count: (call: string) => calls.filter((c) => c === call).length,
  };
}

const BUILD = ['destroyBySandboxId', 'resolveImage', 'stageImage', 'create', 'start'];

beforeEach(() => {
  vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('the platform auth helper heals itself instead of failing until the API restarts', () => {
  it('destroys a half-built helper when start fails, so the next attempt cannot collide on its name', async () => {
    const r = rig();
    r.provider.startFailures = 1;
    await expect(r.session.require()).rejects.toBeInstanceOf(HelperUnavailableError);
    expect(r.calls).toEqual([...BUILD, 'stop', 'destroy']);
    expect(r.provider.boxes.size).toBe(0);
    expect(r.session.status()).toMatchObject({
      ready: false,
      lastError: expect.stringContaining('did not accept an exec in time'),
    });
    const helper = await r.session.require();
    expect(r.provider.helpers()).toEqual([helper.handle.providerSandboxId]);
    expect(r.session.status()).toEqual({ ready: true, starting: false, lastError: null });
  });

  it.each([
    ['refuses to stop', (r: ReturnType<typeof rig>) => (r.provider.stopFails = true)],
    ['never answers the stop', (r: ReturnType<typeof rig>) => (r.provider.stopHangs = true)],
  ])('a half-built helper that %s is still destroyed', async (_label, breakStop) => {
    vi.useFakeTimers();
    const r = rig();
    r.provider.startFailures = 1;
    breakStop(r);
    const failure = r.session.require();
    const settled = expect(failure).rejects.toBeInstanceOf(HelperUnavailableError);
    await vi.advanceTimersByTimeAsync(20_000);
    await settled;
    expect(r.calls).toEqual([...BUILD, 'stop', 'destroy']);
    expect(r.provider.boxes.size).toBe(0);
  });

  it('clears a leftover helper first, even while the image is not registered yet', async () => {
    const r = rig({ registered: false });
    r.provider.boxes.set('stale', { name: HELPER_NAME, status: 'stopped' });
    await expect(r.session.require()).rejects.toThrow(/^auth helper 容器不可用：.*还没注册进平台/);
    expect(r.calls).toEqual(['destroyBySandboxId', 'resolveImage']);
    expect(r.provider.boxes.size).toBe(0);
    r.register();
    const helper = await r.session.require();
    expect(r.calls.slice(2)).toEqual(BUILD);
    expect(r.provider.helpers()).toEqual([helper.handle.providerSandboxId]);
  });

  it('reuses a running helper after one read-only inspect', async () => {
    const r = rig();
    const first = await r.session.require();
    r.calls.length = 0;
    expect(await r.session.require()).toBe(first);
    expect(r.calls).toEqual(['inspect']);
  });

  it.each([
    [
      'stopped',
      (r: ReturnType<typeof rig>, id: string) => (r.provider.boxes.get(id)!.status = 'stopped'),
    ],
    ['removed', (r: ReturnType<typeof rig>, id: string) => r.provider.boxes.delete(id)],
    [
      'reported NOT_FOUND',
      (r: ReturnType<typeof rig>) =>
        (r.provider.inspectFailure = new SandboxProviderError(
          SandboxProviderErrorCode.NOT_FOUND,
          'box not found',
        )),
    ],
  ])('rebuilds exactly once when the helper instance is %s', async (_label, breakIt) => {
    const r = rig();
    const first = await r.session.require();
    breakIt(r, first.handle.providerSandboxId);
    r.calls.length = 0;
    const next = await r.session.require();
    expect(next.handle.providerSandboxId).not.toBe(first.handle.providerSandboxId);
    expect(r.calls).toEqual(['inspect', ...BUILD]);
    expect(r.provider.helpers()).toEqual([next.handle.providerSandboxId]);
  });

  it('concurrent callers that find the same dead helper share one rebuild', async () => {
    const r = rig();
    const first = await r.session.require();
    r.provider.boxes.get(first.handle.providerSandboxId)!.status = 'stopped';
    r.calls.length = 0;
    const all = await Promise.all([r.session.require(), r.session.require(), r.session.require()]);
    expect(new Set(all.map((h) => h.handle.providerSandboxId)).size).toBe(1);
    expect(all[0]!.handle.providerSandboxId).not.toBe(first.handle.providerSandboxId);
    expect([r.count('inspect'), r.count('create'), r.count('start')]).toEqual([3, 1, 1]);
    expect(r.provider.helpers()).toEqual([all[0]!.handle.providerSandboxId]);
  });

  it('bootstrap only fires the preheat; a login racing it joins the same creation', async () => {
    const r = rig();
    expect(r.session.onApplicationBootstrap()).toBeUndefined();
    expect(r.session.status().starting).toBe(true);
    const helper = await r.session.require();
    expect(r.count('create')).toBe(1);
    expect(r.provider.helpers()).toEqual([helper.handle.providerSandboxId]);
  });

  it('an inspect that errors for another reason keeps the helper', async () => {
    const r = rig();
    const first = await r.session.require();
    r.provider.inspectFailure = new SandboxProviderError(
      SandboxProviderErrorCode.INTERNAL,
      'database is locked',
    );
    r.calls.length = 0;
    expect(await r.session.require()).toBe(first);
    expect(r.calls).toEqual(['inspect']);
  });

  it('an unverifiable helper is reused with one warning, repeated only after a clear answer', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const r = rig();
    const first = await r.session.require();
    const unverified = () =>
      warn.mock.calls.filter(([m]) => String(m).includes('没能确认死活')).length;
    r.provider.inspectFailure = new Error('database is locked');
    await r.session.require();
    await r.session.require();
    expect(unverified()).toBe(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(first.handle.providerSandboxId));
    r.provider.inspectFailure = null;
    await r.session.require();
    r.provider.inspectFailure = new Error('database is locked');
    await r.session.require();
    expect(unverified()).toBe(2);
  });

  it('a caller whose inspect returns after the helper was replaced gets the replacement', async () => {
    const r = rig();
    const first = await r.session.require();
    // A asks about the first helper; the answer ("running") is held back while B finds the
    // helper broken and rebuilds it. A must not walk away with the stale handle.
    const release = r.provider.holdNextInspect();
    const a = r.session.require();
    await vi.waitFor(() => expect(r.count('inspect')).toBe(1));
    r.session.invalidate(first.handle, 'B saw it fail');
    const b = await r.session.require();
    expect(b.handle.providerSandboxId).not.toBe(first.handle.providerSandboxId);
    release();
    expect(await a).toBe(b);
    expect(r.count('create')).toBe(2);
  });

  it('an inspect that does not answer within its budget keeps the helper', async () => {
    const r = rig();
    const first = await r.session.require();
    vi.useFakeTimers();
    r.provider.inspectHangs = true;
    r.calls.length = 0;
    const pending = r.session.require();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await pending).toBe(first);
    expect(r.calls).toEqual(['inspect']);
  });

  it('a failed rebuild is reported once and retried only by the next caller', async () => {
    const r = rig();
    const first = await r.session.require();
    r.provider.boxes.delete(first.handle.providerSandboxId);
    r.provider.startFailures = 1;
    await expect(r.session.require()).rejects.toThrow(
      /^auth helper 容器不可用：.*did not accept an exec in time/,
    );
    const creates = r.count('create');
    expect(creates).toBe(2);
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(r.count('create')).toBe(creates);
    const healed = await r.session.require();
    expect(r.count('create')).toBe(creates + 1);
    expect(r.provider.helpers()).toEqual([healed.handle.providerSandboxId]);
  });

  it('invalidating with a stale handle never discards the helper that replaced it', async () => {
    const r = rig();
    const first = await r.session.require();
    r.session.invalidate(first.handle, 'first instance failed');
    const second = await r.session.require();
    r.session.invalidate(first.handle, 'late report about the first instance');
    expect(r.session.status()).toMatchObject({ ready: true, lastError: null });
    r.calls.length = 0;
    expect(await r.session.require()).toBe(second);
    expect(r.calls).toEqual(['inspect']);
  });

  it('observe tells an invalidated helper awaiting its rebuild apart from one that could not be built', async () => {
    const r = rig();
    const first = await r.session.require();
    r.session.invalidate(first.handle, '存活复核：实例已不在运行（instance_dead）');
    expect(await r.session.observe()).toEqual({
      ready: false,
      starting: false,
      lastError: expect.stringContaining('instance_dead'),
      awaitingRebuild: true,
    });
    r.provider.startFailures = 1;
    await expect(r.session.require()).rejects.toBeInstanceOf(HelperUnavailableError);
    const failed = await r.session.observe();
    expect(failed.lastError).toContain('did not accept an exec in time');
    expect(failed).not.toHaveProperty('awaitingRebuild');
  });

  it('observe answers from state and one inspect, never creating, starting, destroying or executing', async () => {
    const r = rig();
    expect(await r.session.observe()).toEqual({ ready: false, starting: false, lastError: null });
    expect(r.calls).toEqual([]);
    const first = await r.session.require();
    r.calls.length = 0;
    expect(await r.session.observe()).toMatchObject({
      ready: true,
      instanceState: 'instance_running',
      stale: false,
    });
    r.provider.boxes.get(first.handle.providerSandboxId)!.status = 'stopped';
    expect(await r.session.observe()).toMatchObject({
      ready: true,
      instanceState: 'instance_exited',
      stale: true,
    });
    r.provider.inspectFailure = new Error('socket hang up');
    const unknown = await r.session.observe();
    expect(unknown).toMatchObject({ ready: true, probeError: 'socket hang up' });
    expect(unknown).not.toHaveProperty('stale');
    expect(r.calls).toEqual(['inspect', 'inspect', 'inspect']);
    expect(r.session.status().ready).toBe(true);
  });
});

describe('the container auth helper rebuilds once when the helper cannot run its first command', () => {
  it('a dead VM behind a running record is confirmed dead, invalidated, rebuilt and used', async () => {
    const r = rig();
    const first = await r.session.require();
    r.provider.deadVms.add(first.handle.providerSandboxId);
    const requires = vi.spyOn(r.session, 'require');
    const invalidations = vi.spyOn(r.session, 'invalidate');
    r.calls.length = 0;
    const opened = await new ContainerAuthHelper(r.session).openSession(['codex', 'login']);
    expect(opened.homeDir).toBe('/root/auth-helper.X1');
    expect(requires).toHaveBeenCalledTimes(2);
    expect(invalidations).toHaveBeenCalledOnce();
    expect(invalidations).toHaveBeenCalledWith(
      first.handle,
      expect.stringMatching(/建隔离 HOME.*INTERNAL.*no longer running/),
    );
    expect(r.calls.slice(0, 3)).toEqual(['inspect', 'spawn:exec', 'spawn:probe']);
    const helpers = r.provider.helpers();
    expect(helpers).toHaveLength(1);
    expect(helpers[0]).not.toBe(first.handle.providerSandboxId);
    await opened.dispose();
  });

  it('one transient INTERNAL on a helper that still answers rebuilds nothing; other sessions keep running', async () => {
    const r = rig();
    const helper = new ContainerAuthHelper(r.session);
    const other = await helper.openSession(['codex', 'login']);
    const [box] = r.provider.helpers();
    r.provider.flakyExecs = 1;
    const invalidations = vi.spyOn(r.session, 'invalidate');
    const opened = await helper.openSession(['claude', 'setup-token']);
    expect(opened.homeDir).toBe('/root/auth-helper.X1');
    expect(invalidations).not.toHaveBeenCalled();
    expect([r.count('create'), r.count('destroyBySandboxId'), r.count('spawn:probe')]).toEqual([
      1, 1, 1,
    ]);
    expect(r.provider.helpers()).toEqual([box]);
    await opened.dispose();
    await other.dispose();
  });

  it('a helper too busy to answer the check in time is kept, not torn down', async () => {
    vi.useFakeTimers();
    const r = rig();
    await r.session.require();
    r.provider.flakyExecs = 1;
    r.provider.probeHangs = true;
    const invalidations = vi.spyOn(r.session, 'invalidate');
    const opening = new ContainerAuthHelper(r.session).openSession(['codex', 'login']);
    await vi.advanceTimersByTimeAsync(10_000);
    const opened = await opening;
    expect(opened.homeDir).toBe('/root/auth-helper.X1');
    expect(invalidations).not.toHaveBeenCalled();
    expect(r.count('create')).toBe(1);
  });

  it('a mint whose channel collapsed is checked, not read as the command failing', async () => {
    const r = rig();
    await r.session.require();
    r.provider.collapsedMints = 1;
    const invalidations = vi.spyOn(r.session, 'invalidate');
    const opened = await new ContainerAuthHelper(r.session).openSession(['codex', 'login']);
    expect(opened.homeDir).toBe('/root/auth-helper.X1');
    expect(invalidations).not.toHaveBeenCalled();
    expect([r.count('create'), r.count('spawn:probe')]).toEqual([1, 1]);
  });

  it('gives up after the rebuilt helper fails too, as a helper outage', async () => {
    const r = rig();
    await r.session.require();
    r.provider.execDown = true;
    const requires = vi.spyOn(r.session, 'require');
    const invalidations = vi.spyOn(r.session, 'invalidate');
    const failure = new ContainerAuthHelper(r.session).openSession(['codex', 'login']);
    await expect(failure).rejects.toBeInstanceOf(HelperUnavailableError);
    await expect(failure).rejects.toThrow(/not found/);
    expect(requires).toHaveBeenCalledTimes(2);
    expect(invalidations).toHaveBeenCalledTimes(2);
    expect(r.count('create')).toBe(2);
  });

  it('a command that runs but exits non-zero is the command’s failure, not the helper’s', async () => {
    const r = rig();
    await r.session.require();
    r.provider.mintExitCode = 1;
    const requires = vi.spyOn(r.session, 'require');
    const invalidations = vi.spyOn(r.session, 'invalidate');
    const failure = new ContainerAuthHelper(r.session).openSession(['codex', 'login']);
    await expect(failure).rejects.toThrow(/exit=1/);
    await expect(failure).rejects.not.toBeInstanceOf(HelperUnavailableError);
    expect(requires).toHaveBeenCalledOnce();
    expect(invalidations).not.toHaveBeenCalled();
    expect(r.count('create')).toBe(1);
  });

  it('a login command whose helper vanished under it is a helper outage, and the handle is dropped', async () => {
    const r = rig();
    const first = await r.session.require();
    r.provider.vanishBeforePty = true;
    const invalidations = vi.spyOn(r.session, 'invalidate');
    const failure = new ContainerAuthHelper(r.session).openSession(['codex', 'login']);
    await expect(failure).rejects.toBeInstanceOf(HelperUnavailableError);
    expect(invalidations).toHaveBeenCalledWith(
      first.handle,
      expect.stringMatching(/起会话.*NOT_FOUND/),
    );
    expect(r.session.status().ready).toBe(false);
  });

  it('a login command missing from a healthy helper is that command’s failure, not an outage', async () => {
    const r = rig();
    await r.session.require();
    // BoxLite reports a missing executable as "… not found …", which maps to NOT_FOUND too.
    r.provider.ptyFailure = new SandboxProviderError(
      SandboxProviderErrorCode.NOT_FOUND,
      "executable 'acme' not found in $PATH",
    );
    const invalidations = vi.spyOn(r.session, 'invalidate');
    const failure = new ContainerAuthHelper(r.session).openSession(['acme', 'login']);
    await expect(failure).rejects.toThrow(/executable 'acme' not found/);
    await expect(failure).rejects.not.toBeInstanceOf(HelperUnavailableError);
    expect(invalidations).not.toHaveBeenCalled();
    expect(r.session.status().ready).toBe(true);
  });

  it('opens the session inside the helper with its own HOME, declared config dirs and stdin-only seeds', async () => {
    const r = rig();
    const seed = '{"tokens":{"refresh_token":"rt-secret"}}';
    const opened = await new ContainerAuthHelper(r.session).openSession(
      ['codex', 'login'],
      [{ relPath: '.codex/auth.json', content: seed, mode: 0o600 }],
      ['CODEX_HOME', 'ACME_CONFIG_DIR'],
    );
    const home = opened.homeDir;
    const [mint, written, pty] = r.provider.specs;
    // The isolated HOME lives under the helper's own $HOME (codex refuses /tmp), never in /tmp
    // unless the image has no HOME at all.
    expect(mint).toMatchObject({ tty: false });
    expect(mint!.cmd.join(' ')).toContain('d="${HOME:-/tmp}"');
    expect(mint!.cmd.join(' ')).toContain('mktemp -d "$d/auth-helper.XXXXXXXX"');
    // Seeds go through stdin only: the credential never reaches argv.
    expect(written).toMatchObject({ tty: false, stdin: seed });
    expect(written!.cmd.slice(-2)).toEqual([`${home}/.codex/auth.json`, '600']);
    expect(written!.cmd.join(' ')).not.toContain('rt-secret');
    expect(pty).toMatchObject({
      cmd: ['codex', 'login'],
      tty: true,
      cwd: home,
      env: { TERM: 'xterm-256color', HOME: home, CODEX_HOME: home, ACME_CONFIG_DIR: home },
    });
    expect(await opened.readFile('auth.json')).toBe('{"tokens":{}}');
    expect(r.provider.specs.at(-1)!.cmd).toEqual([
      'sh',
      '-c',
      'cat "$1"',
      'sh',
      `${home}/auth.json`,
    ]);
    await opened.dispose();
    expect(r.provider.specs.at(-1)!.cmd).toEqual(['rm', '-rf', home]);
  });

  it('dispose never throws, even when the helper vanished mid-session', async () => {
    const r = rig();
    const opened = await new ContainerAuthHelper(r.session).openSession(['codex', 'login']);
    r.provider.killFails = true;
    r.provider.execDown = true;
    await expect(opened.dispose()).resolves.toBeUndefined();
  });
});

describe('credential refresh does not blame a credential for a helper outage', () => {
  function scannerRig(openSession: AuthHelper['openSession']) {
    const recordRefreshFailure = vi.fn(async () => undefined);
    const zeroize = vi.fn();
    const due: RuntimeRefreshDue[] = ['cred-1', 'cred-2'].map((credentialId) => ({
      credentialId,
      runtimeId: 'codex',
      obtainedVia: 'oauth-device',
    }));
    const overrides: Record<string, unknown> = {
      listRefreshDue: async () => due,
      prepareForRefresh: async () => ({
        runtimeId: 'codex',
        obtainedVia: 'oauth-device',
        issuedAt: '2026-10-08T00:00:00Z',
        credentialFiles: [],
        authFile: '{"tokens":{}}',
        zeroize,
      }),
      recordRefreshFailure,
    };
    const credentials = new Proxy(unused<RuntimeCredentialService>('runtime credentials'), {
      get: (target, key) =>
        typeof key === 'string' && key in overrides ? overrides[key] : Reflect.get(target, key),
    });
    const helper = { openSession: vi.fn(openSession) };
    const scanner = new CredentialRefreshScanner(
      helper,
      credentials,
      new DefaultRuntimeAdapterRegistry(new CodexAdapter(), new ClaudeCodeAdapter()),
      { now: () => new Date('2026-10-08T00:00:00Z') },
    );
    return { scanner, helper, recordRefreshFailure, zeroize };
  }

  it('an unavailable helper is logged, not counted, and the rest of the pass waits for the next one', async () => {
    const s = scannerRig(async () => {
      throw new HelperUnavailableError('auth helper 容器不可用：boxlite micro-VM did not start');
    });
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    await s.scanner.runOnce();
    expect(s.recordRefreshFailure).not.toHaveBeenCalled();
    expect(s.helper.openSession).toHaveBeenCalledOnce();
    expect(s.zeroize).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('不计入刷新失败次数'));
  });

  it('any other refresh failure still counts against that credential', async () => {
    const s = scannerRig(async () => {
      throw new Error('codex exited with status 1');
    });
    await s.scanner.runOnce();
    expect(s.recordRefreshFailure.mock.calls).toEqual([['cred-1'], ['cred-2']]);
    expect(s.helper.openSession).toHaveBeenCalledTimes(2);
  });

  it('a helper removed under the refresh command is not counted, and its handle is dropped', async () => {
    const r = rig();
    const first = await r.session.require();
    const container = new ContainerAuthHelper(r.session);
    const s = scannerRig((cmd, seed, names) => container.openSession(cmd, seed, names));
    // Another session's rebuild (or a dead VM) takes the helper away between seeding the
    // credential and starting the refresh command.
    r.provider.vanishBeforePty = true;
    const invalidations = vi.spyOn(r.session, 'invalidate');
    await s.scanner.runOnce();
    expect(s.recordRefreshFailure).not.toHaveBeenCalled();
    expect(invalidations).toHaveBeenCalledWith(first.handle, expect.stringContaining('NOT_FOUND'));
    expect(r.session.status().ready).toBe(false);
    expect(s.zeroize).toHaveBeenCalledOnce();
  });
});
