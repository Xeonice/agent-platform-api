import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AioSandboxAgentClient,
  KILL_GRACE_MS,
} from '../../src/infrastructure/providers/aio/aio-sandbox-agent.client';

/**
 * The JOB plane and the FILE plane (04 §2.6), driven against a FAKE in-sandbox agent
 * that records the exact wire bodies.
 *
 * What only a fake can prove cheaply — and what a real-container e2e would take
 * minutes to show — is the set of rules whose violation is SILENT until much later:
 *
 *   ① the session is created BEFORE the command and the socket attaches LAST. Get this
 *      backwards and nothing fails until the first platform restart, at which point
 *      running jobs die because the socket closes the session it created (04 §2.6 ★★).
 *   ② the cursor stops at a LINE BOUNDARY. A half line handed to `parseOutput` is an
 *      unparseable fragment, and the tail must be re-readable after a crash.
 *   ③ `releaseJob` closes the session and `killJob` does NOT — closing destroys the
 *      recorded output, which is exactly what a caller wants to read after a kill.
 *   ④ a missing file is `null` through BOTH of the agent's contradictory conventions.
 *
 * The real-container proof of the same plane is
 * apps/api/test/e2e/agent-task-job-plane.e2e-spec.ts.
 */
interface Recorded {
  path: string;
  body: Record<string, unknown>;
}

/** The scripted state of the one job the fake agent is running. */
class FakeJobState {
  stdout = '';
  status: 'running' | 'completed' | 'timed_out' = 'running';
  exitCode: number | null = null;
  /** Signals delivered through `/v1/bash/kill`, in order. */
  readonly signals: string[] = [];
  /** Whether a SIGTERM should actually stop it (false ⇒ escalation is required). */
  ignoresTerm = false;
}

class FakeAgent {
  readonly calls: Recorded[] = [];
  readonly job = new FakeJobState();
  readonly files = new Map<string, Buffer>();
  /** Files that answer with the agent's OTHER not-found convention (200 + envelope). */
  readonly softMissing = new Set<string>();
  /** Raw rows `/v1/file/list` should answer with (agent-shaped, not normalised). */
  listRows: Record<string, unknown>[] = [];
  /** Simulate an agent build that accepts an async exec but returns no command_id. */
  omitCommandId = false;
  /** What `${BASH_SESSION_TIMEOUT-}` prints inside the session ('' ⇒ unset). */
  sessionTtlEnv = String(24 * 60 * 60);
  private server!: Server;
  private port = 0;

  async start(): Promise<void> {
    this.server = createServer((req, res) => this.handle(req, res));
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    const addr = this.server.address();
    this.port = typeof addr === 'object' && addr ? addr.port : 0;
  }

