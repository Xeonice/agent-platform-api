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
  return ['tmux', UTF8, ...MOUSE_ON, ...STATUS_OFF, 'attach', '-t', session];
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

/**
 * 关掉 tmux 自带的状态栏（绿色那条）。
 *
 * ── 为什么要关 ────────────────────────────────────────────────────────────────
 * ① **它的窗口列表永远只有一项**：这个产品里一个标签 = 一个**独立 session**
 *    （`platform-agent` / `platform-shell-<id>`），不是同一个 session 里的多个 window。
 *    所以状态栏的导航功能在这里恒为空转。
 * ② **它在泄漏内部标识符**：`platform-0` / `platform-shell-<32 位十六进制>` 是实现细节，
 *    产品术语表明确要把这类名字挡在用户视野之外。
 * ③ **它想说的话已经有人说了，而且说得更好**：「我在哪个任务、哪个会话」由标签栏
 *    （`Agent / Codex 1 / 终端 2`）和终端工具栏的面包屑（`项目 / Agent · 任务名`）表达 ——
 *    那是产品自己的 UI 语言，而这条是 tmux 的原生 UI，风格与周边完全不搭。
 *
 * ⚠️ **与 `MOUSE_ON` 同一条纪律**：`status` 也是 session 级选项，`-g` 只改默认值，
 * **已经在跑的老会话不会被追溯修改** —— 所以每次 `attach` 之前都要补设一次，
 * 老会话才跟着受益。同理必须**前置**（写在前台阻塞命令之后等于没设）。
 *
 * ⛔ `has-session` / `kill-session` / `list-sessions` 那几条**不加**：理由与 `MOUSE_ON`
 * 那条完全一样 —— 它们不 attach、没有客户端可言，而 `has-session` 与 `list-sessions`
 * 的**退出码是载荷**（调用方据此判断"会话在不在"和"问不问得出来"），不该冒险链东西进去。
 */
const STATUS_OFF = ['set', '-g', 'status', 'off', ';'];

