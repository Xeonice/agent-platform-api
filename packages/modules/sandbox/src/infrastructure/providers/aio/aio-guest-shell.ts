import { randomBytes } from 'node:crypto';
import {
  SandboxProviderError,
  SandboxProviderErrorCode,
  type ProcessSpec,
  type ProcessStream,
} from '@platform/contracts';
import { exitCodeOf, shellQuote, type AioAgentHttp, type ExecResult } from './aio-http';
import { writeFileContent } from './aio-files';
import { AioExecProcessStream, AioWsProcessStream } from './aio-process.stream';

/**
 * 沙箱内 shell 的两种用法 —— **交互式 pty** 与 **一次性 exec**。
 *
 * ⚠️ 与 `boxlite-guest-shell.ts` 对称：两档都在这一层把「在沙箱里跑一条命令」翻译成
 * 各自沙箱的原生通道。boxlite 走 native `Box.exec`，aio 走 `ws /v1/shell/ws` 与
 * `POST /v1/bash/exec` —— 都是**沙箱自己的接口**，不是 `docker exec` 那种从外面撬。
 *
 * ── 为什么 tty 与 exec 走两个不同端点 ────────────────────────────────────────
 * `ws /v1/shell/ws` **不接受命令**：连上就起它自己的默认 shell（uplink 帧只有
 * `input` / `resize`），所以 `ProcessSpec.cmd`（以及 `env` / `cwd`）只能靠往 shell 里
 * 敲一行进去 —— 见 `launchLine`。
 * 而 `POST /v1/bash/exec` 原生带 `exec_dir` / `env` / `hard_timeout`，配套
 * `/v1/bash/kill` 投递真实信号 —— `/v1/shell/exec` 则会**静默丢掉 `env`**（实测）。
 */

/** Ceiling on waiting for the pty to settle before writing the attach command. */
export const PTY_READY_GRACE_MS = 8_000;
/** Output must be quiet this long (after `ready`) before the shell is fed a line. */
export const PTY_READY_QUIET_MS = 400;
/** Poll beat of the quiet detector (a tick counter — wall clock is banned, 01 §3). */
const PTY_READY_TICK_MS = 100;
/** Extra wall-time the transport gets beyond the agent's own `hard_timeout`. */
const ABORT_SLACK_MS = 5_000;

function wsUrl(http: AioAgentHttp, ticket?: string): string {
  const base = `${http.wsOrigin}/v1/shell/ws`;
  return ticket ? `${base}?ticket=${encodeURIComponent(ticket)}` : base;
}

/**
 * Interactive terminal over the AIO shell websocket.
 *
 * The WHATWG `WebSocket` the runtime gives us cannot carry request headers, so
 * the bearer token cannot ride the upgrade. The agent anticipates exactly this:
 * `POST /tickets` (itself bearer-protected) mints a short-lived one — its
 * `GET /auth` handler checks a `ticket` query param BEFORE the Authorization
 * header, reading it off nginx's `X-Original-URI`. So we spend the token once
 * over HTTP and hand the upgrade a ticket. 探明 2026-08 against the real image:
 * no ticket ⇒ the upgrade is refused, a bogus ticket ⇒ refused, ours ⇒ 101.
 */
export async function openTerminal(
  http: AioAgentHttp,
  cols: number,
  rows: number,
  cmd?: string[],
  launch?: TerminalLaunch,
): Promise<ProcessStream> {
  // ⚠️ 先把要敲进去的那行拼出来 **再连** —— `env` 名字非法要在开 ws 之前就炸，
  //    否则就是「连上了、什么都没跑、也没人报错」，正是下面注释在说的那种静默。
  const line = launchLine(cmd ?? [], launch);
  const ticket = http.authenticated ? await http.issueWsTicket() : undefined;
  const ws = new WebSocket(wsUrl(http, ticket));
  await awaitOpen(http, ws);
  // seed the initial window size (AIO `resize` mapping); the shell PTY is spawned
  // by the agent on connect, so no explicit "start" frame is required.
  safeSend(ws, { type: 'resize', data: { cols, rows } });
  const stream = new AioWsProcessStream(ws);
  if (line !== '') await runInTerminal(ws, stream, line);
  return stream;
}