  async stop(): Promise<void> {
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  get base(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  pathsCalled(): string[] {
    return this.calls.map((c) => c.path.split('?')[0]);
  }

  bodyFor(path: string): Record<string, unknown> | undefined {
    return this.calls.find((c) => c.path.split('?')[0] === path)?.body;
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    let raw = '';
    req.on('data', (c: Buffer) => {
      raw += c.toString('utf8');
    });
    req.on('end', () => {
      const url = req.url ?? '';
      const body: Record<string, unknown> = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      this.calls.push({ path: url, body });
      const json = (payload: unknown, status = 200): void => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      const path = url.split('?')[0];

      if (path === '/v1/bash/sessions/create') return json({ success: true, data: {} });
      if (path.startsWith('/v1/bash/sessions/') && path.endsWith('/close')) {
        return json({ success: true, data: {} });
      }
      if (path === '/v1/bash/exec') {
        // an async start answers immediately with a command_id; a sync one (the mkdir)
        // answers as a finished command.
        if (body.async_mode !== true) {
          const command = String(body.command ?? '');
          // the survival probe writes to a FILE (its stdout would otherwise be replayed
          // to the pump as the job's own first bytes) — emulate the redirect.
          const redirect = /BASH_SESSION_TIMEOUT.*> '([^']+)'/.exec(command);
          if (redirect) this.files.set(redirect[1], Buffer.from(this.sessionTtlEnv, 'utf8'));
          return json({ success: true, data: { status: 'completed', stdout: '', exit_code: 0 } });
        }
        return json({
          success: true,
          data: this.omitCommandId
            ? { status: 'running' }
            : { command_id: 'cmd-1', status: 'running' },
        });
      }
      if (path === '/v1/bash/output') {
        const offset = Number(body.offset ?? 0);
        const buf = Buffer.from(this.job.stdout, 'utf8');
        const slice = offset >= buf.length ? '' : buf.subarray(offset).toString('utf8');
        return json({
          success: true,
          data: {
            stdout: slice,
            stderr: '',
            command: { status: this.job.status, exit_code: this.job.exitCode },
          },
        });
      }
      if (path === '/v1/bash/kill') {
        const sig = String(body.signal ?? '');
        this.job.signals.push(sig);
        if (sig === 'SIGKILL' || !this.job.ignoresTerm) {
          this.job.status = 'completed';
          this.job.exitCode = sig === 'SIGKILL' ? -9 : -15;
        }
        return json({ success: true, data: {} });
      }
      if (path === '/v1/file/write') {
        const file = String(body.file ?? '');
        const content = String(body.content ?? '');
        this.files.set(
          file,
          body.encoding === 'base64'
            ? Buffer.from(content, 'base64')
            : Buffer.from(content, 'utf8'),
        );
        return json({ success: true, data: {} });
      }
      if (path === '/v1/file/list') return json({ success: true, data: { files: this.listRows } });
      if (path === '/v1/file/download') {
        const wanted = decodeURIComponent(url.split('path=')[1] ?? '');
        if (this.softMissing.has(wanted)) {
          // the agent's OTHER convention: HTTP 200 with a failure envelope.
          return json({ success: false, error_type: 'not_found', message: 'not found' });
        }
        const buf = this.files.get(wanted);
        if (!buf) {
          res.writeHead(404);
          res.end();
          return;
        }
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        res.end(buf);
        return;
      }
      json({ success: false, message: `unhandled ${url}` }, 404);
    });
  }
}

let agent: FakeAgent;
let client: AioSandboxAgentClient;

beforeEach(async () => {
  agent = new FakeAgent();
  await agent.start();
  // no token ⇒ no ws ticket is minted, so `readJob` takes the HTTP long-poll fallback.
  // That is the path this file exercises; the socket path is covered by the e2e.
  client = new AioSandboxAgentClient(agent.base);
});

afterEach(async () => {
  await agent.stop();
});

