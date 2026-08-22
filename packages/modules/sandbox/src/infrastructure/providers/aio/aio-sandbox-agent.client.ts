import { randomBytes } from 'node:crypto';
import {
  SandboxProviderError,
  SandboxProviderErrorCode,
  type ProcessSpec,
  type ProcessStream,
} from '@platform/contracts';

/**
 * Data-plane client for the in-sandbox AIO Sandbox agent (SANDBOX-RUNTIME-DECISIONS
 * 决策 A). The control plane (dockerode / BoxLite SDK) only manages the sandbox
 * lifecycle; exec/pty go through the agent HTTP+WS API exposed on `:8080` INSIDE
 * the sandbox. This client translates the AIO wire protocol ↔ the neutral
 * `ProcessStream` so the gateway stays provider-agnostic (translation lives HERE,
 * not in the gateway).
 *
 *   tty:true  → `ws   /v1/shell/ws`   (interactive PTY)
 *   tty:false → `POST /v1/bash/exec`  (one-shot, collect stdout+stderr to EOF)
 *
 * ── Why `/v1/bash/exec` and not `/v1/shell/exec` (探明于 2026-08，实测真镜像) ──
 * `/v1/shell/exec` accepts ONLY `command` + `exec_dir`; it silently DROPS `env`
 * (verified: `{command:'echo E=$PROBE', env:{PROBE:'x'}}` → `E=`) and has no stdin
 * or signal channel. `/v1/bash/exec` natively carries `exec_dir` (cwd), `env`
 * (verbatim — no shell re-quoting, injection-proof), `hard_timeout` (a REAL remote
 * kill, not just an HTTP deadline) and returns `stdout`/`stderr`/`exit_code`
 * separately; its sibling `/v1/bash/kill` delivers real SIGTERM/SIGKILL/SIGINT.
 * So every `ProcessSpec` field except `stdin`/`user` is NATIVE passthrough.
 *
 * `baseHttpUrl` is the agent's reachable HTTP origin (e.g. http://127.0.0.1:55000
 * when the container port is loopback-published, or http://<container-ip>:8080 on
 * a shared docker network). The internal AIO `session_id` is held here and NEVER
 * surfaced — the only session identifier the frontend sees is the gateway's
 * server-generated `socketSessionKey`.
 *
 * `authToken` is the per-sandbox RS256 JWT minted at create() (see `agent-auth.ts`).
 * The loopback-published port is reachable by every LOCAL process, so the agent is
 * booted with its own nginx auth gateway ON and every call here carries the token.
 * It is optional only so the class stays usable against an agent that was started
 * without a public key (older images, fixtures) — the providers always pass one.
 */
export class AioSandboxAgentClient {
  constructor(
    private readonly baseHttpUrl: string,
    private readonly authToken?: string,
  ) {}