/**
 * Make an interactive session run the line `launchLine` built (S5: `tmux attach -t
 * platform-agent`).
 *
 * WHY THIS IS TYPED INTO THE SHELL RATHER THAN PASSED AS A PARAMETER: the agent's
 * `ws /v1/shell/ws` takes NO command — it always spawns its own default shell on
 * connect (端点能力面探明 2026-08; the uplink frames are only `input` / `resize`).
 * Until S5 that meant `ProcessSpec.cmd` was silently DROPPED on the tty side (04
 * §2.3★「仍然存在的限制」), which would have left every terminal on a bare shell
 * instead of the agent session provision started — i.e. the whole 「打开终端就看到
 * agent」 promise would have been quietly false.
 *
 * `exec` REPLACES that default shell, so the requested command owns the pty: when it
 * exits the session really ends (no stray shell lingering behind it), and the exit
 * frame the gateway forwards is the command's own.
 *
 * The write waits for the agent's `ready` frame — bytes sent before the pty exists
 * are simply lost. The wait is bounded: on timeout we write anyway, because an
 * interactive shell that never announced itself is still far more likely to accept
 * the line than not, and refusing to attach would be a worse failure than a retry.
 */
async function runInTerminal(ws: WebSocket, stream: ProcessStream, line: string): Promise<void> {
  await awaitShellReady(ws);
  stream.write(line);
}

/**
 * `ProcessSpec` 里那两个在这条通道上**没有原生位置**的字段。
 *
 * ⚠️ 它们不是可选的锦上添花：契约把 `env` / `cwd` 声明在 `ProcessSpec` 上，provider
 * 收下再丢掉，调用方就会拿到一个「跑起来了但环境不是它要的」的进程 —— 比直接失败难查
 * 得多。2026-09-23 真机上正是这样：`ContainerAuthHelper` 靠 `env.HOME` / `env.<CLI>_HOME`
 * 做每次登录的隔离目录，丢了之后 codex 写进容器默认 HOME，平台在隔离目录里读不到
 * `auth.json`，于是报「对方拒绝了这次登录」—— ⛔ 又一次指错方向。
 */
export interface TerminalLaunch {
  env?: Record<string, string>;
  cwd?: string;
}

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * 把 `cmd` / `env` / `cwd` 编成**一行 shell**。
 *
 * ── 为什么只能编进命令行 ──────────────────────────────────────────────────────
 * 这条通道的 uplink 帧只有 `input` / `resize`（见文件头），**没有任何一处能放 env 或
 * 工作目录**。所以要么在这里翻译成 shell 语法，要么静默丢掉 —— 没有第三种。
 *
 * ── 三个刻意的选择 ───────────────────────────────────────────────────────────
 * ① `cd … || exit 1` 而**不是** `cd … && exec …`：`&&` 在 cd 失败时会把用户留在一个
 *    **看起来正常的默认 shell** 里（错的目录、错的进程），那正是本文件反复在删的那种
 *    「静默降级」。`exit 1` 让会话直接结束，调用方的 `onExit` 立刻知道出事了。
 * ② `export K=V` 而**不是** `env K=V cmd`：后者把值放进 `env` 的 **argv**，容器里任何
 *    一个进程都能从 `/proc/<pid>/cmdline` 读到；前者只进 shell 自己的 environ
 *    （`ProcessSpec.stdin` 的注释立的就是这条规矩）。
 * ③ 用 `cd` + `export` 这两个 POSIX 特性而**不是** `env -C`：后者要 coreutils ≥ 8.28，
 *    而镜像换一张就可能是 busybox —— ⛔ 不拿「这张镜像恰好有」当依据。
 *
 * ⚠️ 值经 `shellQuote` 单引号包死；名字**校验而不是转义**：`export` 的左边不是一个词
 * 位置，引号在那儿没有意义，非法名字只能拒绝。
 */
