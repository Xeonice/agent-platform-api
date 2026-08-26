import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  ImageContractViolationError,
  PLATFORM_AGENT_TMUX_SESSION,
  RUNTIME_ADAPTER_REGISTRY,
  SANDBOX_EXEC_PORT,
  SANDBOX_PTY_PORT,
} from '@platform/contracts';
import type {
  AgentSessionBootstrap,
  BootstrapAgentSessionInput,
  BootstrapAgentSessionResult,
  ProcessStream,
  RuntimeAdapterRegistry,
  SandboxCommand,
  SandboxExecFn,
  SandboxExecPort,
  SandboxPtyPort,
} from '@platform/contracts';
import {
  attachOrCreateCmd,
  attachSessionCmd,
  hasSessionCmd,
  newSessionCmd,
  TMUX_PROBE_CMD,
} from '../domain/services/tmux-command.policy';

const TMUX_CMD_TIMEOUT_MS = 30_000;

/**
 * The terminal context's application facade — the ONE door in each direction
 * (23 §10.4).
 *
 *   provision → `bootstrapAgentSession()`   starts the platform's agent session
 *   gateway   → `openSession()`             ALWAYS attaches that session
 *
 * The split is the whole point of 裁决 D-15: "the agent starts working when the task
 * starts" used to be bound to the FIRST terminal connection, which meant closing the
 * browser (or creating a task over MCP, which has no terminal at all) silently
 * skipped the instruction forever. Now provision owns starting, and the gateway is
 * reduced to attaching — it no longer decides "is this the first session?" and never
 * calls `buildStartCommand`.
 */
@Injectable()
export class TerminalSessionService implements AgentSessionBootstrap {
  private readonly logger = new Logger('TerminalSessionService');

  constructor(
    @Inject(RUNTIME_ADAPTER_REGISTRY) private readonly runtimes: RuntimeAdapterRegistry,
    @Inject(SANDBOX_EXEC_PORT) private readonly sandboxes: SandboxExecPort,
    @Inject(SANDBOX_PTY_PORT) private readonly pty: SandboxPtyPort,
  ) {}

  /**
   * Step ⑤ of the `starting` 段 (03 §4.3 ⑤). Self-check tmux, then start ONE detached
   * session held by the sandbox's own tmux server. Carries `initialPrompt` through
   * `buildStartCommand` when there is one, otherwise starts the plain attach command
   * so the user still finds a live agent CLI waiting.
   */
  async bootstrapAgentSession(
    input: BootstrapAgentSessionInput,
  ): Promise<BootstrapAgentSessionResult> {
    await this.assertImageContract(input.exec);

    if (await this.sessionExists(input.exec)) {
      // Re-entrant provision (a retry after a later step failed): the agent is already
      // running, so starting a second one would double-execute the instruction.
      this.logger.log(
        `sandbox ${input.sandboxId}: agent session '${PLATFORM_AGENT_TMUX_SESSION}' already exists`,
      );
      return { promptConsumed: false, reusedExisting: true };
    }

    const adapter = this.runtimes.get(input.runtimeId);
    const prompt = input.initialPrompt?.trim();
    const carriesPrompt = prompt !== undefined && prompt !== '';
    const command: SandboxCommand = carriesPrompt
      ? adapter.buildStartCommand({
          prompt: input.initialPrompt,
          headless: false,
          workdir: input.workdir,
        })
      : adapter.buildAttachCommand();

    const r = await input.exec(
      newSessionCmd(PLATFORM_AGENT_TMUX_SESSION, { ...command, cwd: command.cwd ?? input.workdir }),
      { timeoutMs: TMUX_CMD_TIMEOUT_MS },
    );
    if (r.exitCode !== 0) {
      throw new Error(
        `failed to start the agent tmux session (exit ${r.exitCode}): ${r.stdout.trim()}`,
      );
    }
    return { promptConsumed: carriesPrompt, reusedExisting: false };
  }

  /**
   * Open a terminal onto the sandbox — ALWAYS by attaching the existing agent session
   * (26 §8). If it is unexpectedly gone (killed from inside the sandbox, name removed)
   * a clean one is started from `buildAttachCommand()` and a warning is logged; the
   * initial instruction is NEVER replayed on this path (I-SBX-10).
   */
  async openSession(
    sandboxId: string,
    opts: { cols: number; rows: number; reuse?: string },
  ): Promise<ProcessStream> {
    const cmd = await this.attachCommandFor(sandboxId);
    return this.pty.openPty(sandboxId, { ...opts, cmd });
  }

