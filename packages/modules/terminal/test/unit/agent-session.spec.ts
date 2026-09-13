import { describe, it, expect } from 'vitest';
import { ImageContractViolationError, PLATFORM_AGENT_TMUX_SESSION } from '@platform/contracts';
import { DEFAULT_AGENT_TMUX_SIZE } from '../../src/domain/services/tmux-command.policy';
import type {
  ProcessStream,
  RuntimeAdapter,
  RuntimeAdapterRegistry,
  RuntimeTaskSpec,
  SandboxCommand,
  SandboxExecFn,
  SandboxExecPort,
  SandboxPtyPort,
  OpenPtyOptions,
} from '@platform/contracts';
import { TerminalSessionService } from '../../src/application/terminal-session.service';
import {
  agentScript,
  attachSessionCmd,
  attachOrCreateCmd,
  hasSessionCmd,
  newSessionCmd,
  shellQuote,
} from '../../src/domain/services/tmux-command.policy';

/**
 * 03 §4.3 ⑤ + 26 §8: provision STARTS the agent session, the gateway only ATTACHES it.
 * These cover the tmux self-check (`IMAGE_CONTRACT_VIOLATION`, no silent degradation),
 * the start/attach command choice, and E2E-8-attachOnly's core assertion.
 */
class FakeAdapter implements RuntimeAdapter {
  readonly id = 'codex';
  readonly displayName = 'Codex';
  readonly vendor = 'OpenAI';
  readonly startCalls: RuntimeTaskSpec[] = [];
  attachCalls = 0;

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
  buildStartCommand(task: RuntimeTaskSpec): SandboxCommand {
    this.startCalls.push(task);
    return { cmd: ['codex', '-s', 'danger-full-access', task.prompt ?? ''], cwd: task.workdir };
  }
  buildAttachCommand(): SandboxCommand {
    this.attachCalls += 1;
    return { cmd: ['codex', '-s', 'danger-full-access'] };
  }
}

interface ExecRule {
  match: RegExp;
  exitCode: number;
  /** 让这条 exec **抛出**（传输层失败），而不是返回一个退出码。 */
  throws?: string;
}

