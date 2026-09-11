// 终端**多标签**：第 N 个标签是一个独立的 tmux 会话（06 §5 / P21-1 §6）。
//
// ── 这组用例存在的根据（2026-09-11 实测，tmux 3.7b，两个 `script` 造的 pty）────────
// 在此之前，`openSession()` 的三条路**全部** attach `platform-agent`。而 tmux 的 pane
// 属于 session、不属于 client：
//
//     list-clients  → tty=/dev/ttys001 session=S ; tty=/dev/ttys004 session=S
//     list-panes -a → S:0.0 id=%0                       ← 只有一个 pane
//
// 所以"再开一条 WS"拿到的是**同一块屏幕的镜像**，用户在"第二个终端"里敲的字会落进
// 正在跑的 agent。同一次实测里换个 session 名就得到了独立的 `%1` —— 这组用例钉住的
// 就是"换名字"这条路，以及它周围那三条绝不能松的纪律：
//   ① agent 会话永远不被销毁（裁决 D-15）；
//   ② session 名服务端生成，客户端不许指定（审计 P2-9，且它直接进 argv）；
//   ③ 新 tmux 入口必须带 `-u` 与前置 `set -g mouse on`。
import { describe, it, expect } from 'vitest';
import {
  PLATFORM_AGENT_TMUX_SESSION,
  TERMINAL_SHELL_ID_RE,
  WS_SCHEMA_HASH,
  isTerminalShellId,
} from '@platform/contracts';
import type {
  OpenPtyOptions,
  ProcessStream,
  RuntimeAdapter,
  RuntimeAdapterRegistry,
  SandboxCommand,
  SandboxExecFn,
  SandboxExecPort,
  SandboxPtyPort,
  TerminalAuthenticator,
} from '@platform/contracts';
import { TerminalSessionService } from '../../src/application/terminal-session.service';
import { TerminalGateway } from '../../src/interface/gateway/terminal.gateway';
import type { ShellSessionSummary } from '../../src/domain/services/tmux-command.policy';
import {
  PLATFORM_SHELL_SESSION_PREFIX,
  SHELL_SESSION_ID_RE,
  TMUX_RUNTIME_OPTION,
  attachOrCreateRuntimeCmd,
  attachOrCreateShellCmd,
  killShellSessionCmd,
  listSessionsCmd,
  parseShellSessionList,
  runtimeTabScript,
  shellSessionName,
} from '../../src/domain/services/tmux-command.policy';

const ID_A = '0123456789abcdef0123456789abcdef';
const ID_B = 'fedcba9876543210fedcba9876543210';

// ────────────────────────────────────────────────────────────────────────────
// 领域层：命令形状与命名闸门
// ────────────────────────────────────────────────────────────────────────────

describe('tmux 命令策略 —— 用户终端标签的入口', () => {
  it('⚠️ 带 `-u`，且 `set -g mouse on` **前置**在 new-session 之前', () => {
    const cmd = attachOrCreateShellCmd(shellSessionName(ID_A), '/workspace');

    // 少了 `-u`：这个标签里所有非 ASCII 字符变成 `_`（实测，见策略文件注释）。
    expect(cmd).toContain('-u');
    // 少了 mouse on：滚轮被 xterm.js 翻译成一串方向键灌进标签里跑着的程序。
    const mouse = cmd.join(' ');
    expect(mouse).toContain('set -g mouse on ;');
    // ⚠️ 判据是**顺序**，不只是"出现过"。写在 new-session（前台阻塞）之后的话，
    //    要等它退出才轮得到执行 —— 等于没设，而 `toContain` 照样绿。
    expect(cmd.indexOf('mouse')).toBeLessThan(cmd.indexOf('new-session'));
    expect(cmd.indexOf('-u')).toBeLessThan(cmd.indexOf('new-session'));
  });

  it('`-A` = 不在就建、在就接回；`-c` 落在工作区', () => {
    expect(attachOrCreateShellCmd(shellSessionName(ID_A), '/workspace')).toEqual([
      'tmux',
      '-u',
      'set',
      '-g',
      'mouse',
      'on',
      ';',
      'new-session',
      '-A',
      '-s',
      `${PLATFORM_SHELL_SESSION_PREFIX}${ID_A}`,
      '-c',
      '/workspace',
    ]);
  });

  it('拿不到工作目录时只是少一个 `-c`，命令仍然成立', () => {
    const cmd = attachOrCreateShellCmd(shellSessionName(ID_A));
    expect(cmd).not.toContain('-c');
    expect(cmd.at(-1)).toBe(`${PLATFORM_SHELL_SESSION_PREFIX}${ID_A}`);
  });

  it('⛔ **不复用 `agentScript`**：用户敲 `exit` 就该退出，而不是被再起一个 shell 接住', () => {
    // agentScript 会在命令退出后 `exec $SHELL` —— 那条对 agent 会话是对的（跑完的
    // agent 不该把会话带走），放到用户 shell 上就成了永远退不掉的会话。
    const cmd = attachOrCreateShellCmd(shellSessionName(ID_A), '/workspace');
    expect(cmd.join(' ')).not.toContain('exec "${SHELL:-/bin/sh}"');
    expect(cmd.join(' ')).not.toContain('[platform] agent session ended');
  });
});

