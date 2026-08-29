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
 * ⚠️ 2026-08：凭证从**平台自造的 RS256 JWT**（`JWT_PUBLIC_KEY` + 现场造密钥对 + 手工
 * 签名）换成了**镜像原生的 `SANDBOX_API_KEY`**。镜像入口 `/opt/gem/gem.sh` 两个 env
 * 都认、走同一扇 nginx `auth_request` 门，所以**鉴权强度不变**；换掉的是我们自己
 * 维护的那套密码学代码。断言的语义因此变了两处：
 *   · 「伪造的 JWT 被拒」→「猜错的 api key 被拒」（同一个洞，新的钥匙形状）
 *   · 头从 `Authorization: Bearer` 换成镜像原生的 `X-AIO-API-Key`
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
  it('publishes the agent on loopback only, with a per-sandbox key on the handle', () => {
    // ⚠️ 这里以前写的是 `handle?.agentAuthToken` —— 一个**契约上早就不存在**的字段
    // （凭证 2026-08 收进了不透明的 `providerState`）。它从没红过，因为 tsc 不编译
    // 测试、而这个文件在没有 docker 的机器上整体跳过：一条断言存在，且永远不生效。
    expect(handle?.providerState?.agentAuthToken).toBeTypeOf('string');
    expect(agentOrigin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it('leaves the image own auth-free ping open — readiness needs it', async () => {
    // `GET /v1/ping` 是镜像 nginx map 里**唯一**走 `@proxy_without_auth` 的路由。
    // 它开着是对的（就绪探测要用），但也正因为它开着，反向那条「匿名必须被拒」的
    // 断言绝不能拿它来问 —— 拿它问会在一张完全正确的镜像上判失败。
    expect((await fetch(`${agentOrigin}/v1/ping`)).status).toBe(200);
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

  it('refuses a guessed / wrong api key', async () => {
    const res = await fetch(`${agentOrigin}/v1/bash/exec`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-aio-api-key': 'not-the-key' },
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

  it('still lets the PLATFORM exec through with the sandbox key', async () => {
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
    // ⚠️ 实测 `?api_key=` 也能开 101，但我们不用它：query 会进沙箱自己的 nginx
    // access log，而这把钥匙的寿命是整个沙箱（ticket 30 秒过期）。
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

  it('fails a handle that lost the key — the credential is load-bearing', async () => {
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