function harness(rules: ExecRule[] = []) {
  const adapter = new FakeAdapter();
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
    const rule = rules.find((r) => r.match.test(joined));
    // `throws` 模拟**传输层**失败（沙箱内 agent 不可达），与「命令跑了但退出码非零」
    // 是两件不同的事 —— 前者说镜像没有 agent，后者说镜像缺某个命令。
    if (rule?.throws !== undefined) throw new Error(rule.throws);
    return { stdout: '', stderr: '', exitCode: rule?.exitCode ?? 0 };
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
    async openPty(_id, opts): Promise<ProcessStream> {
      ptyCalls.push(opts);
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
  const service = new TerminalSessionService(runtimes, sandboxes, pty);
  return { service, adapter, execCalls, ptyCalls, exec };
}

describe('bootstrapAgentSession — the tmux self-check (03 §4.3 ⑤.1)', () => {
  it('a missing tmux fails LOUDLY with IMAGE_CONTRACT_VIOLATION — never degrades', async () => {
    const h = harness([{ match: /command -v tmux/, exitCode: 127 }]);
    await expect(
      h.service.bootstrapAgentSession({
        sandboxId: 's1',
        runtimeId: 'codex',
        initialPrompt: 'do the thing',
        workdir: '/workspace',
        exec: h.exec,
      }),
    ).rejects.toBeInstanceOf(ImageContractViolationError);

    // it stops BEFORE building or starting anything: silently falling back to a
    // gateway-held pty is exactly the B 档 that was cancelled (04 §7 ★).
    expect(h.adapter.startCalls).toHaveLength(0);
    expect(h.execCalls.some((c) => c.includes('new-session'))).toBe(false);
  });

  /**
   * ⭐ **agent 可达性**（2026-08 新增）。平台的 exec / 终端 / 文件**全部**经过镜像自带的
   * agent HTTP API（`:8080` 的 `/v1/bash/exec`、`ws /v1/shell/ws`，04 §7）。
   * 一张不带 agent 的镜像 —— 也就是任何一张普通 docker 镜像 —— 在这里会让 `exec`
   * 抛传输层错误。
   *
   * ⚠️ 在此之前那个错误沿着 `failureOf` 落成 `INTERNAL`，用户看到「服务内部错误，
   * 请稍后重试」。**失败发生在正确的位置，却被叫了一个让用户走错方向的名字** ——
   * 与 `ENOSPC` 曾经被当成平台错误码是同一种病。
   *
   * MUTATION: 去掉 `assertImageContract` 里的 try/catch ⇒ 抛出的是裸 `Error` 而不是
   * `ImageContractViolationError`，本条红。
   */
  it('⭐ 沙箱内 agent 不可达 ⇒ IMAGE_CONTRACT_VIOLATION，不是 INTERNAL', async () => {
    const h = harness([
      // ⚠️ `exitCode` 是 `ExecRule` 的必填项：抛出的那一条**不会用到它**，但契约要求它在。
      //    ⛔ 给 0 会读成「成功」，给 -1 才明确是「这条根本没跑到退出码」。
      { match: /command -v tmux/, exitCode: -1, throws: 'connect ECONNREFUSED 127.0.0.1:8080' },
    ]);
    const err = await h.service
      .bootstrapAgentSession({
        sandboxId: 's1',
        runtimeId: 'codex',
        initialPrompt: 'do the thing',
        workdir: '/workspace',
        exec: h.exec,
      })
      .then(() => null)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ImageContractViolationError);
    // 说清是 agent 而不是 tmux —— 两种失败的下一步不同（换镜像 vs 装 tmux）。
    expect(String((err as Error).message)).toContain('agent');
    // 原始错误不丢：它进 message 供排障。
    expect(String((err as Error).message)).toContain('ECONNREFUSED');
    // 与 tmux 那条一样，停在自检，不去建会话。
    expect(h.adapter.startCalls).toHaveLength(0);
    expect(h.execCalls.some((c) => c.includes('new-session'))).toBe(false);
  });

  it('the check is a LIVE probe, not a trust of registration-time validate()', async () => {
    const h = harness();
    await h.service.bootstrapAgentSession({
      sandboxId: 's1',
      runtimeId: 'codex',
      workdir: '/workspace',
      exec: h.exec,
    });
    expect(h.execCalls[0]).toEqual(['sh', '-c', 'command -v tmux']);
  });
});

