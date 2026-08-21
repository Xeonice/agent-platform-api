import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import type { ProcessStream, SandboxHandle } from '@platform/contracts';
import {
  createDockerClient,
  isDockerAvailable,
} from '../../../../packages/modules/sandbox/src/infrastructure/providers/docker/docker-client';
import { AioSandboxProvider } from '../../../../packages/modules/sandbox/src/infrastructure/providers/aio/aio-sandbox.provider';

/**
 * DOCKER-REQUIRED e2e for 加固 1: the in-sandbox agent port is no longer an
 * unauthenticated shell (SANDBOX-RUNTIME-DECISIONS 安全姿态).
 *
 * The hole this closes is not theoretical and not remote: the agent is published
 * on the HOST loopback, so before this, ANY process on the machine — an npm
 * postinstall, any tool running as any local user — could scan 127.0.0.1 and
 * `POST /v1/bash/exec {"command":"cat ~/.codex/auth.json"}`, walking straight past
 * every platform Guard. So this file attacks the port the way such a process
 * would, using RAW fetch/WebSocket against the published port rather than the
 * provider, and asserts it is refused — then asserts the PLATFORM path (which
 * carries the per-sandbox token) still works for both exec and pty.
 *
 * Skips LOUDLY when docker is down or the AIO image is absent (it is ~3.3GB and is
 * never auto-pulled) — a silent pass here would be worse than no test.
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
      '[aio-agent-auth.e2e] SKIPPED — docker down or AIO image not present.\n' +
      `  docker daemon reachable: ${dockerUp}\n` +
      `  image ${IMAGE} present:   ${imagePresent}\n` +
      'This is the ONLY proof that the loopback-published agent port refuses\n' +
      'unauthenticated callers. Run it with docker up.\n' +
      '========================================================================\x1b[0m\n',
  );
}

const provider = new AioSandboxProvider(docker);
let handle: SandboxHandle | undefined;
/** the loopback origin an attacker on this host would find by scanning ports. */
let agentOrigin = '';

beforeAll(async () => {
  if (!runnable) return;
  handle = await provider.create({
    sandboxId: `e2e-auth-${process.pid}`,
    quota: { cores: 2, ramMb: 2048, diskMb: 4096 },
    image: { ref: IMAGE, digest: 'sha256:e2e' },
    env: {},
    labels: { 'platform.test': 'true' },
  });
  await provider.start(handle);
  const info = await docker.getContainer(handle.providerSandboxId).inspect();
  const mapping = info.NetworkSettings?.Ports?.['8080/tcp']?.[0];
  agentOrigin = `http://127.0.0.1:${mapping?.HostPort}`;
}, 300_000);

afterAll(async () => {
  if (handle) await provider.destroy(handle).catch(() => undefined);
});

function collect(stream: ProcessStream): Promise<{ out: string; code: number | null }> {
  return new Promise((resolveP) => {
    let out = '';
    stream.onData((c) => {
      out += c.toString('utf8');
    });
    stream.onExit((code) => resolveP({ out, code }));
  });
}

describe.skipIf(!runnable)('aio in-sandbox agent — loopback port is authenticated', () => {
  it('publishes the agent on loopback only', () => {
    expect(handle?.agentAuthToken).toBeTypeOf('string');
    expect(agentOrigin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it('refuses an anonymous exec — the exact call that used to be a free shell', async () => {
    const res = await fetch(`${agentOrigin}/v1/bash/exec`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: 'attacker', command: 'id' }),
    });
    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain('uid=');
  });

  it('refuses a forged / wrong-key bearer token', async () => {
    const res = await fetch(`${agentOrigin}/v1/bash/exec`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer not-a-real-jwt' },
      body: JSON.stringify({ session_id: 'attacker', command: 'id' }),
    });
    expect(res.status).toBe(401);
  });

  it('refuses anonymous file reads (source/credential exfiltration path)', async () => {
    const res = await fetch(`${agentOrigin}/v1/file/read`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ file: '/etc/hostname' }),
    });
    expect(res.status).toBe(401);
  });

  it('refuses an anonymous websocket upgrade (the interactive shell)', async () => {
    const wsUrl = `${agentOrigin.replace('http', 'ws')}/v1/shell/ws`;
    const outcome = await new Promise<string>((resolveP) => {
      const ws = new WebSocket(wsUrl);
      const timer = setTimeout(() => resolveP('timeout'), 15_000);
      ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolveP('OPENED');
        ws.close();
      });
      ws.addEventListener('error', () => {
        clearTimeout(timer);
        resolveP('refused');
      });
    });
    expect(outcome).not.toBe('OPENED');
  });

  it('still lets the PLATFORM exec through with the sandbox token', async () => {
    const stream = await provider.spawn(handle!, {
      tty: false,
      cmd: ['sh', '-c', 'echo AUTHED_EXEC_OK'],
    });
    const { out, code } = await collect(stream);
    expect(out).toContain('AUTHED_EXEC_OK');
    expect(code).toBe(0);
  });

  it('still opens the PLATFORM pty (token → ticket → ws upgrade)', async () => {
    // the pty cannot carry a header, so this is the only proof that the ticket
    // exchange works against the REAL agent and not just a fake.
    const pty = await provider.spawn(handle!, { tty: true, cols: 80, rows: 24 });
    const seen = await new Promise<string>((resolveP) => {
      let buf = '';
      const timer = setTimeout(() => resolveP(buf), 20_000);
      pty.onData((c) => {
        buf += c.toString('utf8');
        if (/AUTHED_PTY_OK/.test(buf)) {
          clearTimeout(timer);
          resolveP(buf);
        }
      });
      setTimeout(() => pty.write('echo AUTHED_PTY_OK\n'), 1_000);
    });
    await pty.kill('SIGTERM').catch(() => undefined);
    expect(seen).toMatch(/AUTHED_PTY_OK/);
  }, 40_000);

  it('fails a handle that lost the token — the credential is load-bearing', async () => {
    const stripped: SandboxHandle = {
      provider: 'aio',
      providerSandboxId: handle!.providerSandboxId,
    };
    const stream = await provider.spawn(stripped, {
      tty: false,
      cmd: ['sh', '-c', 'echo SHOULD_NOT_RUN'],
    });
    const { out } = await collect(stream).catch(() => ({ out: '' }));
    expect(out).not.toContain('SHOULD_NOT_RUN');
  });
});
