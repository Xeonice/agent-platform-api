import { createServer, type Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SandboxProviderError, SandboxProviderErrorCode } from '@platform/contracts';
import type { ProcessStream } from '@platform/contracts';
import {
  AioSandboxAgentClient,
  AioWsProcessStream,
  shellQuote,
  toAgentSignal,
  wrapWithStdin,
} from '../../src/infrastructure/providers/aio/aio-sandbox-agent.client';
import type { PtySocket } from '../../src/infrastructure/providers/aio/aio-sandbox-agent.client';

/** ETX — what a terminal sends for Ctrl-C; the tty turns it into SIGINT. */
const ETX = '\u0003';

/**
 * Data-plane exec contract for the in-sandbox AIO agent, driven against a FAKE
 * agent server that records the exact wire bodies. It pins the two things a real
 * container e2e cannot show cheaply:
 *   ① every ProcessSpec field actually reaches the agent (no silent drop — the
 *      regression that made `codex login --with-access-token` a no-op);
 *   ② the stdin payload NEVER appears in the `command` string, i.e. never in the
 *      sandbox's `/proc/<pid>/cmdline` (RA-14 密钥禁进 argv).
 * The real-container proof is apps/api/test/e2e/aio-exec-capabilities.e2e-spec.ts.
 */
interface Recorded {
  path: string;
  body: Record<string, unknown>;
}

/** Scripted reply for /v1/bash/exec, keyed by call order. */
type ExecReply = {
  status?: string;
  stdout?: string | null;
  stderr?: string | null;
  exit_code?: number | null;
  /** hold the response open until `release()` is called (simulates a long command) */
  hold?: boolean;
  /** answer with an agent-side failure envelope */
  fail?: boolean;
};

