import { afterEach, describe, expect, it, vi } from 'vitest';
import { SandboxProviderErrorCode } from '@platform/contracts';
import { AioSandboxAgentClient } from '../../src/infrastructure/providers/aio/aio-sandbox-agent.client';
import { AioSandboxProvider } from '../../src/infrastructure/providers/aio/aio-sandbox.provider';
import type {
  ContainerCreateSpec,
  ContainerRuntime,
} from '../../src/infrastructure/providers/container-runtime.port';
import { createDockerClient } from '../../src/infrastructure/providers/docker/docker-client';
import type { SandboxRuntimeStatus } from '@platform/contracts';

/**
 * tty 这条通道必须**兑现** `ProcessSpec` 的 `env` / `cwd`。
 *
 * ── 这组用例在挡什么 ─────────────────────────────────────────────────────────
 * agent 的 `ws /v1/shell/ws` 上行帧只有 `input` / `resize`，**没有一处能放环境变量或
 * 工作目录**。在 2026-09-23 之前 provider 就照着这个「传输层没有」把两个字段原样丢了 ——
 * 契约声明了、调用方传了、进程也起来了，只是环境不是它要的。
 *
 * 真机上的代价：`ContainerAuthHelper` 靠 `env.HOME` / `env.<CLI>_HOME` 给每次登录开一个
 * 隔离目录，丢掉之后 codex 把 `auth.json` 写进容器默认 HOME，平台在隔离目录里读不到，
 * 于是对用户报「对方拒绝了这次登录」—— ⛔ 一个指错方向的报错，查了一整轮。
 *
 * ⚠️ 判据是**真的写进 socket 的那一行**，不是「provider 方法体里有没有出现 spec.env」——
 * 后者正是上面那个 bug 能长期存在的方式。
 */

/** 最小 WebSocket 替身：记录发出去的帧，并允许测试把 server 帧灌回去。 */
class FakeWs {
  static last: FakeWs | undefined;
  readonly sent: string[] = [];
  private readonly ls: Record<string, ((ev?: unknown) => void)[]> = {};

  constructor(readonly url: string) {
    FakeWs.last = this;
    setTimeout(() => this.emit('open'), 0);
  }

  addEventListener(t: string, cb: (ev?: unknown) => void): void {
    (this.ls[t] ??= []).push(cb);
  }

  removeEventListener(t: string, cb: (ev?: unknown) => void): void {
    this.ls[t] = (this.ls[t] ?? []).filter((x) => x !== cb);
  }

  send(d: string): void {
    this.sent.push(d);
  }

  close(): void {
    this.emit('close');
  }

  emit(t: string, ev?: unknown): void {
    for (const cb of [...(this.ls[t] ?? [])]) cb(ev);
  }

  /** 灌一帧 server → client。 */
  frame(obj: unknown): void {
    this.emit('message', { data: JSON.stringify(obj) });
  }

  /** 敲进 shell 的那一行（`input` 帧），没有就是 undefined。 */
  typedLine(): string | undefined {
    for (const raw of this.sent) {
      const f = JSON.parse(raw) as { type?: string; data?: unknown };
      if (f.type === 'input' && typeof f.data === 'string') return f.data;
    }
    return undefined;
  }
}

/** 开一个 tty 并把它推进到「已经敲完那一行」，返回 socket 替身。 */
async function openAndSettle(
  cmd: string[],
  launch?: { env?: Record<string, string>; cwd?: string },
): Promise<FakeWs> {
  vi.stubGlobal('WebSocket', FakeWs);
  // ⚠️ 不给 key ⇒ `authenticated` 为假 ⇒ 不去换 ticket，一个 HTTP 请求都不发。
  const client = new AioSandboxAgentClient('http://127.0.0.1:1');
  const opening = client.openTerminal(120, 30, cmd, launch);
  const ws = FakeWs.last;
  if (ws === undefined) throw new Error('WebSocket 没被构造出来');
  // ⚠️ `ready` 必须在 await 之前排上队：`openTerminal` 要等 shell 就绪才回来，
  //    等它 resolve 再喂帧就是自己和自己死锁（只有 8s 的 grace 能兜底）。
  setTimeout(() => ws.frame({ type: 'ready' }), 10);
  await opening;
  return ws;
}

