/**
 * Pure tmux command construction (23 §10.2 style: the shell-shaped logic is split out
 * so it can be exhaustively unit-tested without a sandbox).
 *
 * Structural, contracts-free input type — the domain may not import `@platform/contracts`
 * (23 §4.5). It is structurally identical to `SandboxCommand`.
 */
export interface AgentCommand {
  cmd: string[];
  env?: Record<string, string>;
  cwd?: string;
}

/** POSIX single-quote a shell word so it survives verbatim. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** `command -v tmux` — the runtime probe that decides whether the image is honest. */
export const TMUX_PROBE_CMD = ['sh', '-c', 'command -v tmux'];

/** Ask whether the platform's agent session already exists inside the sandbox. */
export function hasSessionCmd(session: string): string[] {
  return ['tmux', 'has-session', '-t', session];
}

/** What a terminal client runs to join the already-running agent session. */
export function attachSessionCmd(session: string): string[] {
  return ['tmux', 'attach', '-t', session];
}

/**
 * Start the platform-owned session DETACHED. The session is then held by the
 * sandbox's own tmux server and the platform keeps no connection to it — which is why
 * restarting the backend cannot interrupt a running agent (04 §7 ★, the reason tmux
 * became a MUST).
 *
 * The whole payload is passed as ONE tmux argument: tmux joins multiple trailing
 * arguments with spaces, so handing it a pre-quoted script is the only way an argv
 * containing spaces survives intact.
 */
/**
 * ★ Detached tmux 会话的默认尺寸是 **80x24**（实测：容器内 `tmux new-session -d`
 * 之后 `list-sessions` 报 `80x24`）。而 agent 会话在 **provision 阶段**就创建
 * （03 §4.3：起容器时 agent 就跑起来，所以打开终端时可能已经有一屏输出）——那一刻
 * **还没有任何客户端连上来**，真实尺寸无从得知。
 *
 * 后果不是"小一点"：agent CLI 一启动就按 80 列画欢迎横幅/边框，而终端协议里没有
 * "回流"——之后客户端 attach、tmux 把窗口撑到 247x140，**已经吐出的字节不会重排**。
 * 屏幕上就是一个 80 列的窄框浮在一大片空白里。
 *
 * 所以这里给一个**宽松的默认值**：让第一屏在常见屏幕上就是宽的。
 *
 * ⚠️ **它不能彻底消除错位**，因为真实尺寸只有 attach 那一刻才知道：客户端比这个默认
 * 高时，旧内容仍会被留在底部（tmux 把窗口撑高、历史往上填）。要彻底解决只能把客户端
 * 尺寸随创建请求传下来——那要动 `CreateSandboxRequest` 契约，且**创建任务时浏览器里
 * 还没有终端**，量不出 cols/rows（xterm 的格子尺寸要有实例才知道）。本轮的取舍：
 * 用默认值把**宽度**这一半修好（视觉损伤的大头），纵向错位记为已知限制。
 */
export const DEFAULT_AGENT_TMUX_SIZE = { cols: 200, rows: 50 } as const;

export function newSessionCmd(
  session: string,
  command: AgentCommand,
  size: { cols: number; rows: number } = DEFAULT_AGENT_TMUX_SIZE,
): string[] {
  return [
    'tmux',
    'new-session',
    '-d',
    '-x',
    String(size.cols),
    '-y',
    String(size.rows),
    '-s',
    session,
    agentScript(command),
  ];
}

/**
 * `-A` = attach if it exists, otherwise create. Used ONLY on the gateway's fallback
 * path, when the session unexpectedly vanished (killed from inside the sandbox, name
 * removed) — the client still gets a working terminal and the platform logs a warning
 * (26 §8). It never carries the initial instruction: replaying it would re-run a
 * destructive task (I-SBX-10).
 */
export function attachOrCreateCmd(session: string, command: AgentCommand): string[] {
  return ['tmux', 'new-session', '-A', '-s', session, agentScript(command)];
}

/**
 * Wrap the adapter's command in a small script:
 *   - `cd` into the workspace so the agent starts where the code is;
 *   - materialise `env` as `K=V` prefixes (NEVER secrets — argv/env are readable via
 *     `ps` inside the sandbox, 04 §2.3★ 第 2 条; credentials go through
 *     `injectCredential` or the sandbox-creation env);
 *   - when the agent exits, DROP INTO A SHELL instead of letting the tmux session die.
 *     Otherwise a finished or crashed agent takes the session with it and the user's
 *     first terminal visit shows "session not found" rather than what happened.
 */
export function agentScript(command: AgentCommand): string {
  const parts: string[] = [];
  if (command.cwd) parts.push(`cd ${shellQuote(command.cwd)} 2>/dev/null || true`);
  const assignments = Object.entries(command.env ?? {}).map(([k, v]) => `${k}=${shellQuote(v)}`);
  parts.push([...assignments, ...command.cmd.map(shellQuote)].join(' '));
  parts.push('__platform_rc=$?');
  parts.push(
    "printf '\\n[platform] agent session ended (exit %s); you now have a shell\\n' " +
      '"$__platform_rc"',
  );
  parts.push('exec "${SHELL:-/bin/sh}"');
  return parts.join('; ');
}