class FakeAgent {
  readonly calls: Recorded[] = [];
  private server!: Server;
  private port = 0;
  private replies: ExecReply[] = [];
  private pending: (() => void)[] = [];

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c: Buffer) => {
        raw += c.toString('utf8');
      });
      req.on('end', () => {
        const body: Record<string, unknown> = raw ? JSON.parse(raw) : {};
        this.calls.push({ path: req.url ?? '', body });
        const send = (payload: unknown): void => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(payload));
        };
        if (req.url === '/v1/bash/exec') {
          const reply = this.replies.shift() ?? { status: 'completed', stdout: '', exit_code: 0 };
          const finish = (): void => {
            if (reply.fail) {
              res.writeHead(400, { 'content-type': 'application/json' });
              res.end(JSON.stringify({ success: false, message: 'boom', data: null }));
              return;
            }
            send({
              success: true,
              message: 'ok',
              data: { status: reply.status ?? 'completed', ...reply },
            });
          };
          if (reply.hold) this.pending.push(finish);
          else finish();
          return;
        }
        send({ success: true, message: 'ok', data: null });
      });
    });
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    const addr = this.server.address();
    this.port = typeof addr === 'object' && addr ? addr.port : 0;
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  script(...replies: ExecReply[]): void {
    this.replies.push(...replies);
  }

  /** Complete the currently held /v1/bash/exec response. */
  release(): void {
    const f = this.pending.shift();
    if (f) f();
  }

  callsTo(path: string): Recorded[] {
    return this.calls.filter((c) => c.path === path);
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

function collect(stream: ProcessStream): Promise<{ out: string; code: number | null }> {
  return new Promise((resolve) => {
    let out = '';
    stream.onData((c) => {
      out += c.toString('utf8');
    });
    stream.onExit((code) => resolve({ out, code }));
  });
}

describe('shellQuote / wrapWithStdin — 转义与注入边界', () => {
  it.each([
    ['plain', 'plain'],
    ['with space', 'with space'],
    ["it's", "it's"],
    ['$HOME', '$HOME'],
    ['`id`', '`id`'],
    ['a"b', 'a"b'],
    ['line1\nline2', 'line1\nline2'],
    ['a;rm -rf /', 'a;rm -rf /'],
    ['a|b&&c', 'a|b&&c'],
    ['${X}', '${X}'],
    ['\\', '\\'],
  ])('quotes %j so a POSIX shell yields it back verbatim', (input) => {
    const quoted = shellQuote(input);
    // POSIX single-quoting: the result is a concatenation of literal chunks and
    // escaped quotes, so re-parsing it can only ever produce the original word.
    expect(quoted.startsWith("'")).toBe(true);
    expect(quoted.endsWith("'")).toBe(true);
    // Every embedded quote must be closed-escaped-reopened, never left bare.
    const inner = quoted.slice(1, -1);
    expect(inner.replace(/'\\''/g, '\u0000')).not.toContain("'");
    expect(inner.replace(/'\\''/g, "'")).toBe(input);
  });

  it('never leaves the stdin payload in the command string', () => {
    const wrapped = wrapWithStdin(shellQuote('cat'), '/tmp/x/stdin', '/tmp/x');
    expect(wrapped).toContain("'/tmp/x/stdin'");
    expect(wrapped).toContain("rm -rf -- '/tmp/x'");
    expect(wrapped).toContain('exit $__platform_rc');
  });

  it('maps signals onto the three the agent accepts', () => {
    expect(toAgentSignal()).toBe('SIGTERM');
    expect(toAgentSignal('SIGTERM')).toBe('SIGTERM');
    expect(toAgentSignal('SIGKILL')).toBe('SIGKILL');
    expect(toAgentSignal('SIGINT')).toBe('SIGINT');
    expect(toAgentSignal('SIGHUP')).toBe('SIGTERM');
  });
});

describe('AioSandboxAgentClient.exec — ProcessSpec 字段透传', () => {
  let agent: FakeAgent;
  let client: AioSandboxAgentClient;

  beforeEach(async () => {
    agent = new FakeAgent();
    await agent.start();
    client = new AioSandboxAgentClient(agent.baseUrl);
  });
  afterEach(async () => {
    await agent.stop();
  });

  it('argv is shell-quoted and env / cwd / timeout ride the agent request natively', async () => {
    agent.script({ stdout: 'out', stderr: 'err', exit_code: 0 });
    const stream = await client.exec({
      cmd: ['sh', '-c', 'echo "x y"'],
      tty: false,
      env: { A: "it's $HOME\n`id`" },
      cwd: '/workspace',
      timeoutMs: 30_000,
    });
    const { out, code } = await collect(stream);
    expect(out).toBe('outerr');
    expect(code).toBe(0);

    const exec = agent.callsTo('/v1/bash/exec')[0];
    expect(exec.body.command).toBe(`'sh' '-c' 'echo "x y"'`);
    expect(exec.body.exec_dir).toBe('/workspace');
    // env goes VERBATIM — the agent injects it itself, we never re-quote it.
    expect(exec.body.env).toEqual({ A: "it's $HOME\n`id`" });
    expect(exec.body.hard_timeout).toBe(30);
  });

  it('omits the fields the caller did not set (no phantom cwd/env/timeout)', async () => {
    agent.script({ stdout: '', exit_code: 0 });
    await collect(await client.exec({ cmd: ['true'], tty: false }));
    const exec = agent.callsTo('/v1/bash/exec')[0];
    expect(exec.body.exec_dir).toBeUndefined();
    expect(exec.body.env).toBeUndefined();
    expect(exec.body.hard_timeout).toBeUndefined();
  });

  it('reports the agent hard-timeout kill as exit 124 (03 §8.3 vocabulary)', async () => {
    agent.script({ status: 'timed_out', stdout: 'partial', exit_code: -1 });
    const { code } = await collect(
      await client.exec({ cmd: ['sleep', '99'], tty: false, timeoutMs: 1000 }),
    );
    expect(code).toBe(124);
  });

  it('closes the agent-side session so one-shot execs do not accumulate state', async () => {
    agent.script({ stdout: '', exit_code: 0 });
    await collect(await client.exec({ cmd: ['true'], tty: false }));
    const closes = agent.calls.filter((c) => c.path.endsWith('/close'));
    expect(closes).toHaveLength(1);
    const sessionId = agent.callsTo('/v1/bash/exec')[0].body.session_id;
    expect(closes[0].path).toBe(`/v1/bash/sessions/${String(sessionId)}/close`);
  });

  it('rejects ProcessSpec.user instead of silently dropping it', async () => {
    await expect(client.exec({ cmd: ['id'], tty: false, user: 'root' })).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof SandboxProviderError &&
        e.code === SandboxProviderErrorCode.UNSUPPORTED_CAPABILITY,
    );
  });
});

describe('AioSandboxAgentClient.exec — stdin 绝不进 argv (RA-14)', () => {
  let agent: FakeAgent;
  let client: AioSandboxAgentClient;
  const SECRET = 'sk-live-TOP$ECRET\n`whoami`\n';

  beforeEach(async () => {
    agent = new FakeAgent();
    await agent.start();
    client = new AioSandboxAgentClient(agent.baseUrl);
  });
  afterEach(async () => {
    await agent.stop();
  });

  it('ships stdin in an HTTP body and redirects a 0700 scratch file into fd 0', async () => {
    agent.script(
      { stdout: '', exit_code: 0 }, // mkdir
      { stdout: 'logged in', exit_code: 0 }, // the real command
    );
    const { out, code } = await collect(
      await client.exec({
        cmd: ['codex', 'login', '--with-access-token'],
        tty: false,
        stdin: SECRET,
      }),
    );
    expect(out).toBe('logged in');
    expect(code).toBe(0);

    // ① the payload travelled in the file-write BODY, not a command
    const write = agent.callsTo('/v1/file/write')[0];
    expect(write.body.content).toBe(SECRET);
    const file = String(write.body.file);
    expect(file).toMatch(/^\/tmp\/\.platform-stdin-[0-9a-f]{32}\/stdin$/);

    // ② the scratch dir is created 0700 and non-clobbering BEFORE the write
    const mkdir = String(agent.callsTo('/v1/bash/exec')[0].body.command);
    expect(mkdir).toMatch(/^mkdir -m 700 -- '\/tmp\/\.platform-stdin-[0-9a-f]{32}'$/);

    // ③ NO command string anywhere carries the secret — this is the ps/argv leak
    for (const call of agent.calls) {
      expect(JSON.stringify(call.body.command ?? '')).not.toContain('TOP$ECRET');
    }
    const run = String(agent.callsTo('/v1/bash/exec')[1].body.command);
    expect(run).toContain(`'codex' 'login' '--with-access-token' < '${file}'`);
  });

  it('shreds the scratch dir even when the command itself fails', async () => {
    agent.script(
      { stdout: '', exit_code: 0 }, // mkdir
      { fail: true }, // the real command — agent-side failure
    );
    const { code } = await collect(
      await client.exec({ cmd: ['codex'], tty: false, stdin: SECRET }),
    );
    expect(code).toBeNull();

    const dir = String(agent.callsTo('/v1/file/write')[0].body.file).replace(/\/stdin$/, '');
    const cleanup = agent
      .callsTo('/v1/bash/exec')
      .map((c) => String(c.body.command))
      .filter((c) => c.startsWith('rm -rf --'));
    expect(cleanup).toEqual([`rm -rf -- '${dir}'`]);
  });
});

describe('AioExecProcessStream.kill — 真杀 (SIGTERM → 宽限 → SIGKILL)', () => {
  let agent: FakeAgent;
  let client: AioSandboxAgentClient;

  beforeEach(async () => {
    agent = new FakeAgent();
    await agent.start();
    client = new AioSandboxAgentClient(agent.baseUrl);
  });
  afterEach(async () => {
    await agent.stop();
  });

  it('sends a REAL signal to the agent and settles with the killed exit code', async () => {
    agent.script({ hold: true, stdout: 'partial', exit_code: -15 });
    const stream = await client.exec({ cmd: ['sleep', '60'], tty: false });
    const done = collect(stream);
    // the agent answers the held exec as soon as the signal lands — exactly what
    // the real /v1/bash/kill does (measured: exit_code -15, request unblocks).
    const killed = stream.kill();
    await new Promise((r) => setTimeout(r, 20));
    agent.release();
    await killed;

    const kills = agent.callsTo('/v1/bash/kill');
    expect(kills).toHaveLength(1);
    expect(kills[0].body.signal).toBe('SIGTERM');
    expect(kills[0].body.session_id).toBe(agent.callsTo('/v1/bash/exec')[0].body.session_id);
    await expect(done).resolves.toMatchObject({ code: -15 });
  });

  it('honours an explicit signal without escalating past it', async () => {
    agent.script({ hold: true, exit_code: -9 });
    const stream = await client.exec({ cmd: ['sleep', '60'], tty: false });
    const killed = stream.kill('SIGKILL');
    await new Promise((r) => setTimeout(r, 20));
    agent.release();
    await killed;
    expect(agent.callsTo('/v1/bash/kill').map((c) => c.body.signal)).toEqual(['SIGKILL']);
  });

  it('is a no-op once the command already finished', async () => {
    agent.script({ stdout: 'done', exit_code: 0 });
    const stream = await client.exec({ cmd: ['true'], tty: false });
    await collect(stream);
    await stream.kill();
    expect(agent.callsTo('/v1/bash/kill')).toHaveLength(0);
  });
});

/**
 * PTY teardown. The agent has NO signal API for ws sessions, so the tty itself is
 * the channel: ETX raises SIGINT on the foreground process group, then `exit`
 * ends the interactive shell so it is not leaked. Both verified against the real
 * image in the e2e; here we pin the wire sequence.
 */
describe('AioWsProcessStream.kill — PTY 通过 tty 投递信号', () => {
  class RecordingSocket implements PtySocket {
    readonly sent: string[] = [];
    closed = false;
    private handlers = new Map<string, (arg?: never) => void>();
    addEventListener(type: 'message', cb: (ev: MessageEvent) => void): void;
    addEventListener(type: 'close' | 'error', cb: () => void): void;
    addEventListener(type: string, cb: (ev?: never) => void): void {
      this.handlers.set(type, cb);
    }
    send(data: string): void {
      this.sent.push(data);
    }
    close(): void {
      this.closed = true;
      this.handlers.get('close')?.();
    }
  }

  const inputs = (sock: RecordingSocket): string[] =>
    sock.sent
      .map((s) => JSON.parse(s))
      .filter((f) => f.type === 'input')
      .map((f) => f.data);

  it('interrupts the foreground job then ends the shell, and closes the socket', async () => {
    const sock = new RecordingSocket();
    const stream = new AioWsProcessStream(sock);
    const exit = new Promise<number | null>((r) => stream.onExit(r));
    await stream.kill();
    expect(inputs(sock)).toEqual([ETX, 'exit\n']);
    expect(sock.closed).toBe(true);
    await expect(exit).resolves.toBeNull();
  });

  it('SIGINT stops at the interrupt — the shell is left alive', async () => {
    const sock = new RecordingSocket();
    await new AioWsProcessStream(sock).kill('SIGINT');
    expect(inputs(sock)).toEqual([ETX]);
  });

  it('synthesises exit exactly once even if the socket closes again', async () => {
    const sock = new RecordingSocket();
    const stream = new AioWsProcessStream(sock);
    let exits = 0;
    stream.onExit(() => {
      exits += 1;
    });
    await stream.kill();
    sock.close();
    expect(exits).toBe(1);
  });
});