async function waitForSocket(): Promise<FakeWs> {
  for (let i = 0; i < 100; i += 1) {
    const ws = FakeWs.last;
    if (ws !== undefined) return ws;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('WebSocket 没被构造出来');
}

afterEach(() => {
  vi.unstubAllGlobals();
  FakeWs.last = undefined;
});

describe('aio tty —— ProcessSpec 的 env / cwd 不许被静默丢掉', () => {
  it('把 cwd 与 env 编进敲给 shell 的那一行', async () => {
    const home = '/home/gem/auth-helper.ab12cd34';
    const ws = await openAndSettle(['codex', 'login', '--device-auth'], {
      cwd: home,
      env: { TERM: 'xterm-256color', HOME: home, CODEX_HOME: home },
    });

    expect(ws.typedLine()).toBe(
      `cd '${home}' || exit 1; ` +
        `export TERM='xterm-256color'; export HOME='${home}'; export CODEX_HOME='${home}'; ` +
        `exec 'codex' 'login' '--device-auth'\n`,
    );
  });

  it('cd 失败时结束会话，⛔ 不把用户留在一个目录不对的默认 shell 里', async () => {
    const ws = await openAndSettle(['codex'], { cwd: '/nope' });
    const line = ws.typedLine() ?? '';
    // `|| exit 1` 而不是 `&&`：后者在 cd 失败时会让 exec 不执行、shell 原地留着，
    // 上层的 onExit 永远不触发 —— 一个「看起来正常」的错环境。
    expect(line.startsWith(`cd '/nope' || exit 1; `)).toBe(true);
  });

  it('env 值走 export 而不是 `env K=V`，⛔ 不进 argv', async () => {
    const ws = await openAndSettle(['claude'], { env: { ANTHROPIC_API_KEY: 'sk-secret' } });
    const line = ws.typedLine() ?? '';
    // `env K=V cmd` 会把值放进 env 进程的 argv，容器里谁都能从 /proc/<pid>/cmdline 读到。
    expect(line).toBe("export ANTHROPIC_API_KEY='sk-secret'; exec 'claude'\n");
    expect(line).not.toContain('env ANTHROPIC_API_KEY=');
  });

  it('值里的单引号被引死，不会逃出去变成新的 shell 词', async () => {
    const ws = await openAndSettle(['sh'], { env: { X: "a'; rm -rf /; echo '" } });
    expect(ws.typedLine()).toBe(`export X='a'\\''; rm -rf /; echo '\\'''; exec 'sh'\n`);
  });

  it('两个字段都没有时，敲进去的那一行与老行为逐字节一致', async () => {
    const ws = await openAndSettle(['tmux', 'attach', '-t', 'platform-agent']);
    expect(ws.typedLine()).toBe(`exec 'tmux' 'attach' '-t' 'platform-agent'\n`);
  });

  it('env 名字非法要当场炸，且**连 socket 都不开**', async () => {
    vi.stubGlobal('WebSocket', FakeWs);
    const client = new AioSandboxAgentClient('http://127.0.0.1:1');
    await expect(
      client.openTerminal(120, 30, ['sh'], { env: { 'BAD-NAME': 'x' } }),
    ).rejects.toMatchObject({ code: SandboxProviderErrorCode.INVALID_STATE });
    // ⚠️ 决定性的一条：先拼行再连。否则就是「连上了、什么都没跑、也没人报错」。
    expect(FakeWs.last).toBeUndefined();
  });
});

/**
 * 上一组用例盯的是 `openTerminal` 自己。这一条盯的是**它上面那一跳** —— `spawn()` 有没有
 * 把 `spec.env` / `spec.cwd` 递下去。⚠️ 两处必须分开验：翻译写对了但 provider 不递，
 * 症状与「根本没实现」一模一样，而 2026-09-23 那次真机故障恰恰就停在这一跳上。
 */
class StubRuntime implements ContainerRuntime {
  readonly kind = 'stub';

  create(_spec: ContainerCreateSpec): Promise<string> {
    return Promise.reject(new Error('本用例只走 spawn'));
  }

  start(_id: string): Promise<void> {
    return Promise.reject(new Error('本用例只走 spawn'));
  }

  stop(_id: string): Promise<void> {
    return Promise.reject(new Error('本用例只走 spawn'));
  }

  destroy(_id: string): Promise<void> {
    return Promise.reject(new Error('本用例只走 spawn'));
  }

  inspect(_id: string): Promise<SandboxRuntimeStatus> {
    return Promise.reject(new Error('本用例只走 spawn'));
  }

  agentOrigin(_id: string, _port: number): Promise<string> {
    return Promise.resolve('http://127.0.0.1:1');
  }
}

describe('AioSandboxProvider.spawn —— tty 那一跳不许把 env/cwd 吃掉', () => {
  it('spec 上的 env 与 cwd 一路落到敲进 shell 的那一行', async () => {
    vi.stubGlobal('WebSocket', FakeWs);
    // ⚠️ 第二个参数把 runtime 换掉；docker client 只是构造器的形参，本用例一步都不碰它。
    const provider = new AioSandboxProvider(createDockerClient(), new StubRuntime());
    const home = '/home/gem/auth-helper.zz99';
    const spawning = provider.spawn(
      { provider: 'aio', providerSandboxId: 'container-id' },
      { cmd: ['codex', 'login'], tty: true, cols: 120, rows: 30, cwd: home, env: { HOME: home } },
    );
    // ⚠️ 这里不能像上面那样同步取：`spawn` 要先 await 出 agent origin，socket 是后建的。
    const ws = await waitForSocket();
    setTimeout(() => ws.frame({ type: 'ready' }), 10);
    await spawning;

    expect(ws.typedLine()).toBe(
      `cd '${home}' || exit 1; export HOME='${home}'; exec 'codex' 'login'\n`,
    );
  });
});