  private async attachCommandFor(sandboxId: string): Promise<string[]> {
    let exec: SandboxExecFn;
    try {
      exec = await this.sandboxes.execFor(sandboxId);
    } catch (e) {
      // The instance may be gone entirely; let the pty layer produce the real error
      // rather than masking it with a tmux probe failure.
      this.logger.warn(`sandbox ${sandboxId}: exec unavailable (${(e as Error).message})`);
      return attachSessionCmd(PLATFORM_AGENT_TMUX_SESSION);
    }
    if (await this.sessionExists(exec)) return attachSessionCmd(PLATFORM_AGENT_TMUX_SESSION);

    const binding = await this.sandboxes.bindingOf(sandboxId);
    this.logger.warn(
      `sandbox ${sandboxId}: agent session '${PLATFORM_AGENT_TMUX_SESSION}' is missing; ` +
        'starting a clean one (the initial instruction is NOT replayed)',
    );
    const attach = this.runtimes.get(binding.runtimeId).buildAttachCommand();
    return attachOrCreateCmd(PLATFORM_AGENT_TMUX_SESSION, {
      ...attach,
      cwd: attach.cwd ?? binding.workdir,
    });
  }

  /**
   * The image contract self-check (03 §4.3 ⑤.1) —— **两件事，一次探测**：
   *   ① 沙箱内 agent 可达吗（`exec` 本身就走它，抛出即不可达）
   *   ② tmux 在吗（探测的退出码）
   *
   * A registration-time `validate()` pass does not excuse either: images change tags and
   * base images upstream, and 血统校验（04 §7 ★）只能证明**祖先**有这些东西，证明不了
   * 派生镜像没把它们删掉。The only truth about a RUNNING sandbox is a live probe
   * (04 §2.1★ methodology).
   *
   * Missing tmux fails LOUDLY — it is never degraded into "same product, different
   * behaviour". Silent degradation would disguise a non-conforming image, and the user
   * would only discover it when a platform restart killed their running agent.
   */
  private async assertImageContract(exec: SandboxExecFn): Promise<void> {
    let r: Awaited<ReturnType<SandboxExecFn>>;
    try {
      r = await exec(TMUX_PROBE_CMD, { timeoutMs: TMUX_CMD_TIMEOUT_MS });
    } catch (e) {
      // ⭐ **agent 可达性**（2026-08 新增）。`exec` 本身就要经过沙箱内 agent
      //（`:8080` 的 `/v1/bash/exec`，04 §2.1），所以这一次探测**同时**是 agent 的探针 ——
      // 不需要再发一个请求，需要的是把这次失败**叫对名字**。
      //
      // ⚠️ 在此之前，一张不带 agent 的镜像会让这里抛一个传输层错误
      //（connection refused / 超时），沿着 `failureOf` 落成 `INTERNAL`,
      // 用户看到「服务内部错误，请稍后重试」——而真相是**这张镜像根本不满足平台约定**，
      // 重试一万次也不会变。这与 `ENOSPC` 那次是同一种病：**失败发生在正确的位置，
      // 却被叫了一个让用户走错方向的名字**。
      throw new ImageContractViolationError(
        '沙箱内 agent 不可达，镜像不满足平台约定（04 §7）：平台的 exec / 终端 / 文件全部经过' +
          `镜像自带的 agent HTTP API（:8080 的 /v1/bash/exec、ws /v1/shell/ws）。` +
          `原始错误：${e instanceof Error ? e.message : String(e)}`,
      );
    }
    if (r.exitCode !== 0) {
      throw new ImageContractViolationError(
        '镜像缺少 tmux，不满足平台约定（04 §7）：agent 会话必须由沙箱内的 tmux server 持有',
      );
    }
  }

  private async sessionExists(exec: SandboxExecFn): Promise<boolean> {
    const r = await exec(hasSessionCmd(PLATFORM_AGENT_TMUX_SESSION), {
      timeoutMs: TMUX_CMD_TIMEOUT_MS,
    });
    return r.exitCode === 0;
  }
}