describe('startJob — the ordering that only breaks after a restart (04 §2.6 ★★)', () => {
  it('creates the session BEFORE starting the command', async () => {
    await client.startJob({ cmd: ['codex', 'exec', '--json', 'go'] });
    const paths = agent.pathsCalled();
    const created = paths.indexOf('/v1/bash/sessions/create');
    const started = paths.lastIndexOf('/v1/bash/exec');
    expect(created).toBeGreaterThanOrEqual(0);
    expect(created).toBeLessThan(started);
  });

  it('starts ASYNC and passes the hard timeout in seconds', async () => {
    await client.startJob({ cmd: ['sleep', '9'], timeoutMs: 30_000 });
    const start = agent.calls.filter((c) => c.path === '/v1/bash/exec').at(-1)!;
    expect(start.body.async_mode).toBe(true);
    expect(start.body.hard_timeout).toBe(30);
  });

  it('redirects stderr into a sandbox FILE — the socket never carries stderr', async () => {
    await client.startJob({ cmd: ['codex', 'exec'] });
    const start = agent.calls.filter((c) => c.path === '/v1/bash/exec').at(-1)!;
    expect(String(start.body.command)).toMatch(/2> '\/tmp\/\.platform-job-[0-9a-f]{32}\/stderr'/);
  });

  it('stdin travels in a BODY; only the PATH is ever in argv (05 §7 #3)', async () => {
    const secret = 'sk-live-DO-NOT-LEAK-`whoami`';
    await client.startJob({ cmd: ['claude', '-p'], stdin: secret });
    const start = agent.calls.filter((c) => c.path === '/v1/bash/exec').at(-1)!;
    expect(String(start.body.command)).not.toContain(secret);
    expect(String(start.body.command)).toMatch(/< '\/tmp\/\.platform-job-[0-9a-f]{32}\/stdin'/);
    expect([...agent.files.values()].some((b) => b.toString('utf8') === secret)).toBe(true);
  });

  it('REFUSES a tier the sandbox-side session TTL cannot outlive (生存义务)', async () => {
    // ⚠️ THE PRE-S6 SANDBOX. `BASH_SESSION_TIMEOUT` is injected at CREATE time, so a
    // sandbox created before the survival obligation existed runs on the agent's 3600s
    // default — and that reaper fires on IDLE, is refreshed only by SUBMITTING a
    // command (never by reading output), and does not check whether the command is
    // still running. A 4-hour tier there is destroyed at the 1-hour mark together with
    // its output and its exit code, and the first sign of it is a 404 hours later.
    agent.sessionTtlEnv = ''; // unset ⇒ the agent's own 3600s default
    await expect(
      client.startJob({ cmd: ['codex', 'exec'], timeoutMs: 4 * 60 * 60_000 }),
    ).rejects.toThrow(/生存义务|reaps idle sessions/);

    // the 30-minute tier still fits inside the default, so it is NOT refused.
    await expect(
      client.startJob({ cmd: ['codex', 'exec'], timeoutMs: 30 * 60_000 }),
    ).resolves.toBeTruthy();
  });

  it('a sandbox carrying the survival env accepts the longest tier', async () => {
    agent.sessionTtlEnv = String(24 * 60 * 60);
    await expect(
      client.startJob({ cmd: ['codex', 'exec'], timeoutMs: 4 * 60 * 60_000 }),
    ).resolves.toBeTruthy();
  });

  it('a start that yields no command_id fails LOUDLY rather than returning a dead handle', async () => {
    // A handle with no command to point at would look fine until the first read, and
    // by then the job is running with nothing able to reach it.
    agent.omitCommandId = true;
    await expect(client.startJob({ cmd: ['codex'] })).rejects.toThrow(/command_id/);
  });
});