describe('shellSessionName —— 「客户端不许指定 session 名」的 argv 侧闸门', () => {
  it('合法 id 拼成 platform-shell-<id>', () => {
    expect(shellSessionName(ID_A)).toBe(`platform-shell-${ID_A}`);
  });

  it.each([
    ['platform-agent', 'agent 会话名'],
    ['', '空串'],
    ['0123456789abcdef0123456789abcde', '31 位（短一位）'],
    ['0123456789abcdef0123456789abcdef0', '33 位（长一位）'],
    ['0123456789ABCDEF0123456789ABCDEF', '大写十六进制'],
    ['0123456789abcdef0123456789abcde;', '带分号'],
    ['../../etc/passwd', '路径穿越形状'],
    ['$(id)', '命令替换形状'],
    ['a b', '带空格'],
  ])('⛔ 拒绝 %s（%s）—— 抛，而不是兜底成一个"安全的"名字', (bad) => {
    expect(() => shellSessionName(bad)).toThrow(/shellId 形状不合法/);
  });

  it('⛔ **结构性地**碰不到 agent 会话：kill 入口只收 id，拼不出 platform-agent', () => {
    // 这一条不是"记得写个 if"，是"那个名字根本构造不出来"。
    expect(() => killShellSessionCmd(PLATFORM_AGENT_TMUX_SESSION)).toThrow();
    // 任何合法 id 拼出来的名字都不可能等于 agent 会话名（前缀 + 形状双重隔离）。
    expect(killShellSessionCmd(ID_A)).toEqual([
      'tmux',
      '-u',
      'kill-session',
      '-t',
      `platform-shell-${ID_A}`,
    ]);
    expect(killShellSessionCmd(ID_A)).not.toContain(PLATFORM_AGENT_TMUX_SESSION);
  });

  it('契约层与领域层的 id 正则**逐字**相同（领域不许 import contracts，23 §4.5）', () => {
    // 两份拷贝的唯一守卫就是这一条；漂了之后握手会放行一个领域层拼不出来的 id。
    expect(SHELL_SESSION_ID_RE.source).toBe(TERMINAL_SHELL_ID_RE.source);
    expect(SHELL_SESSION_ID_RE.flags).toBe(TERMINAL_SHELL_ID_RE.flags);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 应用层：openSession 的两支 + closeShellSession
// ────────────────────────────────────────────────────────────────────────────

class StubAdapter implements RuntimeAdapter {
  readonly id = 'codex';
  readonly displayName = 'Codex';
  readonly vendor = 'OpenAI';
  loginCommand(): string[] {
    return ['codex', 'login'];
  }
  getAuthMethods(): ['api-key'] {
    return ['api-key'];
  }
  async beginAuth(): Promise<never> {
    throw new Error('not used');
  }
  async completeAuth(): Promise<never> {
    throw new Error('not used');
  }
  async injectCredential(): Promise<void> {}
  getInstallPlan(): never {
    throw new Error('not used');
  }
  async isInstalled(): Promise<boolean> {
    return true;
  }
  async install(): Promise<void> {}
  buildStartCommand(): SandboxCommand {
    throw new Error('⛔ 打开终端这条路永远不该调 buildStartCommand（裁决 D-15）');
  }
  buildAttachCommand(): SandboxCommand {
    return { cmd: ['codex', '-s', 'danger-full-access'] };
  }
}

function serviceHarness(opts: { hasAgentSession?: boolean; killExit?: number } = {}) {
  const adapter = new StubAdapter();
  const runtimes: RuntimeAdapterRegistry = {
    register: () => {},
    get: () => adapter,
    has: () => true,
    list: () => [adapter],
  };
  const execCalls: string[][] = [];
  const exec: SandboxExecFn = async (cmd) => {
    execCalls.push(cmd);
    const joined = cmd.join(' ');
    if (joined.includes('has-session')) {
      return { stdout: '', stderr: '', exitCode: opts.hasAgentSession === false ? 1 : 0 };
    }
    if (joined.includes('kill-session')) {
      return { stdout: '', stderr: '', exitCode: opts.killExit ?? 0 };
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  };
  const sandboxes: SandboxExecPort = {
    async execFor() {
      return exec;
    },
    async bindingOf(sandboxId) {
      return {
        sandboxId,
        runtimeId: 'codex',
        availableRuntimes: ['codex', 'claude-code'],
        workdir: '/workspace',
      };
    },
  };
  const ptyCalls: OpenPtyOptions[] = [];
  const pty: SandboxPtyPort = {
    async openPty(_id, o): Promise<ProcessStream> {
      ptyCalls.push(o);
      return {
        ref: 'fake',
        onData: () => {},
        onExit: () => {},
        write: () => {},
        resize: () => {},
        detach: () => {},
        kill: async () => {},
      };
    },
  };
  return {
    service: new TerminalSessionService(runtimes, sandboxes, pty),
    execCalls,
    ptyCalls,
  };
}

describe('TerminalSessionService#openSession —— 两支会话', () => {
  it('缺省（以及任何旧客户端）仍然 attach platform-agent —— 裁决 D-15 那条不动', async () => {
    const h = serviceHarness();
    await h.service.openSession('sb-1', { cols: 80, rows: 24 });
    expect(h.ptyCalls[0]?.cmd).toEqual([
      'tmux',
      '-u',
      'set',
      '-g',
      'mouse',
      'on',
      ';',
      'attach',
      '-t',
      PLATFORM_AGENT_TMUX_SESSION,
    ]);
  });

  it('`kind:shell` 走的是**另一个** session —— 而不是 agent 那一屏的镜像', async () => {
    const h = serviceHarness();
    await h.service.openSession('sb-1', {
      cols: 80,
      rows: 24,
      target: { kind: 'shell', shellId: ID_A },
    });

    const cmd = h.ptyCalls[0]?.cmd ?? [];
    // 这一条就是本次改造的核心断言：新标签连的绝不能是 agent 那个 session。
    expect(cmd).not.toContain(PLATFORM_AGENT_TMUX_SESSION);
    expect(cmd).toContain(`platform-shell-${ID_A}`);
    expect(cmd).toContain('new-session');
    expect(cmd).toContain('-A');
    // 滚轮与 UTF-8 这两条在新路径上同样成立（两个坑都刚修过，有用例钉着）。
    expect(cmd).toContain('-u');
    expect(cmd.join(' ')).toContain('set -g mouse on ;');
  });

  it('两个不同的 shellId ⇒ 两个不同的 session（这才叫"多标签"）', async () => {
    const h = serviceHarness();
    await h.service.openSession('sb-1', {
      cols: 80,
      rows: 24,
      target: { kind: 'shell', shellId: ID_A },
    });
    await h.service.openSession('sb-1', {
      cols: 80,
      rows: 24,
      target: { kind: 'shell', shellId: ID_B },
    });
    expect(h.ptyCalls[0]?.cmd).not.toEqual(h.ptyCalls[1]?.cmd);
  });

  it('⛔ shell 那一支不会去探/建 agent 会话（不许顺手碰到 platform-agent）', async () => {
    const h = serviceHarness();
    await h.service.openSession('sb-1', {
      cols: 80,
      rows: 24,
      target: { kind: 'shell', shellId: ID_A },
    });
    expect(h.execCalls.some((c) => c.includes(PLATFORM_AGENT_TMUX_SESSION))).toBe(false);
  });

  it('形状不合法的 shellId 在拼命令时就抛，绝不进 argv', async () => {
    const h = serviceHarness();
    await expect(
      h.service.openSession('sb-1', {
        cols: 80,
        rows: 24,
        target: { kind: 'shell', shellId: 'platform-agent' },
      }),
    ).rejects.toThrow(/shellId 形状不合法/);
    expect(h.ptyCalls).toHaveLength(0);
  });
});

describe('TerminalSessionService#closeShellSession —— 显式关标签才销毁', () => {
  it('kill 的是那一个 platform-shell-<id>，别的什么都不碰', async () => {
    const h = serviceHarness();
    await h.service.closeShellSession('sb-1', ID_A);
    expect(h.execCalls).toEqual([['tmux', '-u', 'kill-session', '-t', `platform-shell-${ID_A}`]]);
  });

  it('会话已经不在（退出码非零）不算失败 —— 与目标状态一致', async () => {
    const h = serviceHarness({ killExit: 1 });
    await expect(h.service.closeShellSession('sb-1', ID_A)).resolves.toBeUndefined();
  });

  it('⛔ 拿 agent 会话名来调 ⇒ 抛，且一条命令都没发出去', async () => {
    const h = serviceHarness();
    await expect(h.service.closeShellSession('sb-1', PLATFORM_AGENT_TMUX_SESSION)).rejects.toThrow(
      /shellId 形状不合法/,
    );
    expect(h.execCalls).toHaveLength(0);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 网关：握手寻址 + close_shell 帧
// ────────────────────────────────────────────────────────────────────────────

interface FakeClient {
  id: string;
  handshake: { query: Record<string, string>; headers: Record<string, string> };
  emit: (ev: string, f: unknown) => void;
  disconnect: () => void;
}

function fakeClient(query: Record<string, string>, frames: unknown[] = []): FakeClient {
  return {
    id: 'c1',
    handshake: {
      query: { sandboxId: 'sb-1', cols: '80', rows: '24', ...query },
      headers: { 'x-schema-hash': WS_SCHEMA_HASH },
    },
    emit: (_ev, f) => frames.push(f),
    disconnect: () => {},
  };
}

/** 记录 service 侧收到了什么；⛔ 未被本组覆盖的方法一律响亮地抛。 */
function gatewayHarness() {
  const opened: { sandboxId: string; opts: unknown }[] = [];
  const closed: { sandboxId: string; shellId: string }[] = [];
  const stub = Object.create(TerminalSessionService.prototype) as TerminalSessionService;
  const sessions = Object.assign(stub, {
    openSession: async (sandboxId: string, opts: unknown): Promise<ProcessStream> => {
      opened.push({ sandboxId, opts });
      return {
        ref: 'fake',
        onData: () => {},
        onExit: () => {},
        write: () => {},
        resize: () => {},
        detach: () => {},
        kill: async () => {},
      };
    },
    closeShellSession: async (sandboxId: string, shellId: string): Promise<void> => {
      closed.push({ sandboxId, shellId });
    },
    bootstrapAgentSession: (): never => {
      throw new Error('本组用例不该调 bootstrapAgentSession');
    },
  });
  const gw = new TerminalGateway(sessions, {
    authorize: () => true,
  } satisfies TerminalAuthenticator);
  return { gw, opened, closed };
}

/** 走 afterInit 装上的 middleware，拿到它给 `next()` 的那个错（`null` = 放行）。 */
function handshake(gw: TerminalGateway, query: Record<string, string>): Error | null {
  let captured: Error | null = null;
  const server = {
    use: (fn: (socket: unknown, next: (err?: Error) => void) => void): void => {
      fn(fakeClient(query), (err) => {
        captured = err ?? null;
      });
    },
  };
  gw.afterInit(server as never);
  return captured;
}

describe('TerminalGateway 握手 —— 连**哪一个**会话是寻址的一部分', () => {
  it('不带 kind（旧客户端）照常放行 ⇒ agent 那一支，零影响', () => {
    expect(handshake(gatewayHarness().gw, {})).toBeNull();
    expect(handshake(gatewayHarness().gw, { kind: 'agent' })).toBeNull();
    expect(handshake(gatewayHarness().gw, { kind: 'shell' })).toBeNull();
    expect(handshake(gatewayHarness().gw, { kind: 'shell', shellId: ID_A })).toBeNull();
  });

  it('⛔ kind 认不出 ⇒ TERMINAL_TARGET_INVALID，**不**悄悄按 agent 处理', () => {
    // 按 agent 兜底的话，用户点「+ 新终端」会安静地拿到 agent 那一屏的镜像，
    // 在里面敲的每个字都进了正在跑的 agent —— 界面上没有任何异常。
    const err = handshake(gatewayHarness().gw, { kind: 'shel1' });
    expect(err?.message).toMatch(/^TERMINAL_TARGET_INVALID: /);
    expect(Reflect.get(err as object, 'data')).toEqual({ code: 'TERMINAL_TARGET_INVALID' });
  });

  it.each([['platform-agent'], ['$(id)'], ['a b'], ['deadbeef']])(
    '⛔ 形状不对的 shellId（%s）⇒ 拒绝，不悄悄新开一个',
    (bad) => {
      const err = handshake(gatewayHarness().gw, { kind: 'shell', shellId: bad });
      expect(err?.message).toMatch(/^TERMINAL_TARGET_INVALID: /);
    },
  );

  it('⚠️ 它不叫 UNAUTHORIZED —— 口令是对的，错的是寻址（叫错会弹一扇没用的解锁门）', () => {
    const err = handshake(gatewayHarness().gw, { kind: 'nope' });
    // 前端的兜底匹配器用 /unauthor|forbidden|passcode|401|403/i 认"未授权"，
    // 所以这条消息里一个都不许出现。
    expect(err?.message ?? '').not.toMatch(/unauthor|forbidden|passcode|401|403/i);
  });
});

describe('TerminalGateway#handleConnection —— shellId 的来处与去处', () => {
  it('⭐ kind=shell 不带 id ⇒ **服务端**现铸一个 128-bit 的，并在 session 首帧回传', async () => {
    const h = gatewayHarness();
    const frames: unknown[] = [];
    await h.gw.handleConnection(fakeClient({ kind: 'shell' }, frames) as never);

    const target = Reflect.get(h.opened[0]?.opts as object, 'target') as {
      kind: string;
      shellId: string;
    };
    expect(target.kind).toBe('shell');
    // 形状必须过契约那道闸门，否则后端自己拼不出 tmux 会话名。
    expect(isTerminalShellId(target.shellId)).toBe(true);
    expect(() => shellSessionName(target.shellId)).not.toThrow();
    // 前端靠这一帧记住自己这个标签背后是哪个会话（刷新/被 LRU 淘汰后接得回去）。
    expect(frames[0]).toMatchObject({ type: 'session', shellId: target.shellId });
  });

  it('每开一个新标签铸的 id 都不同（否则两个标签会共用同一个 tmux 会话）', async () => {
    const h = gatewayHarness();
    await h.gw.handleConnection(fakeClient({ kind: 'shell' }) as never);
    await h.gw.handleConnection(fakeClient({ kind: 'shell' }) as never);
    const idOf = (i: number): string =>
      (Reflect.get(h.opened[i]?.opts as object, 'target') as { shellId: string }).shellId;
    expect(idOf(0)).not.toBe(idOf(1));
  });

  it('kind=shell 带 id ⇒ 接回那一个，不另开', async () => {
    const h = gatewayHarness();
    const frames: unknown[] = [];
    await h.gw.handleConnection(fakeClient({ kind: 'shell', shellId: ID_A }, frames) as never);
    expect(Reflect.get(h.opened[0]?.opts as object, 'target')).toEqual({
      kind: 'shell',
      shellId: ID_A,
    });
  });

  it('⚠️ agent 连接的 session 帧**没有** shellId 字段（缺席 ≠ 空串）', async () => {
    const h = gatewayHarness();
    const frames: unknown[] = [];
    await h.gw.handleConnection(fakeClient({}, frames) as never);
    expect(Reflect.get(h.opened[0]?.opts as object, 'target')).toEqual({ kind: 'agent' });
    expect(Object.hasOwn(frames[0] as object, 'shellId')).toBe(false);
  });
});

describe('TerminalGateway —— 销毁只由显式关标签触发', () => {
  it('close_shell 帧 ⇒ 销毁那一个 shell 会话', async () => {
    const h = gatewayHarness();
    const client = fakeClient({ kind: 'shell', shellId: ID_A });
    await h.gw.handleConnection(client as never);

    h.gw.onFrame(client as never, { type: 'close_shell', shellId: ID_A });

    expect(h.closed).toEqual([{ sandboxId: 'sb-1', shellId: ID_A }]);
  });

  it('⛔ **断开一个字都不销毁** —— 刷新页面 / LRU 淘汰不许带走会话', async () => {
    const h = gatewayHarness();
    const client = fakeClient({ kind: 'shell', shellId: ID_A });
    await h.gw.handleConnection(client as never);

    h.gw.handleDisconnect(client as never);

    // 这一条与 agent 会话那条（disconnect-detach.spec）是同一条纪律：那个标签里
    // 可能正跑着一个长构建，刷一下页面就把它打断是不可接受的。
    expect(h.closed).toEqual([]);
  });

  it('被 LRU 淘汰的标签也关得掉：close_shell 可由**同一沙箱的任意一条连接**代发', async () => {
    const h = gatewayHarness();
    // 只剩 agent 那条连接还开着（用户自己那个标签早被淘汰，socket 已关）。
    const agentClient = fakeClient({});
    await h.gw.handleConnection(agentClient as never);

    h.gw.onFrame(agentClient as never, { type: 'close_shell', shellId: ID_B });

    // 少了这条，淘汰过的标签点 [×] 只会让它从界面上消失，而沙箱里那个 tmux 会话
    // 成了谁也看不见、谁也关不掉的孤儿。
    expect(h.closed).toEqual([{ sandboxId: 'sb-1', shellId: ID_B }]);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 刷新后的恢复：沙箱里还活着哪几个用户终端（06 §5.5）
//
// 它修的是什么：tmux 会话活在沙箱里、活过刷新，而"有哪几个标签"此前只活在浏览器内存里
// （`shellId` 是会话凭据，15 §3.5 不许 persist）。⇒ 刷一下页面，那些会话就变成**还活着
// 但界面上没有**的孤儿。而"看不见但还活着比关掉更糟"正是 §5.4 决定「关标签要销毁」时
// 的立论 —— 不能一边拿它当理由、一边在刷新这条路上走到同一个坏状态。
// ────────────────────────────────────────────────────────────────────────────

describe('parseShellSessionList —— 从 tmux 输出里筛出**我们自己的**会话', () => {
  /** 真实形状：`<会话名>\t<创建时间>`，每行一个（实测 tmux 3.7b 的 -F 输出）。 */
  const row = (name: string, created: number): string => `${name}\t${String(created)}`;

  it('⛔ `platform-agent` **不在清单里**（它进去就会多出一个可关的任务标签）', () => {
    const out = [row('platform-agent', 100), row(`platform-shell-${ID_A}`, 200)].join('\n');
    expect(parseShellSessionList(out)).toEqual([{ shellId: ID_A }]);
  });

  /**
   * ⚠️ **前缀闸门要靠规则挡，不能靠运气。**
   *
   * 上一条单独看是"绿的"，但它绿得**不是**因为前缀被检查了 —— 把前缀那一行整个删掉，
   * 它照样绿：`platform-agent` 只有 14 个字符，`slice(15)` 之后是空串，恰好被**形状**
   * 闸门顺手挡下。注入验证当场抓到了这一点（Ⓐ 变异体没能让任何用例变红）。
   *
   * ⇒ 这一条补的就是那个缺口：一个**别的** 15 字符前缀 + 32 位十六进制的会话名。
   * 少了前缀检查它就会被当成我们的标签（而它可能是沙箱里另一个工具起的会话）。
   */
  it('⛔ 前缀闸门本身要生效：别人家的 `<15 字符>-<32 位十六进制>` 不许混进来', () => {
    const foreign = `unrelated-tool-${ID_B}`; // `unrelated-tool-` 恰好 15 字符，与我们的前缀等长
    expect(foreign.length).toBe(`platform-shell-${ID_B}`.length); // 长度一样 ⇒ 只有前缀能分辨
    const out = [row(foreign, 100), row(`platform-shell-${ID_A}`, 200)].join('\n');
    expect(parseShellSessionList(out)).toEqual([{ shellId: ID_A }]);
  });

  it('⛔ 前缀对但形状不对的**静默跳过** —— 那是用户自己在沙箱里起的会话，不是我们的标签', () => {
    // 用户完全可以 `tmux new -s platform-shell-hi`。它不该冒充平台标签，而这一段最终
    // 会回到 `tmux -s` 的 argv 里。⚠️ 判据必须是**形状**，不能只靠前缀"看起来像"。
    const out = [
      row('platform-shell-hi', 100),
      row('platform-shell-../../etc/passwd', 110),
      row(`platform-shell-${'A'.repeat(32)}`, 120), // 大写十六进制
      row(`platform-shell-${ID_A}`, 130),
      row('用户自己起的会话', 140),
    ].join('\n');
    expect(parseShellSessionList(out)).toEqual([{ shellId: ID_A }]);
  });

  it('⛔ 跳过而不是抛：沙箱里一个手工起的同前缀会话，不许让整张清单取不回来', () => {
    expect(() => parseShellSessionList(row('platform-shell-hi', 1))).not.toThrow();
  });

  it('⭐ 按 `session_created` **升序** —— 这个顺序就是前端的「终端 1..n」', () => {
    const out = [
      row(`platform-shell-${ID_B}`, 300),
      row(`platform-shell-${ID_A}`, 100),
      row('platform-agent', 50),
    ].join('\n');
    // 输出顺序不是 tmux 给的顺序，是创建顺序 —— 刷新前后要稳定地指向同一个"终端 1"。
    expect(parseShellSessionList(out)).toEqual([{ shellId: ID_A }, { shellId: ID_B }]);
  });

  it('同秒创建按 id 排（同一份输入永远得到同一个顺序，否则标签会自己改名）', () => {
    const out = [row(`platform-shell-${ID_B}`, 7), row(`platform-shell-${ID_A}`, 7)].join('\n');
    expect(parseShellSessionList(out)).toEqual([{ shellId: ID_A }, { shellId: ID_B }]);
  });

  it('空输入 / 空行 / 半行都不炸', () => {
    expect(parseShellSessionList('')).toEqual([]);
    expect(parseShellSessionList('\n\n')).toEqual([]);
    expect(parseShellSessionList('platform-shell-' + ID_A)).toEqual([{ shellId: ID_A }]); // 没有 \t
  });
});

describe('listSessionsCmd —— 命令形状', () => {
  it('带 `-u`；⛔ **不带** `set -g mouse on`（它的退出码是载荷）', () => {
    const cmd = listSessionsCmd();
    expect(cmd).toEqual([
      'tmux',
      '-u',
      'list-sessions',
      '-F',
      `#{session_name}\t#{session_created}\t#{${TMUX_RUNTIME_OPTION}}`,
    ]);
    // 前面链一条 `set` 就是拿链式命令的退出码去冒充 list-sessions 的 ——
    // 那会把「问不出来」悄悄变成「没有」。与 hasSessionCmd 同一条理由。
    expect(cmd.join(' ')).not.toContain('mouse');
  });
});

describe('TerminalSessionService#listShellSessions —— 三态', () => {
  function listHarness(res: { exitCode: number; stdout?: string; throws?: string }) {
    const adapter = new StubAdapter();
    const runtimes: RuntimeAdapterRegistry = {
      register: () => {},
      get: () => adapter,
      has: () => true,
      list: () => [adapter],
    };
    const exec: SandboxExecFn = async () => {
      if (res.throws !== undefined) throw new Error(res.throws);
      return { stdout: res.stdout ?? '', stderr: '', exitCode: res.exitCode };
    };
    const sandboxes: SandboxExecPort = {
      async execFor() {
        if (res.throws === 'EXEC_UNREACHABLE') throw new Error('sandbox gone');
        return exec;
      },
      async bindingOf(sandboxId) {
        return {
          sandboxId,
          runtimeId: 'codex',
          availableRuntimes: ['codex', 'claude-code'],
          workdir: '/workspace',
        };
      },
    };
    const pty: SandboxPtyPort = {
      async openPty(): Promise<ProcessStream> {
        throw new Error('本组用例不开 pty');
      },
    };
    return new TerminalSessionService(runtimes, sandboxes, pty);
  }

  it('① 有会话 ⇒ 按创建顺序给出 id', async () => {
    const svc = listHarness({
      exitCode: 0,
      stdout: `platform-agent\t1\nplatform-shell-${ID_B}\t9\nplatform-shell-${ID_A}\t3`,
    });
    await expect(svc.listShellSessions('sb-1')).resolves.toEqual([
      { shellId: ID_A },
      { shellId: ID_B },
    ]);
  });

  it('② 确认没有 ⇒ **空数组**（tmux 答了，就是一个都没有）', async () => {
    const svc = listHarness({ exitCode: 0, stdout: 'platform-agent\t1' });
    await expect(svc.listShellSessions('sb-1')).resolves.toEqual([]);
  });

  it('⭐③ 问不出来 ⇒ **null，绝不是空数组**（`no server running` 这类）', async () => {
    // ⛔ 折成 `[]` 会让前端把"查不到"渲染成"你没有开过终端"，而用户下一步完全不同。
    const svc = listHarness({ exitCode: 1, stdout: '' });
    await expect(svc.listShellSessions('sb-1')).resolves.toBeNull();
  });

  it('③b exec 不可达同样是 null，不是空', async () => {
    const svc = listHarness({ exitCode: 0, throws: 'EXEC_UNREACHABLE' });
    await expect(svc.listShellSessions('sb-1')).resolves.toBeNull();
  });
});

describe('TerminalGateway —— 清单怎么推', () => {
  /** 带 `listShellSessions` 的网关替身。 */
  function inventoryHarness(result: ShellSessionSummary[] | null | { throws: string }) {
    const frames: unknown[] = [];
    const stub = Object.create(TerminalSessionService.prototype) as TerminalSessionService;
    const calls: string[] = [];
    const sessions = Object.assign(stub, {
      openSession: async (): Promise<ProcessStream> => ({
        ref: 'fake',
        onData: () => {},
        onExit: () => {},
        write: () => {},
        resize: () => {},
        detach: () => {},
        kill: async () => {},
      }),
      listShellSessions: async (sandboxId: string): Promise<ShellSessionSummary[] | null> => {
        calls.push(sandboxId);
        if (result !== null && !Array.isArray(result)) throw new Error(result.throws);
        return result;
      },
      closeShellSession: (): never => {
        throw new Error('本组用例不该调 closeShellSession');
      },
      bootstrapAgentSession: (): never => {
        throw new Error('本组用例不该调 bootstrapAgentSession');
      },
    });
    const gw = new TerminalGateway(sessions, {
      authorize: () => true,
    } satisfies TerminalAuthenticator);
    return { gw, frames, calls };
  }

  /** 推清单是 fire-and-forget，让出一轮微任务再断言。 */
  const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

  it('⭐ agent 连接 ⇒ `session` 之后补一帧清单（刷新后靠它把标签栏重建回来）', async () => {
    const h = inventoryHarness([{ shellId: ID_A }, { shellId: ID_B }]);
    await h.gw.handleConnection(fakeClient({}, h.frames) as never);
    await flush();

    // ⚠️ 顺序是断言的一部分：清单**不许**挡在 `session` 前面 —— 那一帧装着重连凭据、
    //    也是前端判定"连上了"的那一帧，让它等一次 exec 就是把开终端的首帧延后。
    expect(h.frames[0]).toMatchObject({ type: 'session' });
    expect(h.frames[1]).toEqual({
      type: 'shells',
      shells: [{ shellId: ID_A }, { shellId: ID_B }],
    });
  });

  it('⛔ shell 连接**不推**清单（N 个标签付 N 次 exec，换回 N 份一样的清单）', async () => {
    const h = inventoryHarness([{ shellId: ID_A }]);
    await h.gw.handleConnection(fakeClient({ kind: 'shell', shellId: ID_A }, h.frames) as never);
    await flush();

    expect(h.calls).toEqual([]);
    expect(h.frames.some((f) => (f as { type: string }).type === 'shells')).toBe(false);
  });

  it('⭐ 问不出来 ⇒ 照发一帧 `shells:null`，⛔ 不许用"不发帧"表示它', async () => {
    // "不发" 与 "还没答" 在前端无从区分，于是那个"查不到"永远说不出口。
    const h = inventoryHarness(null);
    await h.gw.handleConnection(fakeClient({}, h.frames) as never);
    await flush();
    expect(h.frames[1]).toEqual({ type: 'shells', shells: null });
  });

  it('确认没有 ⇒ 空数组（与上一条是两件事）', async () => {
    const h = inventoryHarness([]);
    await h.gw.handleConnection(fakeClient({}, h.frames) as never);
    await flush();
    expect(h.frames[1]).toEqual({ type: 'shells', shells: [] });
  });

  it('意外抛出也落到 null 那一支，不让这条连接失败', async () => {
    const h = inventoryHarness({ throws: 'boom' });
    await h.gw.handleConnection(fakeClient({}, h.frames) as never);
    await flush();
    expect(h.frames[1]).toEqual({ type: 'shells', shells: null });
  });
});

// ────────────────────────────────────────────────────────────────────────────
// runtime 标签：在一个独立会话里开一个 agent CLI（06 §5.6）
//
// ⚠️ 这**不是**「发起一个任务」。任务走 `buildStartCommand` + 建 AgentTask（产物 /
// 审计 / 超时 / 可取消都挂在它上面）；标签走 `buildAttachCommand`，不带指令、不记账。
// 用错入口的后果是一个**没人记账的任务**在沙箱里跑 —— 而界面上它只是一个标签。
// ────────────────────────────────────────────────────────────────────────────

describe('runtime 标签的命令', () => {
  const attachCmd = { cmd: ['codex', '-s', 'danger-full-access'], cwd: '/workspace' };

  it('⭐ 独立会话 + `-u` + 前置 mouse on（与纯终端标签同一套保证）', () => {
    const cmd = attachOrCreateRuntimeCmd(shellSessionName(ID_A), 'codex', attachCmd);
    expect(cmd).toContain('-u');
    expect(cmd.join(' ')).toContain('set -g mouse on ;');
    expect(cmd.indexOf('mouse')).toBeLessThan(cmd.indexOf('new-session'));
    expect(cmd).toContain(`platform-shell-${ID_A}`);
    // ⛔ 绝不是 agent 那个会话 —— 那会让「开一个 Codex 标签」变成"再看一遍任务那屏"。
    expect(cmd).not.toContain(PLATFORM_AGENT_TMUX_SESSION);
  });

  it('⭐ 会话给自己打 runtime 标记（刷新之后标签名才叫得对）', () => {
    const script = runtimeTabScript('claude-code', attachCmd);
    expect(script).toContain(`tmux set-option ${TMUX_RUNTIME_OPTION} 'claude-code'`);
    // ⚠️ 标记必须在 CLI **之前**：`new-session -A` 是前台阻塞的，链在它后面的命令要等
    //    它退出才轮得到执行 —— 与 mouse on 必须前置是同一条理由。
    expect(script.indexOf('set-option')).toBeLessThan(script.indexOf('codex'));
    // ⚠️ `|| true`：老 tmux 不认 `@`-用户选项也只是少一个标签名，不能让标签起不来。
    expect(script).toContain('|| true');
  });

  it('⛔ runtimeId 原样进 argv 之前先被引号包住（它来自握手 query）', () => {
    expect(runtimeTabScript("x'; id; '", attachCmd)).toContain(`'x'\\''; id; '\\'''`);
  });

  it('⭐ 复用 `agentScript` —— CLI 退出后落进一个 shell，标签不在眼前突然消失', () => {
    // 与纯终端标签恰好相反，两边理由互补（见 `attachOrCreateRuntimeCmd` 的注释）：
    // 纯 shell 复用它会"永远退不掉"；runtime 标签复用它才让 `/exit` 之后还有东西可看。
    const script = runtimeTabScript('codex', attachCmd);
    expect(script).toContain('exec "${SHELL:-/bin/sh}"');
    expect(script).toContain('[platform] agent session ended');
  });
});

describe('parseShellSessionList —— 认出标签里跑的是哪个 CLI', () => {
  const row = (name: string, created: number, runtime?: string): string =>
    `${name}\t${String(created)}\t${runtime ?? ''}`;

  it('⭐ 读出 runtimeId；纯终端标签**不带**这个字段', () => {
    const out = [
      row(`platform-shell-${ID_A}`, 100),
      row(`platform-shell-${ID_B}`, 200, 'claude-code'),
    ].join('\n');
    expect(parseShellSessionList(out)).toEqual([
      { shellId: ID_A },
      { shellId: ID_B, runtimeId: 'claude-code' },
    ]);
  });

  it('⛔ 读不到那一列 ⇒ 回落成"纯终端"，**绝不丢掉整条会话**', () => {
    // 沙箱里是 tmux 3.3a；万一那一版不支持 `#{@…}`，退化必须是"标签名叫得不够准"，
    // 而不是"刷新之后标签少了几个"。
    const legacy = `platform-shell-${ID_A}\t100`;
    expect(parseShellSessionList(legacy)).toEqual([{ shellId: ID_A }]);
  });
});

describe('TerminalSessionService#openSession —— runtime 标签', () => {
  it('⭐ 用 `buildAttachCommand()`，⛔ 不是 `buildStartCommand()`', async () => {
    // StubAdapter 的 buildStartCommand 会抛 —— 走错入口这条用例当场红。
    const h = serviceHarness();
    await h.service.openSession('sb-1', {
      cols: 80,
      rows: 24,
      target: { kind: 'runtime', shellId: ID_A, runtimeId: 'codex' },
    });
    const cmd = h.ptyCalls[0]?.cmd ?? [];
    expect(cmd.join(' ')).toContain("'codex' '-s' 'danger-full-access'");
    expect(cmd).toContain(`platform-shell-${ID_A}`);
    expect(cmd.join(' ')).toContain(`set-option ${TMUX_RUNTIME_OPTION} 'codex'`);
  });

  it('⛔ 沙箱里没有的 runtime ⇒ 抛，一个 pty 都不开', async () => {
    // 判据是沙箱行上那条记录（binding），⛔ 不是"注册表里有没有这个 id"。
    const h = serviceHarness();
    await expect(
      h.service.openSession('sb-1', {
        cols: 80,
        rows: 24,
        target: { kind: 'runtime', shellId: ID_A, runtimeId: 'not-injected' },
      }),
    ).rejects.toThrow(/没有可用的 'not-injected'/);
    expect(h.ptyCalls).toHaveLength(0);
  });
});

describe('TerminalGateway 握手 —— kind=runtime', () => {
  it('kind=runtime 带合法 runtimeId ⇒ 放行', () => {
    expect(
      handshake(gatewayHarness().gw, { kind: 'runtime', runtimeId: 'claude-code' }),
    ).toBeNull();
  });

  it('⛔ kind=runtime 不带 runtimeId ⇒ 拒（"开哪个 CLI"是寻址的一部分）', () => {
    const err = handshake(gatewayHarness().gw, { kind: 'runtime' });
    expect(err?.message).toMatch(/^TERMINAL_TARGET_INVALID: /);
  });

  it.each([['a b'], ["x';id;'"], ['UPPER'], ['']])(
    '⛔ 形状不对的 runtimeId（%s）⇒ 拒（它会进 tmux 负载里的 set-option 参数）',
    (bad) => {
      const err = handshake(gatewayHarness().gw, { kind: 'runtime', runtimeId: bad });
      expect(err?.message).toMatch(/^TERMINAL_TARGET_INVALID: /);
    },
  );

  it('⛔ runtimeId 形状闸门**不收窄成已注册的那几个**（04 §8 开放注册表）', () => {
    // 收窄会让第三方注册的 runtime 在握手层就被拒；真正的判据是"这个沙箱里有没有它"，
    // 那一步在 openSession 里读沙箱行。
    expect(handshake(gatewayHarness().gw, { kind: 'runtime', runtimeId: 'acme-cli' })).toBeNull();
  });
});
