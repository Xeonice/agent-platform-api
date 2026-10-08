import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AUTH_HELPER_SANDBOX_ID,
  SandboxProviderError,
  SandboxProviderErrorCode,
} from '@platform/contracts';
import type { ResolvedImageSpec, SandboxProviderContext } from '@platform/contracts';
import { BoxliteSandboxProvider } from '../../../packages/modules/sandbox/src/infrastructure/providers/boxlite/boxlite-sandbox.provider';
import { boxliteNamePrefix } from '../../../packages/modules/sandbox/src/infrastructure/reconcile/instance-id';
import { isInstanceFailure } from '../../../packages/modules/runtime/src/infrastructure/helper/container-auth-helper';

// Only the native SDK boundary is replaced; the provider reads the image config from a
// BoxLite-shaped store on disk exactly as it does in production.
const native = vi.hoisted(() => ({
  home: '',
  creates: [] as { options: Record<string, unknown>; name: string | undefined }[],
  removes: [] as { idOrName: string; force: boolean | undefined }[],
  removeError: null as Error | null,
  /** The one box `get(idOrName)` hands back (null = no such box). */
  box: null as null | {
    name: string;
    status: string;
    running: boolean;
    stop: 'ok' | 'reject' | 'hang';
    execError: Error | null;
  },
  calls: [] as string[],
}));
vi.mock(
  '../../../packages/modules/sandbox/src/infrastructure/providers/boxlite/boxlite-runtime',
  () => ({
    boxliteHome: () => native.home,
    getSharedBoxliteRuntime: async () => ({
      create: async (options: Record<string, unknown>, name?: string) => {
        native.creates.push({ options, name });
        return { id: `box-${native.creates.length}` };
      },
      remove: async (idOrName: string, force?: boolean) => {
        native.calls.push('remove');
        native.removes.push({ idOrName, force });
        if (native.removeError) throw native.removeError;
      },
      get: async () => {
        const box = native.box;
        if (box === null) return null;
        return {
          info: () => ({ name: box.name, state: { status: box.status, running: box.running } }),
          stop: () => {
            native.calls.push('stop');
            if (box.stop === 'hang') return new Promise<void>(() => {});
            if (box.stop === 'reject') return Promise.reject(new Error('guest did not answer'));
            box.status = 'stopped';
            box.running = false;
            return Promise.resolve();
          },
          exec: async () => {
            native.calls.push('exec');
            if (box.execError) throw box.execError;
            throw new Error('this fixture only models failing execs');
          },
        };
      },
    }),
  }),
);