describe('readJob — cursor semantics (04 §2.6 裁决 2 + 半行缓冲)', () => {
  it('holds back a HALF LINE and does not advance the cursor past it', async () => {
    const jobId = await client.startJob({ cmd: ['codex'] });
    agent.job.stdout = '{"type":"turn.started"}\n{"type":"item.st';

    const first = await client.readJob(jobId);
    expect(first.stdout).toBe('{"type":"turn.started"}\n');
    expect(first.status).toBe('running');

    // the fragment arrives complete on the next read, from the SAME cursor.
    agent.job.stdout += 'arted"}\n';
    const second = await client.readJob(jobId, first.cursor);
    expect(second.stdout).toBe('{"type":"item.started"}\n');
  });

  it('a chunk with NO newline at all yields nothing and leaves the cursor put', async () => {
    const jobId = await client.startJob({ cmd: ['codex'] });
    agent.job.stdout = 'partial';
    const chunk = await client.readJob(jobId);
    expect(chunk.stdout).toBe('');
    // reading again from the returned cursor must still see the fragment later.
    agent.job.stdout += ' line\n';
    expect((await client.readJob(jobId, chunk.cursor)).stdout).toBe('partial line\n');
  });

  it('SPENDS the long-poll budget on a half line instead of answering instantly', async () => {
    // ⚠️ THE REGRESSION THIS PINS. A half line makes the agent's `stdout` NON-EMPTY
    // while the delivered chunk is '' and the cursor does not move. A read that tested
    // byte-emptiness therefore skipped the wait and returned immediately, and the pump's
    // `for(;;)` span straight back into it — measured at ~150k reads/second, each one a
    // POST /v1/bash/output plus a whole-file stderr download. Asserting the RETURN VALUE
    // alone cannot see that: the empty chunk is correct either way. What distinguishes
    // the two is whether the budget was SPENT.
    const jobId = await client.startJob({ cmd: ['codex'] });
    agent.job.stdout = '{"type":"item.st';
    const before = agent.calls.filter((c) => c.path === '/v1/bash/output').length;

    const chunk = await client.readJob(jobId, undefined, 1_000);

    expect(chunk.stdout).toBe('');
    const reads = agent.calls.filter((c) => c.path === '/v1/bash/output').slice(before);
    // no ws ticket in this fixture ⇒ the HTTP long-poll fallback, which is visible on
    // the wire as `wait: true` + a `wait_timeout` in seconds.
    expect(reads.some((r) => r.body.wait === true && r.body.wait_timeout === 1)).toBe(true);
  });

  it('does NOT long-poll when a whole line is already deliverable', async () => {
    // the other half of the same rule: a budget must not be spent when there is
    // something to hand over, or every event would be delayed by the poll interval.
    const jobId = await client.startJob({ cmd: ['codex'] });
    agent.job.stdout = '{"type":"turn.started"}\n{"type":"item.st';
    const before = agent.calls.filter((c) => c.path === '/v1/bash/output').length;

    const chunk = await client.readJob(jobId, undefined, 1_000);

    expect(chunk.stdout).toBe('{"type":"turn.started"}\n');
    const reads = agent.calls.filter((c) => c.path === '/v1/bash/output').slice(before);
    expect(reads.every((r) => r.body.wait === undefined)).toBe(true);
  });

  it('FLUSHES the final unterminated line once the job has exited', async () => {
    const jobId = await client.startJob({ cmd: ['codex'] });
    agent.job.stdout = 'no trailing newline';
    agent.job.status = 'completed';
    agent.job.exitCode = 0;
    const chunk = await client.readJob(jobId);
    expect(chunk.stdout).toBe('no trailing newline');
    expect(chunk.status).toBe('exited');
    expect(chunk.exitCode).toBe(0);
  });

  it('the cursor is OPAQUE — a caller cannot do arithmetic on it', async () => {
    const jobId = await client.startJob({ cmd: ['codex'] });
    agent.job.stdout = 'a\n';
    const chunk = await client.readJob(jobId);
    expect(typeof chunk.cursor).toBe('string');
    expect(Number.isFinite(Number(chunk.cursor))).toBe(false);
  });

  it('reports the sandbox-side hard timeout as exit 124 (03 §8.3 口径)', async () => {
    const jobId = await client.startJob({ cmd: ['sleep', '99'], timeoutMs: 1_000 });
    agent.job.status = 'timed_out';
    agent.job.exitCode = -1; // what the agent itself reports
    const chunk = await client.readJob(jobId);
    expect(chunk.exitCode).toBe(124);
  });

  it('a signal-killed job reports NO exit code rather than a fake one', async () => {
    const jobId = await client.startJob({ cmd: ['sleep', '99'] });
    agent.job.status = 'completed';
    agent.job.exitCode = null;
    const chunk = await client.readJob(jobId);
    expect(chunk.status).toBe('exited');
    expect(chunk.exitCode).toBeUndefined();
  });

  it('a vanished session is a LOUD error, not a silent "nothing new"', async () => {
    const jobId = await client.startJob({ cmd: ['codex'] });
    await agent.stop();
    await expect(client.readJob(jobId)).rejects.toThrow();
  });

  it('reads stderr from the redirect FILE, incrementally', async () => {
    const jobId = await client.startJob({ cmd: ['codex'] });
    const stderrPath = String(
      /2> '([^']+)'/.exec(
        String(agent.calls.filter((c) => c.path === '/v1/bash/exec').at(-1)!.body.command),
      )![1],
    );
    agent.files.set(stderrPath, Buffer.from('WARN one\n', 'utf8'));
    const first = await client.readJob(jobId);
    expect(first.stderr).toBe('WARN one\n');

    agent.files.set(stderrPath, Buffer.from('WARN one\nWARN two\n', 'utf8'));
    const second = await client.readJob(jobId, first.cursor);
    expect(second.stderr).toBe('WARN two\n');
  });
});

