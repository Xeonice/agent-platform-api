import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import type { ProcessStream, SandboxHandle } from '@platform/contracts';
import {
  createDockerClient,
  isDockerAvailable,
} from '../../../../packages/modules/sandbox/src/infrastructure/providers/docker/docker-client';
import { AioSandboxProvider } from '../../../../packages/modules/sandbox/src/infrastructure/providers/aio/aio-sandbox.provider';

/**
 * DOCKER-REQUIRED e2e for the data-plane exec CAPABILITIES (S5 前置). Everything
 * runs through the REAL platform path — `AioSandboxProvider.spawn` → the
 * in-sandbox AIO agent — not `docker run`, because the bug being pinned here was
 * exactly that the agent client dropped ProcessSpec fields on the floor:
 *
 *   stdin / env / cwd / timeoutMs were accepted by the type system and never sent,
 *   so `codex login --with-access-token` type-checked while the token went nowhere.
 *
 * The same client backs `boxlite`'s tty:false path (决策 A shared data plane), so
 * proving it here covers both providers' exec.
 *
 * Skips LOUDLY when the docker daemon is down or the AIO image is absent locally
 * (the image is ~3.3GB — never auto-pulled).
 */
const IMAGE = process.env.SANDBOX_TEST_IMAGE ?? 'ghcr.io/agent-infra/sandbox:latest';
const docker = createDockerClient();
const dockerUp = await isDockerAvailable(docker).catch(() => false);
const imagePresent = dockerUp
  ? await docker
      .getImage(IMAGE)
      .inspect()
      .then(() => true)
      .catch(() => false)
  : false;
const runnable = dockerUp && imagePresent;

if (!runnable) {
  console.warn(
    '\n\x1b[33m========================================================================\n' +
      '[aio-exec-capabilities.e2e] SKIPPED — docker down or AIO image not present.\n' +
      `  docker daemon reachable: ${dockerUp}\n` +
      `  image ${IMAGE} present:   ${imagePresent}\n` +
      'This is the ONLY proof that exec really carries stdin/env/cwd/timeout and\n' +
      'that kill() reaches the remote process. Run it with docker up.\n' +
      '========================================================================\x1b[0m\n',
  );
}

/** A secret-shaped stdin payload with shell metacharacters in it. */
const SECRET = 'sk-e2e-T0P$ECRET-`whoami`-"quoted"-value';

const provider = new AioSandboxProvider(docker);
let handle: SandboxHandle | undefined;

beforeAll(async () => {
  if (!runnable) return;
  handle = await provider.create({
    sandboxId: `e2e-exec-${process.pid}`,
    quota: { cores: 2, ramMb: 2048, diskMb: 4096 },
    image: { ref: IMAGE, digest: 'sha256:e2e' },
    env: {},
    labels: { 'platform.test': 'true' },
  });
  await provider.start(handle);
}, 180_000);

afterAll(async () => {
  if (handle) await provider.destroy(handle).catch(() => undefined);
});

function collect(stream: ProcessStream): Promise<{ out: string; code: number | null }> {
  return new Promise((resolve) => {
    let out = '';
    stream.onData((c) => {
      out += c.toString('utf8');
    });
    stream.onExit((code) => resolve({ out, code }));
  });
}

/** Run a one-shot command through the platform path and collect it to EOF. */
async function run(
  cmd: string[],
  extra: { env?: Record<string, string>; cwd?: string; stdin?: string; timeoutMs?: number } = {},
): Promise<{ out: string; code: number | null }> {
  return collect(await provider.spawn(handle!, { cmd, tty: false, ...extra }));
}

describe.skipIf(!runnable)(
  'AIO data-plane exec — ProcessSpec 字段真的送达 (real container)',
  () => {
    it('stdin reaches the process on fd 0, with a real EOF', async () => {
      const { out, code } = await run(['cat'], { stdin: SECRET });
      expect(out).toBe(SECRET);
      expect(code).toBe(0);
    }, 60_000);

    it('env is applied verbatim — metacharacters are not re-interpreted', async () => {
      const value = 'v1 $HOME `id` "dq" \'sq\'';
      const { out, code } = await run(['sh', '-c', 'printf %s "$PROBE"'], {
        env: { PROBE: value },
      });
      expect(out).toBe(value);
      expect(code).toBe(0);
    }, 60_000);

    it('cwd is applied (not the agent default /home/gem)', async () => {
      const { out } = await run(['pwd'], { cwd: '/tmp' });
      expect(out.trim()).toBe('/tmp');
      const { out: dflt } = await run(['pwd']);
      expect(dflt.trim()).not.toBe('/tmp');
    }, 60_000);

    it('stderr is collected alongside stdout and the exit code is real', async () => {
      const { out, code } = await run(['sh', '-c', 'echo O; echo E 1>&2; exit 7']);
      expect(out).toContain('O');
      expect(out).toContain('E');
      expect(code).toBe(7);
    }, 60_000);

    it('timeoutMs kills the REMOTE process and reports 124', async () => {
      const { code } = await run(['sh', '-c', 'sleep 30; echo never'], { timeoutMs: 2_000 });
      expect(code).toBe(124);
      const { out } = await run(['sh', '-c', 'pgrep -f "sl[e]ep 30" >/dev/null; echo rc=$?']);
      expect(out).toContain('rc=1'); // pgrep found nothing
    }, 90_000);
  },
);