const home = mkdtempSync(join(tmpdir(), 'boxlite-ports-'));
native.home = home;
afterAll(() => rmSync(home, { recursive: true, force: true }));
beforeEach(() => {
  native.creates = [];
  native.removes = [];
  native.removeError = null;
  native.box = null;
  native.calls = [];
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const HELPER = `${boxliteNamePrefix()}${AUTH_HELPER_SANDBOX_ID}`;

let serial = 0;
/** Writes index -> (amd64, arm64) manifest -> config into the temp store; returns the image spec. */
function stagedImage(exposed: Record<string, object> | undefined): ResolvedImageSpec {
  serial += 1;
  const hex = (n: number) => `${String(serial).padStart(4, '0')}${String(n).repeat(60)}`;
  const index = `sha256:${hex(1)}`;
  const child = `sha256:${hex(2)}`;
  const config = `sha256:${hex(3)}`;
  const file = (dir: string, digest: string, body: unknown) => {
    mkdirSync(join(home, 'images', dir), { recursive: true });
    writeFileSync(
      join(home, 'images', dir, `${digest.replace(':', '-')}.json`),
      JSON.stringify(body),
    );
  };
  file('manifests', index, {
    manifests: ['amd64', 'arm64'].map((architecture) => ({
      digest: child,
      platform: { architecture, os: 'linux' },
    })),
  });
  file('manifests', child, { config: { digest: config }, layers: [] });
  file('configs', config, {
    config: { Cmd: ['sleep', 'infinity'], ...(exposed ? { ExposedPorts: exposed } : {}) },
  });
  return { ref: 'ghcr.io/xeonice/agent-platform-boxlite:latest', digest: index };
}

function context(image: ResolvedImageSpec, sandboxId = 'task-1'): SandboxProviderContext {
  return {
    sandboxId,
    quota: { cores: 1, ramMb: 512, diskMb: 2048 },
    image,
    env: { USER_VAR: 'kept' },
  };
}

async function createdWith(image: ResolvedImageSpec, sandboxId?: string) {
  await new BoxliteSandboxProvider().create(context(image, sandboxId));
  expect(native.creates).toHaveLength(1);
  return native.creates[0]!;
}

describe('BoxLite publishes host ports only for ports the image itself declares', () => {
  it('an image without EXPOSE gets no port mapping at all and keeps the gateway lock env', async () => {
    const { options } = await createdWith(stagedImage(undefined));
    expect(options).not.toHaveProperty('ports');
    const env = options.env as { key: string; value: string }[];
    expect(env.find((e) => e.key === 'USER_VAR')?.value).toBe('kept');
    expect(env.find((e) => e.key === 'JWT_PUBLIC_KEY')?.value).toMatch(/^[A-Za-z0-9+/=]{100,}$/);
  });

  it('a declared 8080 moves to one free host port', async () => {
    const { options } = await createdWith(stagedImage({ '8080/tcp': {} }));
    const ports = options.ports as { hostPort: number; guestPort: number }[];
    expect(ports).toHaveLength(1);
    expect(ports[0]).toMatchObject({ guestPort: 8080 });
    expect(Number.isInteger(ports[0]!.hostPort) && ports[0]!.hostPort > 0).toBe(true);
    // An ephemeral port is never the declared one: publishing 8080 on 8080 is exactly the
    // fixed-port collision that kept a second box from starting.
    expect(ports[0]!.hostPort).not.toBe(8080);
    expect(ports[0]).not.toHaveProperty('hostIp');
  });

  it('every declared tcp port gets its own distinct host port; udp is not mapped', async () => {
    const { options } = await createdWith(
      stagedImage({ '8080/tcp': {}, '3000/tcp': {}, '53/udp': {} }),
    );
    const ports = options.ports as { hostPort: number; guestPort: number }[];
    expect(ports.map((p) => p.guestPort).sort()).toEqual([3000, 8080]);
    expect(new Set(ports.map((p) => p.hostPort)).size).toBe(2);
    for (const p of ports) expect(p.hostPort).not.toBe(p.guestPort);
  });

  it('a udp-only image publishes nothing', async () => {
    const { options } = await createdWith(stagedImage({ '53/udp': {} }));
    expect(options).not.toHaveProperty('ports');
  });

  it.each([
    [
      'not yet in the BoxLite store',
      { ref: 'example.test/cold:1', digest: `sha256:${'f'.repeat(64)}` },
    ],
    ['not pinned to an OCI digest', { ref: 'example.test/legacy:1', digest: 'unresolved' }],
  ])('an image %s publishes nothing and says why', async (_label, image) => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { options } = await createdWith(image);
    expect(options).not.toHaveProperty('ports');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(image.ref));
  });

  it('names the auth helper box with this instance prefix', async () => {
    const { name } = await createdWith(stagedImage(undefined), 'auth-helper');
    expect(name).toBe(`${boxliteNamePrefix()}auth-helper`);
  });

  it('names the production helper exactly as the release probe expects to find it', async () => {
    // deploy/containers/api-container.mjs (STOPPED_RESERVATIONS_PROBE) derives the name on its
    // own from the fixed database path; an API-side change to the derivation would leave
    // every release waiting for an idle that never comes.
    vi.stubEnv('DATABASE_URL', '/data/platform.db');
    try {
      const { name } = await createdWith(stagedImage(undefined), AUTH_HELPER_SANDBOX_ID);
      expect(name).toBe(
        'platform-boxlite-' +
          createHash('sha256').update('/data/platform.db').digest('hex').slice(0, 16) +
          '-auth-helper',
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('BoxLite removes a leftover instance by sandbox id, idempotently', () => {
  it('force-removes the canonical name derived by the provider itself', async () => {
    await new BoxliteSandboxProvider().destroyBySandboxId('auth-helper');
    expect(native.removes).toEqual([{ idOrName: HELPER, force: true }]);
  });

  it('treats an absent box as already removed', async () => {
    native.removeError = new Error('box not found: platform-boxlite-x-auth-helper');
    await expect(
      new BoxliteSandboxProvider().destroyBySandboxId('auth-helper'),
    ).resolves.toBeUndefined();
  });

  it('surfaces any other failure as a provider error', async () => {
    native.removeError = new Error('database is locked');
    const failure = new BoxliteSandboxProvider().destroyBySandboxId('auth-helper');
    await expect(failure).rejects.toBeInstanceOf(SandboxProviderError);
    await expect(failure).rejects.toMatchObject({ code: SandboxProviderErrorCode.INTERNAL });
  });

  it('stops a leftover that is still running before force-removing it, and says so', async () => {
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    native.box = { name: HELPER, status: 'running', running: true, stop: 'ok', execError: null };
    await new BoxliteSandboxProvider().destroyBySandboxId(AUTH_HELPER_SANDBOX_ID);
    expect(native.calls).toEqual(['stop', 'remove']);
    expect(log).toHaveBeenCalledWith(expect.stringContaining(`removed box ${HELPER}`));
  });

  it('does not stop a leftover that is already stopped (the boot case)', async () => {
    native.box = { name: HELPER, status: 'stopped', running: false, stop: 'ok', execError: null };
    await new BoxliteSandboxProvider().destroyBySandboxId(AUTH_HELPER_SANDBOX_ID);
    expect(native.calls).toEqual(['remove']);
  });

  it('removes the leftover anyway when it refuses to stop', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    native.box = {
      name: HELPER,
      status: 'running',
      running: true,
      stop: 'reject',
      execError: null,
    };
    await new BoxliteSandboxProvider().destroyBySandboxId(AUTH_HELPER_SANDBOX_ID);
    expect(native.calls).toEqual(['stop', 'remove']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('guest did not answer'));
  });

  it('removes the leftover once the stop budget is spent', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    native.box = { name: HELPER, status: 'running', running: true, stop: 'hang', execError: null };
    const pending = new BoxliteSandboxProvider().destroyBySandboxId(AUTH_HELPER_SANDBOX_ID);
    await vi.advanceTimersByTimeAsync(19_999);
    expect(native.calls).toEqual(['stop']);
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(native.calls).toEqual(['stop', 'remove']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('did not stop within 20s'));
  });
});

describe('BoxLite never revives a stopped platform helper through its data plane', () => {
  const exec = (providerSandboxId = 'helper-box') =>
    new BoxliteSandboxProvider().spawn(
      { provider: 'boxlite', providerSandboxId },
      { cmd: ['sh', '-c', 'exit 0'], tty: false },
    );

  it.each(['stopped', 'failed', 'configured'])(
    'an exec into a %s helper is refused instead of restarting it from its old rootfs',
    async (status) => {
      native.box = { name: HELPER, status, running: false, stop: 'ok', execError: null };
      const failure = exec();
      await expect(failure).rejects.toMatchObject({ code: SandboxProviderErrorCode.INVALID_STATE });
      await expect(failure).rejects.toSatisfy(isInstanceFailure);
      expect(native.calls).toEqual([]);
    },
  );

  it('a stopped task box is still reached, as artifact reads of stopped tasks rely on today', async () => {
    native.box = {
      name: `${boxliteNamePrefix()}task-1`,
      status: 'stopped',
      running: false,
      stop: 'ok',
      execError: new Error('fixture reached exec'),
    };
    await expect(exec('task-box')).rejects.toThrow('fixture reached exec');
    expect(native.calls).toEqual(['exec']);
  });
});

describe('BoxLite reports a killed helper VM so that the helper can recover', () => {
  // Two paths reach a dead VM behind a running record. A fresh BoxImpl re-attaches and fails in
  // vmm_attach with the InvalidState text; a BoxImpl whose live state is still cached talks
  // gRPC to a socket nobody listens on any more.
  it.each([
    'invalid state: Box process is no longer running (PID file missing, process dead, ' +
      'or start-time mismatch indicating PID reuse)',
    'gRPC transport error: transport error',
    'gRPC/tonic error: status: Unavailable, message: "error trying to connect: Connection refused (os error 111)"',
    'gRPC/tonic error: status: Unknown, message: "h2 protocol error: error reading a body from connection: Broken pipe (os error 32)"',
  ])('%s is an instance failure the helper rebuilds on', async (message) => {
    native.box = {
      name: HELPER,
      status: 'running',
      running: true,
      stop: 'ok',
      execError: new Error(message),
    };
    const failure = new BoxliteSandboxProvider().spawn(
      { provider: 'boxlite', providerSandboxId: 'helper-box' },
      { cmd: ['sh', '-c', 'exit 0'], tty: false },
    );
    await expect(failure).rejects.toBeInstanceOf(SandboxProviderError);
    // Pinned to the helper's own predicate, not to a copied list of codes: the mapping and
    // the recovery must change together.
    await expect(failure).rejects.toSatisfy(isInstanceFailure);
  });
});