describe('killJob / releaseJob — the two must not be conflated', () => {
  it('SIGTERM alone is enough when the process really stops', async () => {
    const jobId = await client.startJob({ cmd: ['sleep', '99'] });
    await client.killJob(jobId);
    expect(agent.job.signals).toEqual(['SIGTERM']);
  });

  it('escalates to SIGKILL when the grace window passes with the job still alive', async () => {
    const jobId = await client.startJob({ cmd: ['sleep', '99'] });
    agent.job.ignoresTerm = true;
    await client.killJob(jobId, undefined, 400);
    expect(agent.job.signals).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('the PRODUCTION grace window is 5s (03 §8.3) — pinned so it cannot drift', () => {
    expect(KILL_GRACE_MS).toBe(5_000);
  });

  it('killJob does NOT close the session — the exit code is read AFTER a kill', async () => {
    const jobId = await client.startJob({ cmd: ['sleep', '99'] });
    await client.killJob(jobId);
    expect(agent.pathsCalled().some((p) => p.endsWith('/close'))).toBe(false);
    // and the output is still readable, which is the whole point.
    agent.job.stdout = 'tail\n';
    expect((await client.readJob(jobId)).stdout).toBe('tail\n');
  });

  it('releaseJob shreds the scratch dir BEFORE closing the session', async () => {
    const jobId = await client.startJob({ cmd: ['codex'], stdin: 'secret' });
    agent.calls.length = 0;
    await client.releaseJob(jobId);
    const paths = agent.pathsCalled();
    const rm = agent.calls.findIndex((c) => String(c.body.command ?? '').startsWith('rm -rf'));
    const close = paths.findIndex((p) => p.endsWith('/close'));
    expect(rm).toBeGreaterThanOrEqual(0);
    expect(close).toBeGreaterThan(rm);
  });
});

describe('file plane — the two normalisations the contract demands', () => {
  it('a missing file is null through BOTH agent conventions (404 and 200+envelope)', async () => {
    expect(await client.readFileBytes('/nope')).toBeNull();
    agent.softMissing.add('/soft-missing');
    expect(await client.readFileBytes('/soft-missing')).toBeNull();
    expect(await client.openFileStream('/nope')).toBeNull();
  });

  it('round-trips BINARY bytes exactly (the text endpoint cannot)', async () => {
    const bytes = Buffer.from([0x00, 0xa3, 0xff, 0x10, 0x80]);
    await client.writeFileContent('/bin.dat', bytes);
    const back = await client.readFileBytes('/bin.dat');
    expect(back).not.toBeNull();
    expect(Buffer.compare(back!, bytes)).toBe(0);
    // and it travelled base64-encoded in a BODY, never through a command string.
    expect(agent.bodyFor('/v1/file/write')?.encoding).toBe('base64');
  });

  it('normalises the agent encodings: null size for dirs, epoch-string mtime → ISO', async () => {
    agent.listRows = [
      { name: 'out', path: '/w/out', is_directory: true, size: null, modified_time: '1787396751' },
      {
        name: 'report.md',
        path: '/w/out/report.md',
        is_directory: false,
        size: 42,
        modified_time: '1787396751',
      },
    ];
    const entries = await client.listFiles('/w', { recursive: true });
    expect(entries).toEqual([
      { path: '/w/out', kind: 'dir', modifiedAt: '2026-08-22T11:05:51.000Z' },
      { path: '/w/out/report.md', kind: 'file', size: 42, modifiedAt: '2026-08-22T11:05:51.000Z' },
    ]);
    // `size` is ABSENT for the directory, not 0 — a 0 would read as "an empty dir".
    expect('size' in entries[0]).toBe(false);
  });

  it('caps the listing at maxEntries', async () => {
    agent.listRows = Array.from({ length: 10 }, (_, i) => ({
      path: `/w/f${i}`,
      is_directory: false,
      size: 1,
      modified_time: '1787396751',
    }));
    expect(await client.listFiles('/w', { maxEntries: 3 })).toHaveLength(3);
  });
});