  private wsUrl(ticket?: string): string {
    const base = `${this.baseHttpUrl.replace(/^http/i, 'ws')}/v1/shell/ws`;
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
  async openTerminal(cols: number, rows: number, cmd?: string[]): Promise<ProcessStream> {
    const ticket = this.authToken !== undefined ? await this.issueWsTicket() : undefined;
    const ws = new WebSocket(this.wsUrl(ticket));
    await this.awaitOpen(ws);
    // seed the initial window size (AIO `resize` mapping); the shell PTY is spawned
    // by the agent on connect, so no explicit "start" frame is required.
    this.safeSend(ws, { type: 'resize', data: { cols, rows } });
    const stream = new AioWsProcessStream(ws);
    if (cmd !== undefined && cmd.length > 0) await this.runInTerminal(ws, stream, cmd);
    return stream;
  }

  /**
   * Make an interactive session run `cmd` (S5: `tmux attach -t platform-agent`).
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
  private async runInTerminal(ws: WebSocket, stream: ProcessStream, cmd: string[]): Promise<void> {
    await this.awaitShellReady(ws);
    stream.write(`exec ${cmd.map(shellQuote).join(' ')}\n`);
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
  private awaitShellReady(ws: WebSocket): Promise<void> {
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
  async exec(spec: ProcessSpec): Promise<ProcessStream> {
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
    const result = this.runExec(spec, sessionId, abort);
    return new AioExecProcessStream(result, {
      signal: (sig) => this.killSession(sessionId, sig),
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
  private async runExec(
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
        await this.postBashExec(
          { session_id: sessionId, command: `mkdir -m 700 -- ${shellQuote(stdinDir)}` },
          abort.signal,
        );
        await this.writeFile(`${stdinDir}/stdin`, spec.stdin, abort.signal);
        command = wrapWithStdin(argv, `${stdinDir}/stdin`, stdinDir);
      }
      const data = await this.postBashExec(
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
      if (stdinDir) await this.bestEffort(sessionId, `rm -rf -- ${shellQuote(stdinDir)}`);
      await this.closeSession(sessionId);
    }
  }

  /** POST /v1/bash/exec, unwrapping the agent's `{success,message,data}` envelope. */
  private async postBashExec(body: BashExecRequest, signal: AbortSignal): Promise<BashExecResult> {
    const res = await this.fetchAgent('/v1/bash/exec', body, signal);
    if (res.status === 404) {
      throw new SandboxProviderError(
        SandboxProviderErrorCode.PROVIDER_UNAVAILABLE,
        'in-sandbox agent has no POST /v1/bash/exec — an AIO Sandbox image exposing ' +
          'the /v1/bash API is required for env/cwd/stdin/timeout-carrying exec',
      );
    }
    const parsed = await readEnvelope(res);
    if (!res.ok || !parsed.success) {
      throw new SandboxProviderError(
        SandboxProviderErrorCode.INTERNAL,
        `AIO agent exec failed: HTTP ${res.status} ${parsed.message ?? ''}`.trim(),
      );
    }
    return parsed.data ?? {};
  }

  /**
   * Write the stdin payload through the agent's FILE API so it travels in an HTTP
   * BODY. It must NEVER reach the command string: the agent runs commands as
   * `/bin/bash -c '<script>'`, so anything embedded there (a heredoc included) is
   * readable in the sandbox's own `ps` / `/proc/<pid>/cmdline` — the exact leak
   * RA-14 forbids for secrets (05 §7 #3).
   */
  private async writeFile(file: string, content: string, signal: AbortSignal): Promise<void> {
    const res = await this.fetchAgent('/v1/file/write', { file, content }, signal);
    const parsed = await readEnvelope(res);
    if (!res.ok || !parsed.success) {
      throw new SandboxProviderError(
        SandboxProviderErrorCode.INTERNAL,
        `AIO agent file write failed: HTTP ${res.status} ${parsed.message ?? ''}`.trim(),
      );
    }
  }

  /** POST /v1/bash/kill — REAL signal delivery to the session's current command. */
  private async killSession(sessionId: string, signal: AgentSignal): Promise<void> {
    try {
      await this.fetchAgent('/v1/bash/kill', { session_id: sessionId, signal });
    } catch {
      /* agent unreachable — the caller falls back to a local abort */
    }
  }

  /** Sessions are server-side state and accumulate; drop ours when the exec ends. */
  private async closeSession(sessionId: string): Promise<void> {
    try {
      await this.fetchAgent(`/v1/bash/sessions/${encodeURIComponent(sessionId)}/close`, {});
    } catch {
      /* best effort — a stale session is reaped with the sandbox */
    }
  }

  private async bestEffort(sessionId: string, command: string): Promise<void> {
    try {
      await this.fetchAgent('/v1/bash/exec', { session_id: sessionId, command });
    } catch {
      /* best effort — the scratch dir dies with the sandbox at worst */
    }
  }

  /**
   * Trade the bearer token for a short-lived websocket ticket. A failure here is
   * NOT downgraded to an unauthenticated connect — that would silently reopen the
   * hole the token exists to close.
   */
  private async issueWsTicket(): Promise<string> {
    const res = await this.fetchAgent('/tickets', {});
    const ticket = await res
      .json()
      .then((d) => (d as { ticket?: unknown }).ticket)
      .catch(() => undefined);
    if (!res.ok || typeof ticket !== 'string' || ticket === '') {
      throw new SandboxProviderError(
        SandboxProviderErrorCode.PROVIDER_UNAVAILABLE,
        `AIO agent refused to mint a websocket ticket (HTTP ${res.status}); ` +
          'the terminal cannot be opened without one',
        undefined,
        true,
      );
    }
    return ticket;
  }

  /** Every agent call carries the sandbox's bearer token when one was minted. */
  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'content-type': 'application/json' };
    if (this.authToken !== undefined) h.authorization = `Bearer ${this.authToken}`;
    return h;
  }

  private async fetchAgent(path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
    try {
      return await fetch(`${this.baseHttpUrl}${path}`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
        signal,
      });
    } catch (e) {
      throw new SandboxProviderError(
        SandboxProviderErrorCode.PROVIDER_UNAVAILABLE,
        `AIO agent ${path} unreachable: ${(e as Error).message}`,
        e,
        true,
      );
    }
  }

  private awaitOpen(ws: WebSocket): Promise<void> {
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
            `AIO agent websocket failed to open at ${this.wsUrl()}`,
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

  private safeSend(ws: WebSocket, frame: unknown): void {
    try {
      ws.send(JSON.stringify(frame));
    } catch {
      /* socket not open — ignore, exit will be synthesised on close */
    }
  }
}