describe.skipIf(!runnable)('AIO data-plane exec — stdin 不进 argv (RA-14, real ps)', () => {
  it('a secret on stdin never appears in the sandbox process table', async () => {
    // hold the command open while a SECOND exec snapshots the real process table
    const holder = await provider.spawn(handle!, {
      cmd: ['sh', '-c', 'sleep 6; cat'],
      tty: false,
      stdin: SECRET,
    });
    const holderDone = collect(holder);
    await new Promise((r) => setTimeout(r, 1_500));

    const ps = await run(['sh', '-c', 'ps -eww -o args=']);
    expect(ps.out).not.toContain('T0P$ECRET');
    const cmdlines = await run([
      'sh',
      '-c',
      "for f in /proc/[0-9]*/cmdline; do tr '\\0' ' ' < \"$f\" 2>/dev/null; echo; done",
    ]);
    expect(cmdlines.out).not.toContain('T0P$ECRET');
    // sanity: the probe itself can see argv at all (otherwise the assertion is vacuous)
    expect(ps.out).toContain('sleep 6');

    const { out } = await holderDone;
    expect(out).toBe(SECRET);
  }, 90_000);

  it('shreds the stdin scratch dir when the exec finishes', async () => {
    await run(['cat'], { stdin: SECRET });
    const { out } = await run(['sh', '-c', 'ls -d /tmp/.platform-stdin-* 2>&1; echo rc=$?']);
    expect(out).toContain('rc=2'); // ls: no such file
    expect(out).not.toContain('T0P$ECRET');
  }, 60_000);
});

describe.skipIf(!runnable)('AIO data-plane kill — 真杀,不是本地假装 (real container)', () => {
  it('exec kill() delivers SIGTERM to the remote process and it is gone', async () => {
    const stream = await provider.spawn(handle!, {
      cmd: ['sh', '-c', 'sleep 120'],
      tty: false,
    });
    const done = collect(stream);
    await new Promise((r) => setTimeout(r, 1_500));
    const before = await run(['sh', '-c', 'pgrep -f "sl[e]ep 120" >/dev/null; echo rc=$?']);
    expect(before.out).toContain('rc=0');

    await stream.kill();
    const { code } = await done;
    // -15 = killed by SIGTERM (the agent reports the negative signal number)
    expect(code).toBe(-15);

    const after = await run(['sh', '-c', 'pgrep -f "sl[e]ep 120" >/dev/null; echo rc=$?']);
    expect(after.out).toContain('rc=1'); // REMOTE process really gone
  }, 90_000);

  it('pty kill() interrupts the foreground job and does not leak the shell', async () => {
    const countShells = async (): Promise<number> => {
      const { out } = await run(['sh', '-c', 'pgrep -c -f "bash [-]i" || echo 0']);
      return Number(out.trim().split('\n').pop());
    };
    const baseline = await countShells();

    // S5: the tty side now HONOURS `spec.cmd` (it used to be silently dropped, 04
    // §2.3★), so the session shell is the one we ask for — ask for `bash -i` so this
    // case still counts the same process it always counted.
    const pty = await provider.spawn(handle!, {
      cmd: ['bash', '-i'],
      tty: true,
      cols: 80,
      rows: 24,
    });
    await new Promise((r) => setTimeout(r, 2_000));
    pty.write('sleep 121\n');
    await new Promise((r) => setTimeout(r, 2_000));
    const running = await run(['sh', '-c', 'pgrep -f "sl[e]ep 121" >/dev/null; echo rc=$?']);
    expect(running.out).toContain('rc=0');
    expect(await countShells()).toBe(baseline + 1);

    await pty.kill();
    await new Promise((r) => setTimeout(r, 2_000));
    const gone = await run(['sh', '-c', 'pgrep -f "sl[e]ep 121" >/dev/null; echo rc=$?']);
    expect(gone.out).toContain('rc=1'); // SIGINT was really delivered through the tty
    expect(await countShells()).toBe(baseline); // and the interactive shell exited
  }, 90_000);
});

describe.skipIf(!runnable)('AIO data-plane exec — 不支持的能力显式报错', () => {
  it('ProcessSpec.user is rejected, not silently dropped', async () => {
    await expect(
      provider.spawn(handle!, { cmd: ['id'], tty: false, user: 'root' }),
    ).rejects.toThrow(/UNSUPPORTED|user-switching/i);
  }, 60_000);
});
