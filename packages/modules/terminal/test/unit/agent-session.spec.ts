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
import { agentScript, shellQuote } from '../../src/domain/services/tmux-command.policy';

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
    return { stdout: '', stderr: '', exitCode: rule?.exitCode ?? 0 };
  };
  const sandboxes: SandboxExecPort = {
    async execFor() {
      return exec;
    },
    async bindingOf(sandboxId) {
      return { sandboxId, runtimeId: 'codex', workdir: '/workspace' };
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
    expect(start.slice(0, 9)).toEqual([
      'tmux',
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
    expect(start).toHaveLength(10);
    expect(start[9]).toContain('把 README 翻译成英文');
    expect(start[9]).toContain('danger-full-access');
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

    expect(h.ptyCalls[0].cmd).toEqual(['tmux', 'attach', '-t', PLATFORM_AGENT_TMUX_SESSION]);
    expect(h.adapter.startCalls).toHaveLength(0);
  });

  it('a vanished session gets a CLEAN one from buildAttachCommand — no prompt replay', async () => {
    const h = harness([{ match: /has-session/, exitCode: 1 }]);
    await h.service.openSession('s1', { cols: 80, rows: 24 });

    const cmd = h.ptyCalls[0].cmd!;
    expect(cmd.slice(0, 5)).toEqual([
      'tmux',
      'new-session',
      '-A',
      '-s',
      PLATFORM_AGENT_TMUX_SESSION,
    ]);
    expect(h.adapter.attachCalls).toBe(1);
    expect(h.adapter.startCalls).toHaveLength(0);
    expect(cmd[5]).toContain('/workspace');
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