function launchLine(cmd: string[], launch: TerminalLaunch | undefined): string {
  const parts: string[] = [];
  if (launch?.cwd !== undefined && launch.cwd !== '') {
    parts.push(`cd ${shellQuote(launch.cwd)} || exit 1`);
  }
  for (const [name, value] of Object.entries(launch?.env ?? {})) {
    if (!ENV_NAME_RE.test(name)) {
      throw new SandboxProviderError(
        SandboxProviderErrorCode.INVALID_STATE,
        `environment variable name '${name}' is not a valid shell identifier`,
      );
    }
    parts.push(`export ${name}=${shellQuote(value)}`);
  }
  if (cmd.length > 0) parts.push(`exec ${cmd.map(shellQuote).join(' ')}`);
  return parts.length === 0 ? '' : `${parts.join('; ')}\n`;
}

/**
 * Wait until the freshly-spawned shell will actually READ what we type.
 *
 * The agent's `ready` frame alone is not enough — measured against the real image,
 * the shell then emits its own init burst (`export PS1=…`, `export SESSION_ID=…`,
 * `clear`), and anything written into that window is either swallowed by the shell's
 * startup or wiped by the `clear`. The symptom is nasty precisely because it is
 * intermittent: the terminal silently shows a bare shell instead of the agent.
 *
 * So we wait for `ready` AND for the output to go QUIET, with a hard ceiling. The
 * quiet detector counts ticks since the last frame rather than reading a clock —
 * wall-clock calls are banned outside the Clock port (01 §3).
 */
function awaitShellReady(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    let ready = false;
    let quietTicks = 0;
    let elapsedTicks = 0;
    const onMessage = (ev: MessageEvent): void => {
      const raw = typeof ev.data === 'string' ? ev.data : String(ev.data);
      if (/"type"\s*:\s*"ready"/.test(raw)) ready = true;
      if (/"type"\s*:\s*"output"/.test(raw)) quietTicks = 0;
    };
    const done = (): void => {
      clearInterval(timer);
      ws.removeEventListener('message', onMessage);
      resolve();
    };
    const timer = setInterval(() => {
      quietTicks += 1;
      elapsedTicks += 1;
      const quietEnough = quietTicks * PTY_READY_TICK_MS >= PTY_READY_QUIET_MS;
      const outOfPatience = elapsedTicks * PTY_READY_TICK_MS >= PTY_READY_GRACE_MS;
      // out of patience ⇒ write anyway: a shell that never announced itself is far
      // more likely to accept the line than not, and refusing to attach at all is
      // the worse failure.
      if ((ready && quietEnough) || outOfPatience) done();
    }, PTY_READY_TICK_MS);
    timer.unref?.();
    ws.addEventListener('message', onMessage);
  });
}

/**
 * One-shot command; collects combined output then reports the real exit code
 * (04 §2.3). Every `ProcessSpec` field is honoured — see `runExec` for how each
 * one maps onto the agent API. `spec.user` is REJECTED rather than dropped: the
 * agent API has no user-switching parameter (04 §4 `UNSUPPORTED_CAPABILITY`).
 */
export async function exec(http: AioAgentHttp, spec: ProcessSpec): Promise<ProcessStream> {
  if (spec.user !== undefined && spec.user !== '') {
    throw new SandboxProviderError(
      SandboxProviderErrorCode.UNSUPPORTED_CAPABILITY,
      'the in-sandbox AIO agent exposes no user-switching parameter; ' +
        'ProcessSpec.user is not supported on the agent data plane',
    );
  }
  // Client-chosen session id: it is the KILL HANDLE, so it must be known BEFORE
  // the (blocking) exec request is in flight — otherwise `kill()` has nothing to
  // target until the command has already finished. The agent accepts an
  // arbitrary caller-supplied `session_id` and creates the session on demand.
  const sessionId = `platform-exec-${randomBytes(8).toString('hex')}`;
  const abort = new AbortController();
  const result = runExec(http, spec, sessionId, abort);
  return new AioExecProcessStream(result, {
    signal: (sig) => http.killSession(sessionId, sig),
    abort: () => abort.abort(),
  });
}

/**
 * ProcessSpec → AIO `/v1/bash/exec` field mapping:
 *   cmd       → `command`   (each argv element POSIX-quoted so the agent's shell
 *                            reconstructs the exact argv — the neutral contract
 *                            passes an argv array, the agent runs a shell string)
 *   cwd       → `exec_dir`  (NATIVE)
 *   env       → `env`       (NATIVE, verbatim — no client-side escaping)
 *   timeoutMs → `hard_timeout` seconds (NATIVE, actually kills the remote
 *                            process) + a client abort as the transport backstop
 *   stdin     → a 0700 scratch file written through `POST /v1/file/write` and
 *                            redirected in (see `wrapWithStdin`) — NEVER argv
 */
