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
  attachOrCreateRuntimeCmd,
  attachOrCreateShellCmd,
  attachSessionCmd,
  hasSessionCmd,
  killShellSessionCmd,
  listSessionsCmd,
  newSessionCmd,
  parseShellSessionList,
  shellSessionName,
  TMUX_PROBE_CMD,
} from '../domain/services/tmux-command.policy';
import type { ShellSessionSummary } from '../domain/services/tmux-command.policy';

const TMUX_CMD_TIMEOUT_MS = 30_000;

/**
 * 一条终端连接要连**哪一个** tmux 会话（06 §5）。
 *
 * 这是「多标签」这件事在后端的全部形状 —— 没有它，开第二条 WS 只能再 attach 一次
 * `platform-agent`，而 tmux 的 pane 属于 session 不属于 client（实测见
 * `attachOrCreateShellCmd` 的注释），于是第二个标签是第一个标签的镜像。
 *
 * ⛔ `agent` 那一支**不许**再长出分支（裁决 D-15）：它永远是 attach，永远不判断
 * 「是不是第一个连接」，也永远不因为断连而销毁。
 */
export type TerminalTarget =
  /**
   * 任务自己那个 `platform-agent` 会话（裁决 D-15）。
   *
   * ⚠️ **别把它与「一个 agent CLI 标签」混为一谈** —— 后者是 `kind:'runtime'`。
   * 这里的 `agent` 指的是**这个 Task 本身**：由 provision 在 `starting` 段起好、
   * 关不掉、不因断连而销毁。用户新开的 Codex/Claude 标签机制上属于 shell 那一类
   * （独立会话、自己的 shellId、可关），只是跑的命令不是 `$SHELL`。
   */
  | { kind: 'agent' }
  /** 用户自己开的纯终端。`shellId` 由网关铸；调用方不许自造。 */
  | { kind: 'shell'; shellId: string }
  /**
   * 用户自己开的 **agent CLI 标签**（06 §5.6）：独立会话里跑 `buildAttachCommand()`。
   * ⛔ 它**不是任务**：不带指令、不建 AgentTask。两者的分界见
   * `attachOrCreateRuntimeCmd` 的注释。
   */
  | { kind: 'runtime'; shellId: string; runtimeId: string };

