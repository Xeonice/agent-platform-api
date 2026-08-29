import type { ProcessStream } from '@platform/contracts';
import type { ExecResult } from './aio-http';

/**
 * 中立 `ProcessStream` 的两个 AIO 实现 —— **协议翻译住在这里，不在网关**
 * （SANDBOX-RUNTIME-DECISIONS「终端两段映射」）。
 *
 *   `AioWsProcessStream`   ← `ws /v1/shell/ws`（交互式 pty）
 *   `AioExecProcessStream` ← `POST /v1/bash/exec`（一次性，收满输出再回放）
 *
 * ⚠️ 与 `boxlite-process.stream.ts` **对称**：两档都在自己的 provider 目录里把各自
 * 沙箱的原生通道翻译成同一个中立接口，网关因此永远只跟 `ProcessStream` 打交道。
 *
 * ⚠️ **`ExecControl` 是这一层唯一向上要的东西**：一次性 exec 的 `kill()` 需要既能给
 * 远端投递真信号、又能中断本地那次 HTTP 等待。把这两件事收成一个接口，是为了让这个
 * 文件**不认识** HTTP —— 否则「回放输出」和「怎么发请求」就又长在一起了。
 */
/** SIGTERM → grace → SIGKILL window (03 §8.3 两阶段 kill). */
export const KILL_GRACE_MS = 5_000;
/** Beat between the PTY interrupt/exit writes and closing the socket. */
export const PTY_KILL_SETTLE_MS = 250;
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

/** What `AioExecProcessStream` may do to the in-flight exec on `kill()`. */
export interface ExecControl {
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
  /**
   * 断开 ≠ 结束。只关本端 socket:沙箱内那个 `tmux attach` 进程随之退出,而 tmux
   * **session 本身连同里面正在跑的 agent 原样活着**(06 §6.6「WS 断开 = detach」)。
   *
   * 这里**不 synthExit**:进程并没有退出,合成一个 exit 等于对上层撒谎。
   */
  detach(): void {
    // ⚠️ **先上锁再关 socket,顺序是承重的。** 构造函数把 ws 的 `'close'` 与 `'error'`
    // 都接到了 `synthExit(null)` —— 而本端主动 `close()` 之后 `'close'` 照样会触发。
    // 所以"detach 里不调 synthExit"根本挡不住它:回调会经事件间接跑一遍,上层拿到
    // 一次"进程已退出"——而 detach 的全部意义就是"进程没退出,我只是松手"。
    //
    // 今天它打在真空里(网关是在浏览器已断开之后才 detach),但 `?socketSessionKey=`
    // 的复用路径就在本文件的 TODO 里:一旦按它复用同一个 ProcessStream 而不是每次
    // 重开,`exited` 一旦被误置就再也回不去 —— `onExit(cb)` 里 `if (this.exited)
    // cb(null)` 会让下一次重连在附着的瞬间被判死。
    //
    // `exited` 本来就是 synthExit 的幂等锁,置上之后那次由 close 事件引发的
    // synthExit 会在第一行返回,一个回调都不会跑。
    this.exited = true;
    try {
      this.ws.close();
    } catch {
      /* already closing */
    }
  }

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
export class AioExecProcessStream implements ProcessStream {
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

  /**
   * 一次性 exec 没有可保活的会话:命令要么已 settle、要么还在跑而调用方不再要结果。
   * 两种情况都只是**放开回调**,同样一个字节都不往对面写。
   */
  detach(): void {
    this.dataCbs.length = 0;
    this.exitCbs.length = 0;
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