export function newSessionCmd(
  session: string,
  command: AgentCommand,
  size: { cols: number; rows: number } = DEFAULT_AGENT_TMUX_SIZE,
): string[] {
  return [
    'tmux',
    UTF8,
    ...MOUSE_ON,
    ...STATUS_OFF,
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
  return [
    'tmux',
    UTF8,
    ...MOUSE_ON,
    ...STATUS_OFF,
    'new-session',
    '-A',
    '-s',
    session,
    agentScript(command),
  ];
}

/**
 * 用户自己开的那个终端标签（06 §5「第 N 个标签」）。
 *
 * ── 为什么必须是**另一个 session**，而不是再 attach 一次 ────────────────────────
 * tmux 的 pane 属于 **session**，不属于 client。2026-09-11 实测（tmux 3.7b，两个
 * `script` 造的 pty 同时 attach 一个 session）：
 *
 *     list-clients → tty=/dev/ttys001 session=S ; tty=/dev/ttys004 session=S
 *     list-panes -a → S:0.0 id=%0                  ← **只有一个 pane**
 *
 * 也就是说"再开一条 WS 连上 `platform-agent`"拿到的是**同一块屏幕的镜像**，
 * 敲进去的字会落进正在跑的 agent。第二个终端只能是第二个 session。
 * 同一次实测里换个名字 `new-session -A -s platform-shell-…` 就得到了独立的 `%1`。
 *
 * ── 为什么**不复用** `agentScript()` ─────────────────────────────────────────
 * `agentScript` 在命令退出后会打一行「agent session ended」再 `exec $SHELL` —— 那条对
 * agent 会话是对的（跑完的 agent 不该把会话一起带走，用户来看结果时要有个 shell）。
 * 放到用户 shell 上它就变成了**永远退不掉的会话**：用户敲 `exit`，脚本再给他起一个。
 * 这里干脆不给命令，让 tmux 起镜像自己的默认 shell —— `exit` 就是 exit。
 *
 * ⚠️ `-u` 与前置 `set -g mouse on` 一个都不能少，而且是从**同两个常量**取的：
 * 少了 `-u`，这个新标签里所有非 ASCII 字符会变成 `_`；少了 `mouse on`，滚轮会被
 * xterm.js 翻译成一串方向键灌进标签里跑着的程序（两条的实测记录见上面各自的注释）。
 * ⇒ 想加新入口时照抄这一行的形状，别自己拼 `['tmux', ...]`。
 */
export function attachOrCreateShellCmd(session: string, workdir?: string): string[] {
  return [
    'tmux',
    UTF8,
    ...MOUSE_ON,
    ...STATUS_OFF,
    'new-session',
    '-A',
    '-s',
    session,
    ...(workdir === undefined ? [] : ['-c', workdir]),
  ];
}

/**
 * 会话上记「这个标签里跑的是哪个 runtime」的 tmux **用户选项**名（06 §5.6）。
 *
 * ⚠️ 它的全部用途是**刷新之后还能把标签名叫对**：清单里只有 shellId，没有这个标记的话
 * 一个正跑着 Claude Code 的标签在刷新后会显示成「终端 2」。
 *
 * ⚠️ **由会话自己在里面设**（见 `runtimeTabScript`），不是外面设的 —— `new-session -A`
 * 是前台阻塞命令，链在它后面的命令要等它退出才轮得到执行（与 `MOUSE_ON` 必须前置是
 * 同一条理由）。
 *
 * ⚠️ **读不到不是错误**：实测 tmux 3.7b 的 `-F '#{@platform_runtime}'` 对未设的会话给
 * **空串**（不报错）。沙箱里是 3.3a —— 万一那一版不支持 `#{@…}`，退化成"读不到" ⇒
 * 标签回落成「终端 N」，也就是本切片之前的行为，不会更坏。⛔ 所以解析侧永远不许因为
 * 这一列缺失/为空而丢掉整条会话。
 */
export const TMUX_RUNTIME_OPTION = '@platform_runtime';

/** 用户终端标签的 tmux 会话名前缀。`platform-agent` 与它**不同前缀**，见下。 */
export const PLATFORM_SHELL_SESSION_PREFIX = 'platform-shell-';

/**
 * 用户自己开的 **runtime 标签**（06 §5.6）：一个独立 tmux 会话里跑一个 agent CLI，
 * 不带任何任务指令。
 *
 * ⚠️ **命令来自 `buildAttachCommand()`**，⛔ 不是 `buildStartCommand()`。契约里那条
 * 注释写得很清楚：`buildAttachCommand` 是「没有指令要带时」终端会话跑的东西。
 * 用 `buildStartCommand` 意味着这个标签会变成一个**没人记账的任务**：它带着指令跑，
 * 而平台不会为它建 AgentTask，于是产物、审计、超时、可取消全都没有。
 * ⇒ 「在终端里开一个 CLI」与「发起一个任务」是两件事，这一行就是它们的分界。
 *
 * ⚠️ **这里复用 `agentScript()`，与纯 shell 标签相反** —— 两边的理由恰好互补：
 *   · 纯 shell 标签的命令**就是** shell，`agentScript` 退出后再 `exec $SHELL` 会让它
 *     永远退不掉（用户敲 `exit` 又给他起一个）；
 *   · runtime 标签的命令是 CLI，用户敲 `/exit` 退出 CLI 之后 `agentScript` 给他留下
 *     一个普通 shell —— 这正是想要的：标签不会在他眼前突然消失（还没看完的输出也就
 *     还在），而那个 shell 里再敲一次 `exit` 会真的结束会话。与 agent 会话「跑完的
 *     agent 不该把会话一起带走」是同一条取舍。
 */
export function attachOrCreateRuntimeCmd(
  session: string,
  runtimeId: string,
  command: AgentCommand,
): string[] {
  return [
    'tmux',
    UTF8,
    ...MOUSE_ON,
    ...STATUS_OFF,
    'new-session',
    '-A',
    '-s',
    session,
    runtimeTabScript(runtimeId, command),
  ];
}

/**
 * runtime 标签的负载：先给**自己这个会话**打上 runtime 标记，再跑 CLI。
 *
 * ⚠️ 标记必须在会话**里面**打（`set-option` 不带 `-t`，作用于当前会话）——外面链不上，
 * 见 `TMUX_RUNTIME_OPTION` 的注释。
 * ⚠️ `|| true`：老 tmux 不认 `@`-用户选项也只是少一个标签名，⛔ 绝不能让整个标签起不来。
 */
export function runtimeTabScript(runtimeId: string, command: AgentCommand): string {
  const mark = `tmux set-option ${TMUX_RUNTIME_OPTION} ${shellQuote(runtimeId)} 2>/dev/null || true`;
  return `${mark}; ${agentScript(command)}`;
}

/** 清单里的一条：会话 id + 里面跑的 runtime（纯终端标签没有后者）。 */
export interface ShellSessionSummary {
  shellId: string;
  runtimeId?: string;
}

/**
 * 用户终端标签 id 的形状：32 位小写十六进制（128-bit）。
 *
 * ⚠️ 与 `@platform/contracts` 的 `TERMINAL_SHELL_ID_RE` 是**同一条**正则的两份拷贝 ——
 * 领域层不许 import contracts（23 §4.5），所以只能各留一份，由
 * `test/unit/shell-session.spec.ts` 逐字钉住。
 */
export const SHELL_SESSION_ID_RE = /^[0-9a-f]{32}$/;

/**
 * id → tmux 会话名。**形状不对就抛**，不做兜底。
 *
 * ⛔ 这里是「客户端不许指定 session 名」这条纪律**在 argv 侧**的最后一道闸门：
 * 名字最终原样进 `tmux -s <name>`，所以这一步之后必须已经不可能有引号/空格/分号。
 * 抛而不是回一个安全默认值，是因为"形状不对"只有两种来源 —— 客户端 bug 或探测，
 * 两种都要在这里停住，而不是换个名字继续跑。
 *
 * ⛔ 它同时使 `platform-agent` **拼不出来**：那不是 32 位十六进制。
 * 「agent 会话绝不被销毁」于是不再依赖任何一处 `if (name !== 'platform-agent')`
 * 的记性 —— 走这条路根本构造不出那个名字。
 */
export function shellSessionName(shellId: string): string {
  if (!SHELL_SESSION_ID_RE.test(shellId)) {
    throw new Error(
      `shellId 形状不合法（应为 32 位小写十六进制，服务端生成）：${JSON.stringify(shellId)}`,
    );
  }
  return `${PLATFORM_SHELL_SESSION_PREFIX}${shellId}`;
}

/**
 * 销毁**一个用户终端标签**的 tmux 会话（06 §5）。入参是 id 而不是会话名 —— 名字由
 * `shellSessionName()` 现拼，于是这个入口在类型之外还有一层结构性保证：
 * **它构造不出 `platform-agent`**。
 *
 * ⚠️ 不带 `set -g mouse on`，理由与 `hasSessionCmd` 那条一样：这条命令不 attach、
 * 也不渲染任何东西，没有客户端可言。`-u` 留着只为与同文件其余入口保持一致形状。
 */
export function killShellSessionCmd(shellId: string): string[] {
  return ['tmux', UTF8, 'kill-session', '-t', shellSessionName(shellId)];
}

/**
 * `list-sessions` 的输出格式：`<会话名>\t<创建时间(unix 秒)>`。
 *
 * ⚠️ 创建时间不是可有可无的装饰：它是**标签顺序**的唯一诚实来源（06 §5.5）。刷新之后
 * 前端手里只有一串 id，「谁是终端 1」只能由沙箱里这份事实回答。
 */
const SESSION_LIST_FORMAT = `#{session_name}\t#{session_created}\t#{${TMUX_RUNTIME_OPTION}}`;

/**
 * 列出沙箱里所有 tmux 会话（调用方再按前缀 + 形状筛出我们自己的）。
 *
 * ⚠️ **不带 `set -g mouse on`**，与 `hasSessionCmd` 同一条理由，而且这里更硬：
 * 这条命令的**退出码是载荷** —— 非零 = 「问不出来」（tmux server 不在 / 沙箱不通），
 * 要与「答了，一个都没有」分开（06 §5.5 三态）。前面链一条 `set` 就是拿链式命令的
 * 退出码去冒充它的，那会把「不知道」悄悄变成「没有」。
 * `-u` 照旧带上，与同文件其余入口保持一致形状。
 */
export function listSessionsCmd(): string[] {
  return ['tmux', UTF8, 'list-sessions', '-F', SESSION_LIST_FORMAT];
}

/**
 * 把 `listSessionsCmd()` 的 stdout 解析成**我们自己的**用户终端会话 id，按创建时间升序。
 *
 * ⛔ **两道闸门，缺一不可**：
 *   ① 前缀 `platform-shell-` —— 把 `platform-agent` 挡在外面（它进了清单，前端就会
 *      给任务自己的会话多渲染一个可关的标签）；
 *   ② 剩余部分必须过 `SHELL_SESSION_ID_RE`（32 位小写十六进制）。⚠️ 光有前缀不够：
 *      用户完全可以在沙箱里自己 `tmux new -s platform-shell-hi`，那是**他的**会话，
 *      不该冒充成平台的标签；而且这一段最终会回到 `tmux -s` 的 argv 里。
 *
 * ⚠️ 形状不合**静默跳过**，不抛 —— 那是别人的会话，不是我们的错误。抛的话，沙箱里
 * 随便一个手工起的同前缀会话就能让整张清单取不回来（一个更坏的失败）。
 *
 * ⚠️ 扛得住空输入与半行：`no server running` 这类是 **stderr + 非零退出码**，走的是
 * 调用方的「问不出来」那一支，到不了这里；这里只负责"给什么就诚实解析什么"。
 */
export function parseShellSessionList(stdout: string): ShellSessionSummary[] {
  const rows: { shellId: string; runtimeId?: string; created: number }[] = [];
  for (const line of stdout.split('\n')) {
    // ⚠️ 只削行尾的 `\r`，⛔ 不整行 trim：runtime 是**最后一列且可能为空**，
    //    整行 trim 在这里无害，但"先 trim 再 split"会让人以为空列是被清理掉的 ——
    //    实际是 `split` 给了空串，与"没这一列"在下面走同一条路。
    const [name, created, runtimeId] = line.replace(/\r$/, '').split('\t');
    if (name === undefined || !name.startsWith(PLATFORM_SHELL_SESSION_PREFIX)) continue;
    const id = name.slice(PLATFORM_SHELL_SESSION_PREFIX.length);
    if (!SHELL_SESSION_ID_RE.test(id)) continue; // 别人的会话，静默跳过
    const t = Number(created);
    rows.push({
      shellId: id,
      created: Number.isFinite(t) ? t : 0,
      // ⚠️ 空 / 缺席 ⇒ **不带这个字段**（纯终端标签，或老 tmux 读不出用户选项）。
      //    ⛔ 绝不因为读不到它而丢掉整条会话 —— 那会让刷新之后标签直接少几个。
      ...(runtimeId === undefined || runtimeId.trim() === ''
        ? {}
        : { runtimeId: runtimeId.trim() }),
    });
  }
  // 按创建时间升序；同秒创建的按 id 排，保证同一份输入永远得到同一个顺序
  //（顺序决定前端的「终端 1..n」，抖一下就是标签改名）。
  rows.sort(
    (a, b) => a.created - b.created || (a.shellId < b.shellId ? -1 : a.shellId > b.shellId ? 1 : 0),
  );
  return rows.map(({ shellId, runtimeId }) =>
    runtimeId === undefined ? { shellId } : { shellId, runtimeId },
  );
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