describe('bootstrapAgentSession — which command the session runs', () => {
  it('with an initialPrompt it uses buildStartCommand and reports it consumed', async () => {
    const h = harness([{ match: /has-session/, exitCode: 1 }]);
    const r = await h.service.bootstrapAgentSession({
      sandboxId: 's1',
      runtimeId: 'codex',
      initialPrompt: '把 README 翻译成英文',
      workdir: '/workspace',
      exec: h.exec,
    });
    expect(r).toEqual({ promptConsumed: true, reusedExisting: false });
    expect(h.adapter.startCalls[0]).toMatchObject({ headless: false, workdir: '/workspace' });

    const start = h.execCalls.find((c) => c.includes('new-session'))!;
    // ⚠️ **按「除最后那个脚本参数外全等」比**，不数下标。这串 argv 已经因为 `-u`、
    //    `set -g mouse on` 变过两次，每次都要回来改 `slice(0,N)` 与 `start[N]` ——
    //    那种算术是纯噪音，而且改错了会**静默地少比几项**。
    expect(start.slice(0, -1)).toEqual([
      'tmux',
      // ⚠️ `-u` 强制 UTF-8：镜像里 LC_CTYPE=POSIX，缺了它 tmux 把非 ASCII 逐个换成 `_`。
      '-u',
      // ⚠️ `mouse on`：否则备用屏里 xterm 把滚轮翻译成方向键（一格 = 17 个 `ESC[A`）
      //    直接灌进 agent —— codex 完全没反应，claude 却「碰巧能滚」。
      'set',
      '-g',
      'mouse',
      'on',
      ';',
      'new-session',
      '-d',
      // ★ `-x/-y` 不能省：detached 会话默认 **80x24**（实测），agent 一启动就按 80 列
      // 画横幅，而终端不会回流已输出的字节 ⇒ 之后 attach 撑到 247 列也救不回第一屏。
      '-x',
      String(DEFAULT_AGENT_TMUX_SIZE.cols),
      '-y',
      String(DEFAULT_AGENT_TMUX_SIZE.rows),
      '-s',
      PLATFORM_AGENT_TMUX_SESSION,
    ]);
    // the whole payload is ONE tmux argument (tmux joins several with spaces)
    expect(start.at(-1)).toContain('把 README 翻译成英文');
    expect(start.at(-1)).toContain('danger-full-access');
    // 默认值必须**明显大于** 80x24，否则这条改动等于没做。
    expect(DEFAULT_AGENT_TMUX_SIZE.cols).toBeGreaterThan(80);
    expect(DEFAULT_AGENT_TMUX_SIZE.rows).toBeGreaterThan(24);
  });

  it('without an initialPrompt it still starts a session, from buildAttachCommand', async () => {
    const h = harness([{ match: /has-session/, exitCode: 1 }]);
    const r = await h.service.bootstrapAgentSession({
      sandboxId: 's1',
      runtimeId: 'codex',
      workdir: '/workspace',
      exec: h.exec,
    });
    expect(r.promptConsumed).toBe(false);
    expect(h.adapter.attachCalls).toBe(1);
    expect(h.adapter.startCalls).toHaveLength(0);
  });

  it('an existing session is left alone — a re-run must not double-execute the task', async () => {
    const h = harness([{ match: /has-session/, exitCode: 0 }]);
    const r = await h.service.bootstrapAgentSession({
      sandboxId: 's1',
      runtimeId: 'codex',
      initialPrompt: 'do the thing',
      workdir: '/workspace',
      exec: h.exec,
    });
    expect(r).toEqual({ promptConsumed: false, reusedExisting: true });
    expect(h.execCalls.some((c) => c.includes('new-session'))).toBe(false);
  });
});

