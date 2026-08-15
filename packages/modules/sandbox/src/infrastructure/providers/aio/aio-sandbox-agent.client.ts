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
 *   tty:true  → `ws  /v1/shell/ws`   (interactive PTY)
 *   tty:false → `POST /v1/shell/exec` (one-shot, collect stdout to EOF)
 *
 * `baseHttpUrl` is the agent's reachable HTTP origin (e.g. http://127.0.0.1:55000
 * when the container port is loopback-published, or http://<container-ip>:8080 on
 * a shared docker network). The internal AIO `session_id` is held here and NEVER
 * surfaced — the only session identifier the frontend sees is the gateway's
 * server-generated `socketSessionKey`.
 */
export class AioSandboxAgentClient {
  constructor(private readonly baseHttpUrl: string) {}

  private wsUrl(): string {
    return `${this.baseHttpUrl.replace(/^http/i, 'ws')}/v1/shell/ws`;
  }

  /** Interactive terminal over the AIO shell websocket. */
  async openTerminal(cols: number, rows: number): Promise<ProcessStream> {
    const ws = new WebSocket(this.wsUrl());
    await this.awaitOpen(ws);
    // seed the initial window size (AIO `resize` mapping); the shell PTY is spawned
    // by the agent on connect, so no explicit "start" frame is required.
    this.safeSend(ws, { type: 'resize', data: { cols, rows } });
    return new AioWsProcessStream(ws);
  }

  /** One-shot command; collects combined output then synthesises exit (04 §2.3). */
  async exec(spec: ProcessSpec): Promise<ProcessStream> {
    // The AIO agent's /v1/shell/exec runs a SHELL command STRING, but the neutral
    // contract passes an argv array meant for direct execution (docker exec runs it
    // without a shell). Shell-quote every element so the agent's shell reconstructs
    // the exact argv — otherwise args like `-c 'echo x'` get word-split.
    const command = spec.cmd.map(shellQuote).join(' ');
    const resultPromise = this.postExec(command);
    return new AioExecProcessStream(resultPromise);
  }

  private async postExec(command: string): Promise<{ output: string; code: number | null }> {
    let res: Response;
    try {
      res = await fetch(`${this.baseHttpUrl}/v1/shell/exec`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ command }),
      });
    } catch (e) {
      throw new SandboxProviderError(
        SandboxProviderErrorCode.PROVIDER_UNAVAILABLE,
        `AIO agent exec unreachable: ${(e as Error).message}`,
        e,
        true,
      );
    }
    if (!res.ok) {
      throw new SandboxProviderError(
        SandboxProviderErrorCode.INTERNAL,
        `AIO agent exec failed: HTTP ${res.status}`,
      );
    }
    const body = (await res.json()) as AioExecResponse;
    const data = body.data ?? {};
    const output = typeof data.output === 'string' ? data.output : '';
    const code = typeof data.exit_code === 'number' ? data.exit_code : null;
    return { output, code };
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

/** POSIX single-quote a shell word so the agent's shell preserves it verbatim. */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

interface AioExecResponse {
  data?: { output?: unknown; exit_code?: unknown };
}

/** AIO shell-websocket frames (server → client). */
type AioServerFrame =
  | { type: 'output'; data: string }
  | { type: 'ping' }
  | { type: 'session_id'; data: string }
  | { type: 'ready'; data: string }
  | { type: string; data?: unknown };

/** Wraps the AIO shell websocket as the neutral ProcessStream (mapping per ADR). */
class AioWsProcessStream implements ProcessStream {
  readonly ref: string;
  private readonly dataCbs: ((chunk: Buffer) => void)[] = [];
  private readonly exitCbs: ((code: number | null) => void)[] = [];
  private exited = false;

  constructor(private readonly ws: WebSocket) {
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

  async kill(): Promise<void> {
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
  private settled = false;
  private output: Buffer | null = null;
  private code: number | null = null;

  constructor(result: Promise<{ output: string; code: number | null }>) {
    result
      .then(({ output, code }) => this.settle(Buffer.from(output, 'utf8'), code))
      .catch(() => this.settle(Buffer.from(''), null));
  }

  private settle(output: Buffer, code: number | null): void {
    this.settled = true;
    this.output = output;
    this.code = code;
    for (const cb of this.dataCbs) cb(output);
    for (const cb of this.exitCbs) cb(code);
  }

  onData(cb: (chunk: Buffer) => void): void {
    this.dataCbs.push(cb);
    if (this.settled && this.output) cb(this.output);
  }

  write(): void {
    /* one-shot exec has no stdin uplink */
  }

  resize(): void {
    /* not a pty */
  }

  onExit(cb: (code: number | null) => void): void {
    this.exitCbs.push(cb);
    if (this.settled) cb(this.code);
  }

  async kill(): Promise<void> {
    this.settle(this.output ?? Buffer.from(''), this.code);
  }
}
