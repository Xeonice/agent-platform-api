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
  return ['tmux', UTF8, 'has-session', '-t', session];
}

/** What a terminal client runs to join the already-running agent session. */
export function attachSessionCmd(session: string): string[] {
  return ['tmux', UTF8, ...MOUSE_ON, 'attach', '-t', session];
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

/**
 * **强制 UTF-8** —— 少了它，agent 界面里所有非 ASCII 字符都会变成 `_`。
 *
 * ── 它修的是什么（2026-09-07 真机 + 镜像内实测）──────────────────────────────
 * tmux 按**客户端的 locale** 决定要不要按 UTF-8 渲染，而我们的沙箱镜像里
 * `LC_CTYPE=POSIX`（两档 Dockerfile 都没设 locale）。于是 tmux 把它认为客户端表示不了的
 * 字符**逐个替换成 `_`**。镜像内对照实测（同一段输出、同一个 tmux 3.3a）：
 *
 *   attach 无 -u :  BLOCK ___ STAR _ ELL _ MID (0~     ← 3 字节字符全成 `_`
 *   attach 加 -u :  BLOCK ▐▛█ STAR ✻ ELL … MID ·        ← 正确
 *
 * ⚠️ 用户看到的就是这个：Claude Code 的横幅 `▐▛███▜▌` 变成 `_______`、
 * spinner `✻` 变成 `_`、`⏵⏵ bypass permissions` 变成 `__`。**一眼像字体坏了**，
 * 而字体是好的 —— 同一套字体栈在浏览器里渲染这些字符完全正常（已单独验证）。
 *
 * ⛔ **不靠「在镜像里设 LANG」来解决**：那只覆盖我们自己那两档镜像，而用户可以注册
 * 自己的镜像（04 §7 血统只保证有 tmux，不保证有 locale）。`-u` 与镜像无关，
 * 是**这一侧**能给出的保证。⇒ 镜像里补 locale 是另一件事（它还能顺带修 ls/grep）。
 *
 * ⚠️ **每一个 tmux 调用都要带**：server 端（new-session）决定怎么存，client 端
 * （attach）决定怎么渲染 —— 只加一半，另一半照样把字符吃掉。
 */
const UTF8 = '-u';

/**
 * **让 tmux 自己接管滚轮** —— 少了它，滚轮在 agent 界面里要么没反应、要么乱按方向键。
 *
 * ── 它修的是什么（2026-09-08 真机 + 逐层实测）────────────────────────────────
 * 症状：codex 里滚轮完全滚不动，claude code 却可以。**两个 CLI 的差别只是巧合**，
 * 真正的原因在这一层：
 *
 *   ① `tmux attach` 会把客户端（xterm.js）切进**备用屏**（实测抓到 `ESC[?1049h`）；
 *   ② 备用屏里没有回滚缓冲，于是 xterm.js 把滚轮**翻译成方向键**
 *      （实测：一格滚轮 = `ESC[A` × 17 / `ESC[B` × 17）；
 *   ③ 那串方向键原样送进 pane 里的 agent —— claude code 把 Up/Down 当作滚动自己的
 *      记录，看起来「能滚」；codex 的 TUI 不这么映射，于是「完全没反应」。
 *
 * ⚠️ 所以今天的行为不只是「滚不动」：**每一次滚轮都在往 agent 里灌 17 个方向键**，
 * 在别的 TUI 上足以移动选中项或翻历史 —— 那比没反应更糟。
 *
 * ⇒ `mouse on` 之后 tmux 会向客户端开启鼠标上报，xterm.js 改为转发鼠标事件而不再造
 * 方向键；tmux 3.3a 的默认绑定是
 *
 *     WheelUpPane  if-shell "#{||:#{pane_in_mode},#{mouse_any_flag}}" {send-keys -M} {copy-mode -e}
 *
 * 判据是「pane 已在某个 mode **或** 应用自己要了鼠标」，**与备用屏无关**：
 *   · 应用没要鼠标 ⇒ `copy-mode -e`，滚的是 tmux 自己的回滚缓冲 —— 两个 CLI 都管用；
 *   · 应用要了鼠标 ⇒ 转发给它，由它自己处理滚轮 —— 也是对的。
 *
 * ⚠️ **代价说清楚**：开了鼠标之后，拖拽选择会进 tmux 而不是浏览器原生选区。
 * xterm.js 的标准出路是**按住 Shift 拖拽**回到原生选择/复制。
 *
 * ⛔ **设在平台侧而不是镜像里**：与 `-u` 同一条理由 —— 用户可以注册自己的镜像，
 * 那边不会有我们的 `~/.tmux.conf`。这一侧是唯一能给出保证的地方。
 * ⚠️ 顺带：tmux 3.3a **没有** `alternate-scroll` 这个选项（实测 `invalid option`），
 * 别照着老文章去设它。
 *
 * ⚠️ 放在 **每个命令之前**，而不只是建会话那次。`mouse` 是服务端全局项、且**只在设的
 * 那一刻生效**：只在 `new-session` 上设，**修复前就已经起着的会话永远拿不到**
 * —— 真机复现过（三个 running 沙箱全是 `mouse off`，用户滚轮照旧变方向键）。
 * ⇒ `attach` 之前也设一次，于是**每次打开终端都会把它补上**，老会话跟着受益。
 *
 * ⚠️ 顺序很关键：写在 `attach` / `new-session -A`（都是前台阻塞）**之后**的话，
 * 要等它们退出才轮得到执行 —— 等于没设。所以一律前置。
 *
 * ⛔ `has-session` 那条**不加**：它的退出码是载荷（1 = 会话不在，调用方据此走新建那条
 * 路）。虽然实测链式之后退出码仍然是 `has-session` 的，但那是一个不必冒的险 ——
 * attach 那条已经覆盖了「老会话补设」这件事。
 */
const MOUSE_ON = ['set', '-g', 'mouse', 'on', ';'];

export function newSessionCmd(
  session: string,
  command: AgentCommand,
  size: { cols: number; rows: number } = DEFAULT_AGENT_TMUX_SIZE,
): string[] {
  return [
    'tmux',
    UTF8,
    ...MOUSE_ON,
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
  return ['tmux', UTF8, ...MOUSE_ON, 'new-session', '-A', '-s', session, agentScript(command)];
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