async function runExec(
  http: AioAgentHttp,
  spec: ProcessSpec,
  sessionId: string,
  abort: AbortController,
): Promise<ExecResult> {
  const argv = spec.cmd.map(shellQuote).join(' ');
  let command = argv;
  let stdinDir: string | undefined;
  const timer =
    spec.timeoutMs !== undefined
      ? setTimeout(() => abort.abort(), spec.timeoutMs + ABORT_SLACK_MS)
      : undefined;
  timer?.unref();
  try {
    if (spec.stdin !== undefined) {
      stdinDir = `/tmp/.platform-stdin-${randomBytes(16).toString('hex')}`;
      // `mkdir -m 700` (no -p) is atomic and fails on a pre-existing path, so the
      // scratch dir cannot be squatted; the secret file lands inside it.
      await http.postBashExec(
        { session_id: sessionId, command: `mkdir -m 700 -- ${shellQuote(stdinDir)}` },
        abort.signal,
      );
      await writeFileContent(http, `${stdinDir}/stdin`, spec.stdin);
      command = wrapWithStdin(argv, `${stdinDir}/stdin`, stdinDir);
    }
    const data = await http.postBashExec(
      {
        session_id: sessionId,
        command,
        exec_dir: spec.cwd,
        env: spec.env,
        hard_timeout: spec.timeoutMs !== undefined ? spec.timeoutMs / 1000 : undefined,
      },
      abort.signal,
    );
    return {
      output: `${data.stdout ?? ''}${data.stderr ?? ''}`,
      code: exitCodeOf(data),
    };
  } finally {
    clearTimeout(timer);
    // Cleanup runs UNSIGNALLED: `kill()` aborts `abort.signal`, and the scratch
    // dir (which holds the secret) must still be removed on that path — the
    // in-command `rm -rf` never ran if the command was killed mid-flight.
    if (stdinDir) await http.bestEffort(sessionId, `rm -rf -- ${shellQuote(stdinDir)}`);
    await http.closeSession(sessionId);
  }
}

function awaitOpen(http: AioAgentHttp, ws: WebSocket): Promise<void> {
  return awaitOpenAt(ws, wsUrl(http));
}

function awaitOpenAt(ws: WebSocket, url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onOpen = (): void => {
      cleanup();
      resolve();
    };
    const onError = (): void => {
      cleanup();
      reject(
        new SandboxProviderError(
          SandboxProviderErrorCode.PROVIDER_UNAVAILABLE,
          `AIO agent websocket failed to open at ${url}`,
          undefined,
          true,
        ),
      );
    };
    const cleanup = (): void => {
      ws.removeEventListener('open', onOpen);
      ws.removeEventListener('error', onError);
    };
    ws.addEventListener('open', onOpen);
    ws.addEventListener('error', onError);
  });
}

function safeSend(ws: WebSocket, frame: unknown): void {
  try {
    ws.send(JSON.stringify(frame));
  } catch {
    /* socket not open — ignore, exit will be synthesised on close */
  }
}

/**
 * Redirect a scratch file into the command's stdin and shred it afterwards, while
 * preserving the command's own exit status.
 *
 *   `<argv> < '<file>'`   — real fd 0 with a real EOF. (The agent's stdin uplink
 *   `/v1/bash/write` cannot signal EOF — verified: writing `\x04` or an empty
 *   string leaves `cat` running forever — so a file is the only way to feed a
 *   command that reads to EOF, e.g. `codex login --with-access-token`.)
 *
 * The payload never appears in argv: only the FILE PATH does.
 */
export function wrapWithStdin(argv: string, file: string, dir: string): string {
  return (
    `__platform_rc=0; ${argv} < ${shellQuote(file)} || __platform_rc=$?; ` +
    `rm -rf -- ${shellQuote(dir)}; ( exit $__platform_rc )`
  );
}