describe('E2E-8-attachOnly — the gateway always attaches, never starts the task', () => {
  it('attaches the existing platform session and NEVER calls buildStartCommand', async () => {
    const h = harness([{ match: /has-session/, exitCode: 0 }]);
    await h.service.openSession('s1', { cols: 80, rows: 24 });

    // ⚠️ attach 也前置 `set -g mouse on`：老会话靠这一次把它补上。
    expect(h.ptyCalls[0].cmd).toEqual([
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
    expect(h.adapter.startCalls).toHaveLength(0);
  });

  it('a vanished session gets a CLEAN one from buildAttachCommand — no prompt replay', async () => {
    const h = harness([{ match: /has-session/, exitCode: 1 }]);
    await h.service.openSession('s1', { cols: 80, rows: 24 });

    const cmd = h.ptyCalls[0].cmd!;
    // ⚠️ 同上：除最后那个脚本参数外全等，不数下标。
    expect(cmd.slice(0, -1)).toEqual([
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
      PLATFORM_AGENT_TMUX_SESSION,
    ]);
    expect(h.adapter.attachCalls).toBe(1);
    expect(h.adapter.startCalls).toHaveLength(0);
    expect(cmd.at(-1)).toContain('/workspace');
  });
});

describe('the tmux script is quoted safely and survives the agent', () => {
  it('single-quotes every argv element, including embedded quotes', () => {
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
    const script = agentScript({ cmd: ['codex', "don't stop"], cwd: '/work space' });
    expect(script).toContain(`cd '/work space'`);
    expect(script).toContain(`'don'\\''t stop'`);
  });

  it('drops into a shell after the agent exits instead of killing the session', () => {
    // otherwise a finished (or crashed) agent takes the tmux session with it and the
    // user's first terminal visit shows "session not found" rather than what happened.
    const script = agentScript({ cmd: ['codex'] });
    expect(script).toContain('__platform_rc=$?');
    expect(script).toContain('exec "${SHELL:-/bin/sh}"');
  });

  it('materialises env as K=V prefixes (documented as NON-secret, 04 §2.3★)', () => {
    expect(agentScript({ cmd: ['codex'], env: { FOO: 'bar' } })).toContain("FOO='bar' 'codex'");
  });
});

/**
 * ── 每一个 tmux 调用都要 `-u`（2026-09-07 镜像内实测）─────────────────────────
 *
 * 沙箱镜像里 `LC_CTYPE=POSIX`（两档 Dockerfile 都没设 locale），tmux 于是按非 UTF-8
 * 渲染，把它认为客户端表示不了的字符**逐个换成 `_`**。同一段输出、同一个 tmux 3.3a：
 *
 *   attach 无 -u :  BLOCK ___ STAR _ ELL _ MID (0~
 *   attach 加 -u :  BLOCK ▐▛█ STAR ✻ ELL … MID ·
 *
 * ⚠️ 真机上就是这个：Claude Code 的横幅 `▐▛███▜▌` 变成 `_______`、spinner `✻` 变成 `_`。
 * **一眼像字体坏了**，而字体是好的。
 *
 * ⛔ server 端（new-session）与 client 端（attach）**各管一半** —— 只加一处，
 *    另一处照样把字符吃掉。所以这里逐条枚举，而不是只测其中一条。
 */
describe('每一个 tmux 命令都必须强制 UTF-8', () => {
  it('⭐ 四个入口一个都不能漏', () => {
    // MUTATION: 任意一处去掉 `UTF8` ⇒ 本条红。
    const cmds = [
      hasSessionCmd('s'),
      attachSessionCmd('s'),
      newSessionCmd('s', { cmd: ['x'] }),
      attachOrCreateCmd('s', { cmd: ['x'] }),
    ];
    for (const cmd of cmds) {
      expect(cmd[0], `第一个词必须是 tmux：${cmd.join(' ')}`).toBe('tmux');
      expect(cmd[1], `⛔ 缺 -u：${cmd.join(' ')}`).toBe('-u');
    }
  });

  it('⭐ 建会话**与 attach** 都要前置 `set -g mouse on`', () => {
    // ⛔ 少了它，备用屏里 xterm 把滚轮翻译成方向键（实测一格 = `ESC[A` × 17）直接灌进
    //    agent：codex 完全没反应，claude 却「碰巧能滚」（它把 Up/Down 当滚动）。
    // ⚠️ **attach 那条不能省**：`mouse` 只在设的那一刻生效，只在建会话时设的话，
    //    **改动之前就已经起着的会话永远拿不到** —— 真机复现过（三个 running 沙箱
    //    全是 `mouse off`）。attach 前置一次，等于每次开终端都把它补上。
    // ⚠️ 必须**前置**：`attach` / `new-session -A` 是前台阻塞命令，写在它后面的 `set` 要等
    //    attach 退出才轮得到执行，等于没设。
    // MUTATION: 任一处去掉 `MOUSE_ON` ⇒ 本条红。
    for (const cmd of [
      newSessionCmd('s', { cmd: ['x'] }),
      attachOrCreateCmd('s', { cmd: ['x'] }),
      attachSessionCmd('s'),
    ]) {
      const i = cmd.indexOf('mouse');
      expect(i, `⛔ 缺 mouse 设置：${cmd.join(' ')}`).toBeGreaterThan(-1);
      expect(cmd.slice(i - 2, i + 3)).toEqual(['set', '-g', 'mouse', 'on', ';']);
      // ⛔ 必须在 new-session **之前** —— 之后的话 `-A` 那条要等 attach 退出。
      const action = cmd.findIndex((a) => a === 'new-session' || a === 'attach');
      expect(action, `找不到动作词：${cmd.join(' ')}`).toBeGreaterThan(-1);
      expect(i, `⛔ mouse 设置必须前置：${cmd.join(' ')}`).toBeLessThan(action);
    }
  });
});