/** Extra wall-time the transport gets beyond the agent's own `hard_timeout`. */
const ABORT_SLACK_MS = 5_000;
/** SIGTERM → grace → SIGKILL window (03 §8.3 两阶段 kill). */
export const KILL_GRACE_MS = 5_000;
/** Beat between the PTY interrupt/exit writes and closing the socket. */
export const PTY_KILL_SETTLE_MS = 250;
/** Ceiling on waiting for the pty to settle before writing the attach command. */
export const PTY_READY_GRACE_MS = 8_000;
/** Output must be quiet this long (after `ready`) before the shell is fed a line. */
export const PTY_READY_QUIET_MS = 400;
/** Poll beat of the quiet detector (a tick counter — wall clock is banned, 01 §3). */
const PTY_READY_TICK_MS = 100;
/** ETX — the tty line discipline turns this into SIGINT for the foreground pgroup. */
const CTRL_C = '\u0003';

/** The only three signals `/v1/bash/kill` accepts. */
export type AgentSignal = 'SIGTERM' | 'SIGKILL' | 'SIGINT';

/** Map a POSIX signal onto what the agent can actually deliver (default SIGTERM). */
export function toAgentSignal(signal?: NodeJS.Signals): AgentSignal {
  if (signal === 'SIGKILL') return 'SIGKILL';
  if (signal === 'SIGINT') return 'SIGINT';
  return 'SIGTERM';
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

/** POSIX single-quote a shell word so the agent's shell preserves it verbatim. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * `timed_out` is the agent's HARD-timeout kill; report the conventional 124 the
 * platform already speaks (03 §8.3) instead of the agent's internal -1.
 */
function exitCodeOf(data: BashExecResult): number | null {
  if (data.status === 'timed_out') return 124;
  return typeof data.exit_code === 'number' ? data.exit_code : null;
}

async function readEnvelope(res: Response): Promise<AgentEnvelope> {
  try {
    return (await res.json()) as AgentEnvelope;
  } catch {
    return { success: false };
  }
}

interface AgentEnvelope {
  success?: boolean;
  message?: string;
  data?: BashExecResult;
}

interface BashExecResult {
  status?: string;
  stdout?: string | null;
  stderr?: string | null;
  exit_code?: number | null;
}

interface BashExecRequest {
  session_id: string;
  command: string;
  exec_dir?: string;
  env?: Record<string, string>;
  hard_timeout?: number;
}

interface ExecResult {
  output: string;
  code: number | null;
}

/** What `AioExecProcessStream` may do to the in-flight exec on `kill()`. */
interface ExecControl {
  signal(sig: AgentSignal): Promise<void>;
  abort(): void;
}

/** AIO shell-websocket frames (server → client). */
type AioServerFrame =
  | { type: 'output'; data: string }
  | { type: 'ping' }
  | { type: 'session_id'; data: string }
  | { type: 'ready'; data: string }
  | { type: string; data?: unknown };

/**
 * The slice of the WHATWG `WebSocket` surface the PTY stream actually uses. A real
 * `WebSocket` satisfies it structurally; declaring it lets the kill/keepalive
 * protocol be unit-tested with a recording double instead of a live socket.
 */
export interface PtySocket {
  addEventListener(type: 'message', cb: (ev: MessageEvent) => void): void;
  addEventListener(type: 'close' | 'error', cb: () => void): void;
  send(data: string): void;
  close(): void;
}

/** Wraps the AIO shell websocket as the neutral ProcessStream (mapping per ADR). */
export class AioWsProcessStream implements ProcessStream {
  readonly ref: string;
  private readonly dataCbs: ((chunk: Buffer) => void)[] = [];
  private readonly exitCbs: ((code: number | null) => void)[] = [];
  private exited = false;

  constructor(private readonly ws: PtySocket) {
    // AIO session_id is captured internally and never surfaced (ADR: only the
    // gateway's socketSessionKey is external). Default ref until the agent sends it.
    this.ref = 'aio-pty';
    ws.addEventListener('message', (ev: MessageEvent) => this.onMessage(ev));
    ws.addEventListener('close', () => this.synthExit(null));
    ws.addEventListener('error', () => this.synthExit(null));
  }

  private onMessage(ev: MessageEvent): void {
    const raw = typeof ev.data === 'string' ? ev.data : String(ev.data);
    let frame: AioServerFrame;
    try {
      frame = JSON.parse(raw) as AioServerFrame;
    } catch {
      return; // non-JSON keepalive / noise — ignore
    }
    switch (frame.type) {
      case 'output':
        if (typeof frame.data === 'string') {
          const buf = Buffer.from(frame.data, 'utf8');
          for (const cb of this.dataCbs) cb(buf);
        }
        break;
      case 'ping':
        // keepalive: consume internally, answer with pong (ADR mapping). A
        // monotonic timer is used for the echoed timestamp (Date.now() is the
        // banned wall-clock; the agent only needs a pong, not real time).
        this.reply({ type: 'pong', data: { timestamp: Math.round(performance.now()) } });
        break;
      // session_id / ready are internal handshake noise — swallowed on purpose.
      default:
        break;
    }
  }

  private reply(frame: unknown): void {
    try {
      this.ws.send(JSON.stringify(frame));
    } catch {
      /* ignore */
    }
  }

  private synthExit(code: number | null): void {
    if (this.exited) return;
    this.exited = true;
    for (const cb of this.exitCbs) cb(code);
  }

  onData(cb: (chunk: Buffer) => void): void {
    this.dataCbs.push(cb);
  }

  write(data: string | Buffer): void {
    const s = typeof data === 'string' ? data : data.toString('utf8');
    this.reply({ type: 'input', data: s });
  }

  resize(cols: number, rows: number): void {
    this.reply({ type: 'resize', data: { cols, rows } });
  }

  onExit(cb: (code: number | null) => void): void {
    this.exitCbs.push(cb);
    if (this.exited) cb(null);
  }

  /**
   * Terminate the PTY session — BEST EFFORT, and deliberately not a signal API.
   *
   * The agent exposes NO process management for ws PTY sessions (探明 2026-08:
   * `POST /v1/shell/kill` and `DELETE /v1/shell/sessions/{id}` both answer
   * "Session not found" for a ws `session_id` — that namespace only covers the
   * HTTP shell), and merely closing the socket leaves the shell AND its foreground
   * job running (measured: `bash -i` + `sleep` survive the close indefinitely).
   *
   * So the signal channel used here is the PTY itself, which is real POSIX:
   *   1. ETX (0x03) → the tty line discipline raises SIGINT on the foreground
   *      process group, killing whatever the user was running;
   *   2. `exit\n` → the interactive shell leaves, so the session is not leaked;
   *   3. close the socket and synthesise the exit.
   *
   * `signal` selects only how far to go: `SIGINT` stops at step 1 (interrupt, leave
   * the shell alive), anything else runs the full teardown. A process that IGNORES
   * SIGINT (or a wedged tty) survives — the only GUARANTEED teardown is
   * `SandboxProvider.destroy()` / `stop()`, which takes the whole instance with it
   * (03 §8.3).
   */
  async kill(signal?: NodeJS.Signals): Promise<void> {
    this.write(CTRL_C);
    if (toAgentSignal(signal) !== 'SIGINT') {
      this.write('exit\n');
    }
    // let the agent pump the frames into the pty before the socket goes away
    await new Promise((r) => setTimeout(r, PTY_KILL_SETTLE_MS));
    try {
      this.ws.close();
    } catch {
      /* already closing */
    }
    this.synthExit(null);
  }
}

/**
 * One-shot exec wrapped as a ProcessStream: replays the collected output then the
 * exit code, regardless of onData/onExit registration order (each callback fires
 * exactly once).
 */
class AioExecProcessStream implements ProcessStream {
  readonly ref = 'aio-exec';
  private readonly dataCbs: ((chunk: Buffer) => void)[] = [];
  private readonly exitCbs: ((code: number | null) => void)[] = [];
  private readonly settleWaiters: (() => void)[] = [];
  private settled = false;
  private output: Buffer | null = null;
  private code: number | null = null;

  constructor(
    result: Promise<ExecResult>,
    private readonly control: ExecControl,
  ) {
    result
      .then(({ output, code }) => this.settle(Buffer.from(output, 'utf8'), code))
      .catch(() => this.settle(Buffer.from(''), null));
  }

  private settle(output: Buffer, code: number | null): void {
    if (this.settled) return;
    this.settled = true;
    this.output = output;
    this.code = code;
    for (const cb of this.dataCbs) cb(output);
    for (const cb of this.exitCbs) cb(code);
    for (const w of this.settleWaiters.splice(0)) w();
  }

  onData(cb: (chunk: Buffer) => void): void {
    this.dataCbs.push(cb);
    if (this.settled && this.output) cb(this.output);
  }

  write(): void {
    // One-shot exec has no stdin uplink: the payload is delivered up-front via
    // ProcessSpec.stdin (the agent's own /v1/bash/write cannot signal EOF).
  }

  resize(): void {
    /* not a pty */
  }

  onExit(cb: (code: number | null) => void): void {
    this.exitCbs.push(cb);
    if (this.settled) cb(this.code);
  }

  /**
   * REAL kill: `POST /v1/bash/kill` delivers the signal to the session's current
   * command inside the sandbox (verified against the real agent — a killed
   * `sleep 60` returns `exit_code:-15` and the in-flight exec request unblocks
   * immediately). Two-phase per 03 §8.3: SIGTERM, a grace window, then SIGKILL.
   * An explicit `signal` is delivered as asked (only SIGTERM/SIGKILL/SIGINT exist
   * on the agent; anything else degrades to SIGTERM) and still escalates.
   *
   * If the agent itself is unreachable the remote process cannot be reached at all
   * — we then abort the transport so the caller stops waiting, and the guaranteed
   * backstop remains `SandboxProvider.destroy()`.
   */
  async kill(signal?: NodeJS.Signals): Promise<void> {
    if (this.settled) return;
    const requested = toAgentSignal(signal);
    await this.control.signal(requested);
    if (await this.waitSettled(KILL_GRACE_MS)) return;
    if (requested !== 'SIGKILL') {
      await this.control.signal('SIGKILL');
      if (await this.waitSettled(KILL_GRACE_MS)) return;
    }
    this.control.abort();
    this.settle(this.output ?? Buffer.from(''), null);
  }

  /** Resolve true if the exec settled within `ms` (monotonic timer, no wall clock). */
  private waitSettled(ms: number): Promise<boolean> {
    if (this.settled) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const i = this.settleWaiters.indexOf(onSettle);
        if (i >= 0) this.settleWaiters.splice(i, 1);
        resolve(false);
      }, ms);
      const onSettle = (): void => {
        clearTimeout(timer);
        resolve(true);
      };
      this.settleWaiters.push(onSettle);
    });
  }
}