/**
 * The terminal context's application facade — the ONE door in each direction
 * (23 §10.4).
 *
 *   provision → `bootstrapAgentSession()`   starts the platform's agent session
 *   gateway   → `openSession()`             attaches — `platform-agent` by default,
 *                                           or the caller's own `platform-shell-<id>`
 *                                           when the handshake asked for one (06 §5)
 *   gateway   → `closeShellSession()`       destroys ONE user shell, never the agent
 *   gateway   → `listShellSessions()`        what user shells this sandbox still holds
 *                                            (刷新后重建标签栏，06 §5.5；三态，见方法注释)
 *
 * ⚠️ **会话 id 本身不在这一层生成**：`randomBytes` 属 interface/infrastructure
 * （01 §3，eslint 有硬规则 —— 随机会让业务用例不可复现）。网关在铸
 * `socketSessionKey` 的同一行铸它，本层只负责把它变成一个 tmux 会话名
 * （`shellSessionName()`，形状不对就抛）。
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
    opts: { cols: number; rows: number; reuse?: string; target?: TerminalTarget },
  ): Promise<ProcessStream> {
    const { target = { kind: 'agent' }, ...ptyOpts } = opts;
    const cmd =
      target.kind === 'runtime'
        ? await this.runtimeCommandFor(sandboxId, target.shellId, target.runtimeId)
        : target.kind === 'shell'
          ? await this.shellCommandFor(sandboxId, target.shellId)
          : await this.attachCommandFor(sandboxId);
    return this.pty.openPty(sandboxId, { ...ptyOpts, cmd });
  }

  /**
   * 用户自己开的终端标签：`tmux new-session -A -s platform-shell-<id>`（06 §5）。
   *
   * ⚠️ **没有 `has-session` 探测这一步**，与 agent 那条路不同。agent 那边要探，是因为
   * 「会话不在」意味着出了意外，得记一条 warning 并且**明确不重放初始指令**；这边
   * 「不在就建」正是 `-A` 的语义，而且第一次打开必然不在 —— 探一次只是多一次 exec。
   *
   * ⚠️ 同样**不做镜像自检**（`command -v tmux`）：能走到网关的沙箱已经过了 provision
   * 那一关（03 §4.3 ⑤），在这里再探一次只会把一次常规操作变慢。
   */
  private async shellCommandFor(sandboxId: string, shellId: string): Promise<string[]> {
    const session = shellSessionName(shellId); // 形状不对就在这里抛，绝不进 argv
    let workdir: string | undefined;
    try {
      workdir = (await this.sandboxes.bindingOf(sandboxId)).workdir;
    } catch (e) {
      // 与 agent 那条路同一条取舍：沙箱可能整个没了，让 pty 层报真正的错，
      // 而不是被一次 binding 查询的失败盖住。少一个 `-c` 只是起点目录不同。
      this.logger.warn(`sandbox ${sandboxId}: binding unavailable (${(e as Error).message})`);
    }
    return attachOrCreateShellCmd(session, workdir);
  }

  /**
   * 用户自己开的 **agent CLI 标签**（06 §5.6）。
   *
   * ⛔ **要先确认这个沙箱里真的有那个 runtime** —— 判据是沙箱行上那条**落库的记录**
   * （`binding.availableRuntimes` = 默认 ∪ 实际注入的），⛔ 不是"注册表里有没有这个
   * id"，更不是"现在配没配凭证"。理由见 `SandboxDtoSchema.availableRuntimes`：
   * provision 之后凭证配置还会变，而盒子里有什么只有那条记录说得准。
   *
   * 前端的下拉本来就只列那几个（P21-1 §6），所以走到这里的不合法请求只有两种来源：
   * 客户端 bug，或者有人手搓了一条握手。两种都该响亮地拒。
   */
  private async runtimeCommandFor(
    sandboxId: string,
    shellId: string,
    runtimeId: string,
  ): Promise<string[]> {
    const session = shellSessionName(shellId); // 形状不对就在这里抛，绝不进 argv
    const binding = await this.sandboxes.bindingOf(sandboxId);
    if (!binding.availableRuntimes.includes(runtimeId)) {
      throw new Error(
        `sandbox ${sandboxId} 里没有可用的 '${runtimeId}' —— ` +
          `它能跑的是：${binding.availableRuntimes.join('、')}`,
      );
    }
    // ⛔ `buildAttachCommand()`，不是 `buildStartCommand()` —— 标签不是任务。
    const attach = this.runtimes.get(runtimeId).buildAttachCommand();
    return attachOrCreateRuntimeCmd(session, runtimeId, {
      ...attach,
      cwd: attach.cwd ?? binding.workdir,
    });
  }

  /**
   * 销毁**一个用户终端标签**的 tmux 会话（06 §5）。
   *
   * ⛔ **只由用户的显式「关标签」触发**，绝不由 WS 断开触发 —— 断开一律只是 detach
   * （06 §6.2）。这条纪律对用户 shell 与对 agent 会话同样成立：那个标签里可能正跑着
   * 一个长构建，刷新一下页面就把它打断是不可接受的。
   *
   * ⛔ **它构造不出 `platform-agent`**：名字由 `shellSessionName()` 现拼，而
   * `platform-agent` 不是 32 位十六进制。「agent 会话绝不被销毁」因此不依赖任何一处
   * 记得要写的 `if`。
   *
   * 失败只记 warning：会话可能已经不在（沙箱内被 kill、沙箱正在回收）——那与目标状态
   * 一致，没有理由把一次「关标签」变成用户要处理的错误。
   */
  async closeShellSession(sandboxId: string, shellId: string): Promise<void> {
    const cmd = killShellSessionCmd(shellId); // 形状不对就在这里抛
    const exec = await this.sandboxes.execFor(sandboxId);
    const r = await exec(cmd, { timeoutMs: TMUX_CMD_TIMEOUT_MS });
    if (r.exitCode !== 0) {
      this.logger.warn(
        `sandbox ${sandboxId}: kill-session '${shellSessionName(shellId)}' exited ${String(
          r.exitCode,
        )} (会话可能已经不在，与目标状态一致)`,
      );
    }
  }

  /**
   * 这个 sandbox 里**已经存在**的用户终端会话（06 §5.5），按创建时间升序。
   *
   * 它修的是什么：tmux 会话活在沙箱里、活过刷新，而"有哪几个标签"此前只活在浏览器
   * 内存里（`shellId` 是会话凭据，按 15 §3.5 不许 persist）。⇒ 刷一下页面，那些会话
   * 就变成**还活着但界面上没有**的孤儿，只能等整个沙箱被回收。而"看不见但还活着比
   * 关掉更糟"正是 §5.4 决定「关标签要销毁」时的立论 —— 不能一边拿它当理由，一边在
   * 刷新这条路上走到同一个坏状态。
   *
   * ⚠️ **返回 `null` 表示「问不出来」，与 `[]`「确认没有」是两件事**（三态，06 §5.5）。
   * ⛔ 这里绝不许把失败折叠成空数组：那会让前端把「查不到」渲染成「你没有开过终端」，
   *   而用户下一步的动作完全不同（重试/看日志 vs 直接新开一个）。
   */
  async listShellSessions(sandboxId: string): Promise<ShellSessionSummary[] | null> {
    let exec: SandboxExecFn;
    try {
      exec = await this.sandboxes.execFor(sandboxId);
    } catch (e) {
      this.logger.warn(
        `sandbox ${sandboxId}: 列终端会话失败（exec 不可达）：${(e as Error).message}`,
      );
      return null;
    }
    let r: Awaited<ReturnType<SandboxExecFn>>;
    try {
      r = await exec(listSessionsCmd(), { timeoutMs: TMUX_CMD_TIMEOUT_MS });
    } catch (e) {
      this.logger.warn(`sandbox ${sandboxId}: 列终端会话失败：${(e as Error).message}`);
      return null;
    }
    if (r.exitCode !== 0) {
      // `no server running on …` 这类走这里：tmux server 都不在，答不上来。
      // ⚠️ 它**不是**「没有用户终端」—— 那种情况下 agent 会话也不该在，属于异常。
      this.logger.warn(
        `sandbox ${sandboxId}: 列终端会话失败（tmux 退出码 ${String(r.exitCode)}）：` +
          `${r.stderr.trim() || r.stdout.trim()}`,
      );
      return null;
    }
    return parseShellSessionList(r.stdout);
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
