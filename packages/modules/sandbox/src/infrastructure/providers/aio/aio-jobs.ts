import { randomBytes } from 'node:crypto';
import {
  SandboxProviderError,
  SandboxProviderErrorCode,
  type JobChunk,
  type JobCursor,
  type JobSpec,
  type JobStatus,
} from '@platform/contracts';
import {
  AGENT_HTTP_TIMEOUT_MS,
  jobExitCodeOf,
  readEnvelope,
  shellQuote,
  type AioAgentHttp,
} from './aio-http';
import { readFileBytes, writeFileContent } from './aio-files';
import { toAgentSignal, KILL_GRACE_MS } from './aio-process.stream';

/**
 * 作业面（04 §2.6 `SandboxJobs`）—— headless Task 的那条路。
 *
 * ⚠️ **本文件里的顺序不是细节，是实现本身**，而且它的违反是**静默**的：错了之后
 * 什么都不会失败，直到**第一次平台重启**，那时所有在跑的 job 一起无声死亡。守卫在
 * `packages/modules/sandbox/test/unit/aio-agent-jobs.spec.ts`（2026-08-29 补齐了
 * 「socket 最后才 attach」那半条 —— 在那之前它只活在注释里，四种改法全都不会红）。
 *
 * ⚠️ 与 `boxlite-jobs.ts` 对称，但 **boxlite 是自己搭出来的、aio 是原生的**：
 * boxlite 用 `setsid` + 输出文件 + 自建字节游标模拟出「可断点续读的长作业」，
 * 而 aio 的 `/v1/bash/output` 原生就给 `offset` / `stderr_offset` 双游标与
 * `wait`/`wait_timeout` 长轮询。两边的 `JobCursor` 形状因此对得上。
 */

/**
 * What the agent falls back to when `BASH_SESSION_TIMEOUT` is unset — measured, and
 * documented in `agent-auth.ts`. An ABSENT variable therefore means 3600s, not
 * "unlimited", which is why `assertSurvivesTheJob` treats the two identically.
 */
const AGENT_DEFAULT_SESSION_TTL_SECONDS = 3600;

/**
 * 等 job socket 打开。
 *
 * ⚠️ 与 `aio-guest-shell.ts` 里那个**故意不共用**：这一个失败时**返回 null 让调用方
 * 退回 agent 原生长轮询**（socket 只是唤醒通道，拿不到不影响正确性）；shell 那一个
 * 失败必须**抛**（拿不到 pty 就是拿不到终端）。把两者合成一个「可选抛」的函数，等于
 * 让一个参数决定「这次失败要不要紧」——而那正是最容易被下一个调用方填错的那种参数。
 */
function awaitJobSocketOpen(ws: WebSocket, url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      ws.removeEventListener('open', onOpen);
      ws.removeEventListener('error', onError);
    };
    const onOpen = (): void => {
      cleanup();
      resolve();
    };
    const onError = (): void => {
      cleanup();
      reject(new Error(`AIO job websocket failed to open at ${url}`));
    };
    ws.addEventListener('open', onOpen);
    ws.addEventListener('error', onError);
  });
}

/** Beat of the kill grace poll (ticks, not a wall clock — 01 §3). */
const KILL_POLL_MS = 250;

/**
 * Start a long-lived job and return the OPAQUE id the platform persists.
 *
 * ⚠️ THE THREE-STEP ORDER IS THE IMPLEMENTATION, NOT A DETAIL (04 §2.6 ★★).
 * The agent's websocket closes the session it CREATED when it disconnects
 * (`if created_by_ws: await manager.close_session(...)`), and closing a session
 * destroys its recorded output AND kills the running command. So:
 *
 *   ① POST /v1/bash/sessions/create   session exists ⇒ created_by_ws = false
 *   ② POST /v1/bash/exec async_mode   the command starts, we get a command_id
 *   ③ ws /v1/bash/ws?session_id=…     ATTACH only — see `ensureJobStream`
 *
 * Written the intuitive way round (connect, then exec) nothing fails until the
 * first platform restart, at which point every running job dies silently.
 *
 * stderr is REDIRECTED into a sandbox file rather than left on the session's own
 * stderr channel, because the streaming socket forwards `result.stdout` ONLY —
 * and on the failure path codex writes ZERO bytes to stdout and puts everything on
 * stderr. A file keeps the two streams separated (which is what lets `parseOutput`
 * stay `JSON.parse`-per-line, 04 §2.6 裁决 3) and, unlike session-held output,
 * SURVIVES `releaseJob`.
 */
export async function startJob(http: AioAgentHttp, spec: JobSpec): Promise<string> {
  const sessionId = `platform-job-${randomBytes(8).toString('hex')}`;
  const scratchDir = `/tmp/.platform-job-${randomBytes(16).toString('hex')}`;
  const stderrPath = `${scratchDir}/stderr`;
  await createBashSession(http, sessionId);
  // `mkdir -m 700` (no -p) is atomic and fails on a pre-existing path, so the
  // scratch dir cannot be squatted before the stdin payload lands in it.
  await http.postBashExec(
    { session_id: sessionId, command: `mkdir -m 700 -- ${shellQuote(scratchDir)}` },
    undefined,
  );
  await assertSurvivesTheJob(http, sessionId, scratchDir, spec.timeoutMs);
  // pre-create the sink so `readJob` can read it before the job has written a byte
  // (a missing file answers 404 ⇒ `null`, which is fine, but this keeps the
  // "file plane returns null" path for genuinely absent artifacts).
  await writeFileContent(http, stderrPath, '');

  let command = `${spec.cmd.map(shellQuote).join(' ')} 2> ${shellQuote(stderrPath)}`;
  if (spec.stdin !== undefined) {
    const stdinPath = `${scratchDir}/stdin`;
    // content travels in an HTTP BODY; only the PATH ever reaches argv, which is
    // world-readable inside the sandbox via `ps` / `/proc/<pid>/cmdline` (05 §7 #3).
    await writeFileContent(http, stdinPath, spec.stdin);
    command = `${command} < ${shellQuote(stdinPath)}`;
  }

  const data = await http.postBashExec(
    {
      session_id: sessionId,
      command,
      exec_dir: spec.cwd,
      env: spec.env,
      async_mode: true,
      hard_timeout: spec.timeoutMs !== undefined ? spec.timeoutMs / 1000 : undefined,
    },
    undefined,
  );
  const commandId = typeof data.command_id === 'string' ? data.command_id : '';
  if (commandId === '') {
    throw new SandboxProviderError(
      SandboxProviderErrorCode.INTERNAL,
      'in-sandbox agent accepted an async exec but returned no command_id',
    );
  }
  return encodeJobId({ sessionId, commandId, stderrPath, scratchDir });
}

/**
 * Read forward from `cursor`. Omitting it reads from the very beginning — refresh
 * recovery, reconnect-after-disconnect and "the platform restarted" are all that,
 * and nothing more.
 *
 * ── WHY THE BYTES COME OFF THE CURSOR READ AND NEVER OFF THE SOCKET ──────────
 * The socket is attached as a WAKEUP channel, not as a data channel. That is a
 * deliberate departure from "read the stream off the ws", and the reason is
 * arithmetic, not taste: the agent's cursor is a BYTE OFFSET, while the socket
 * never reveals the offset at which it attached (it does not replay history —
 * measured: on connect the offset is wherever the stream happens to be). So a byte
 * that arrives on the socket cannot be placed on the same axis as the cursor, and
 * any attempt to splice the two has an unclosable race: the gap read and the first
 * live frame can overlap by an unknown amount. Taking every byte from the cursor
 * read makes BOTH documented gaps — ① between start and attach, ② a disconnect —
 * disappear structurally instead of being patched, and it is ONE code path for
 * both, exactly as 04 §2.6 ★★ requires.
 *
 * What the socket buys is the thing polling cannot: an instant wakeup. A 40-minute
 * task that emits an event every few seconds costs ~2400 empty round-trips at 1s
 * polling; here it costs one read per event. When no socket can be established we
 * fall back to the agent's own `wait`/`wait_timeout` long-poll, so `waitMs` is
 * honoured either way and busy polling never happens.
 *
 * ⚠️ HALF LINES. `offset` counts BYTES, so a read can land mid-line (measured:
 * a 32-byte first line answers offset 32 — nothing rounds to a line). Since the
 * whole point of the plane is that `parseOutput` is `JSON.parse` per line, this
 * method emits only up to the LAST NEWLINE and leaves the cursor there; the tail is
 * re-read next time. The buffering is therefore in the CURSOR, not in memory, which
 * is what makes it survive a platform restart. Once the job has exited the final
 * (possibly unterminated) line is flushed — nothing more is coming to complete it.
 */
export async function readJob(
  http: AioAgentHttp,
  jobId: string,
  cursor?: JobCursor,
  waitMs?: number,
): Promise<JobChunk> {
  const job = decodeJobId(jobId);
  const at = decodeCursor(cursor);
  const budget = waitMs ?? 0;

  let raw = await readBashOutput(http, job, at.stdout, 0);
  // ⚠️ THE TEST IS "IS THERE A DELIVERABLE WHOLE LINE", NOT "ARE THERE BYTES".
  // A half line sitting in the agent's buffer makes `raw.stdout` NON-EMPTY while
  // `trimToLineBoundary` still yields '' and the cursor still does not move — so a
  // byte-emptiness test would skip the wait and hand the pump an empty chunk it
  // instantly re-reads. Measured before the fix: ~150k reads/second, each carrying a
  // POST /v1/bash/output plus a whole-file stderr download.
  if (trimToLineBoundary(raw.stdout, false) === '' && raw.status === 'running' && budget > 0) {
    const stream = await ensureJobStream(http, job.sessionId);
    if (stream) {
      await stream.wait(budget);
      raw = await readBashOutput(http, job, at.stdout, 0);
    } else {
      // no socket ⇒ the agent's native long-poll. This is the branch that makes
      // "never busy poll" TRUE rather than aspirational.
      raw = await readBashOutput(http, job, at.stdout, budget);
    }
  }
  const exited = raw.status === 'exited';
  if (exited) closeJobStream(streamKey(http, job.sessionId));

  const stdout = trimToLineBoundary(raw.stdout, exited);
  const stderr = await readStderrIncrement(http, job.stderrPath, at.stderr);
  return {
    stdout,
    stderr: stderr.text,
    cursor: encodeCursor({
      stdout: at.stdout + Buffer.byteLength(stdout, 'utf8'),
      stderr: stderr.next,
    }),
    status: raw.status,
    ...(raw.exitCode !== undefined ? { exitCode: raw.exitCode } : {}),
  };
}

/**
 * Two-phase kill (03 §8.3): SIGTERM → 5s grace → SIGKILL. An explicit signal is
 * delivered as asked and still escalates unless it already was SIGKILL.
 *
 * It deliberately does NOT release the job: the exit code and the tail of the
 * output are exactly what a caller wants AFTER killing something, and releasing
 * would destroy both (see `releaseJob`).
 */
export async function killJob(
  http: AioAgentHttp,
  jobId: string,
  signal?: NodeJS.Signals,
  /**
   * The grace window. Parameterised ONLY so the escalation can be proven without a
   * five-second unit test; production always takes the default, and a test pins that
   * the default really is `KILL_GRACE_MS` so nobody can shrink it by accident.
   */
  graceMs: number = KILL_GRACE_MS,
): Promise<void> {
  const job = decodeJobId(jobId);
  const requested = toAgentSignal(signal);
  await http.killSession(job.sessionId, requested);
  if (requested === 'SIGKILL') return;
  if (await waitForExit(http, job, graceMs)) return;
  await http.killSession(job.sessionId, 'SIGKILL');
}

/**
 * Drop the job's server-side state. Idempotent — a released or unknown job is a
 * silent success, same discipline as `destroy`.
 *
 * ⚠️ CALLING THIS EARLY LOSES DATA. Measured: closing the session DESTROYS the
 * recorded output — a later read answers `Session <id> not found`, not an empty
 * chunk. So the platform releases only once it has persisted everything, and
 * `killJob` never releases implicitly. It exists because sessions are server-side
 * state that accumulates: a sandbox running many Tasks would leak one per Task.
 */
export async function releaseJob(http: AioAgentHttp, jobId: string): Promise<void> {
  const job = decodeJobId(jobId);
  closeJobStream(streamKey(http, job.sessionId));
  // shred the scratch dir FIRST: it may hold the job's stdin payload, and after
  // the session is closed there is no longer a shell in which to remove it.
  await http.bestEffort(job.sessionId, `rm -rf -- ${shellQuote(job.scratchDir)}`);
  await http.closeSession(job.sessionId);
}

/**
 * Refuse to start a job the sandbox cannot keep alive long enough to finish.
 *
 * ⚠️ THE OBLIGATION IS SET AT CREATE TIME, SO A SANDBOX CREATED BEFORE S6 DOES NOT
 * HAVE IT. `BASH_SESSION_TIMEOUT` reaps a session on IDLE, the clock is refreshed by
 * SUBMITTING a command and never by reading its output, and the reaper does not check
 * whether the command is still running — so on such a sandbox a 60/120/240-minute
 * tier is destroyed at the agent's 3600-second default, taking the output AND the
 * exit code with it. Nothing else notices: the next read simply 404s, hours in.
 *
 * The env is read from inside the session rather than trusted from the sandbox row,
 * because the row records what the platform ASKED for and this needs what the agent
 * actually BOOTED with. An ABSENT variable is not "unknown" — it is the agent's
 * documented 3600s default, which is exactly the pre-S6 shape being caught here.
 *
 * It costs one synchronous exec per job start, against a run measured in minutes to
 * hours.
 */
async function assertSurvivesTheJob(
  http: AioAgentHttp,
  sessionId: string,
  scratchDir: string,
  timeoutMs?: number,
): Promise<void> {
  if (timeoutMs === undefined) return;
  // ⚠️ THE ANSWER GOES TO A FILE, NOT TO stdout. Measured: `/v1/bash/output` replays
  // the SESSION's recorded output from a byte offset, and a `command_id` does not
  // scope it — so anything this probe printed would be handed to the pump as the
  // job's own first bytes and fed straight into `parseOutput`. The scratch dir is
  // already created, already 0700, and already shredded by `releaseJob`.
  const probePath = `${scratchDir}/session-ttl`;
  const wrote = await http
    .postBashExec(
      {
        session_id: sessionId,
        command: `printf %s "\${BASH_SESSION_TIMEOUT-}" > ${shellQuote(probePath)}`,
      },
      undefined,
    )
    .then(
      () => true,
      () => false,
    );
  // an agent that cannot answer is a problem the first read reports; do not turn an
  // unverifiable answer into a refusal.
  if (!wrote) return;
  const buf = await readFileBytes(http, probePath).catch(() => null);
  if (buf === null) return;
  const raw = buf.toString('utf8').trim();
  const ttlSeconds = raw === '' ? AGENT_DEFAULT_SESSION_TTL_SECONDS : Number(raw);
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) return;
  if (ttlSeconds * 1000 > timeoutMs) return;
  throw new SandboxProviderError(
    SandboxProviderErrorCode.INVALID_STATE,
    `this sandbox's in-sandbox agent reaps idle sessions after ${ttlSeconds}s, which is not ` +
      `longer than the ${Math.round(timeoutMs / 1000)}s this job asked for — the job would be ` +
      'destroyed mid-run together with its output and exit code (04 §2.6 生存义务). The ' +
      'survival env is set at CREATE time, so recreate the sandbox rather than lowering the tier.',
  );
}

/** `POST /v1/bash/sessions/create` — step ① of the ordering above. */
async function createBashSession(http: AioAgentHttp, sessionId: string): Promise<void> {
  const res = await http.post('/v1/bash/sessions/create', { session_id: sessionId });
  const parsed = await readEnvelope(res);
  if (!res.ok || parsed.success === false) {
    throw new SandboxProviderError(
      SandboxProviderErrorCode.INTERNAL,
      `AIO agent could not create a bash session: HTTP ${res.status} ${parsed.message ?? ''}`.trim(),
    );
  }
}

/** `POST /v1/bash/output` — the ONE authoritative byte source for a job. */
async function readBashOutput(
  http: AioAgentHttp,
  job: DecodedJobId,
  offset: number,
  waitMs: number,
): Promise<{ stdout: string; status: JobStatus; exitCode?: number }> {
  const res = await http.post(
    '/v1/bash/output',
    {
      session_id: job.sessionId,
      command_id: job.commandId,
      offset,
      // stderr rides the redirect file, so the session's own stderr channel is empty
      // by construction; asking for it anyway would only cost bytes.
      stderr_offset: 0,
      ...(waitMs > 0 ? { wait: true, wait_timeout: Math.ceil(waitMs / 1000) } : {}),
    },
    // ⚠️ THE ONE CALL THAT MAY LEGITIMATELY HANG, so it gets its OWN deadline rather
    // than the default: it is ASKING the agent to hold the connection for `waitMs`.
    // The slack is what distinguishes "the long poll ran to its budget" from "the
    // agent stopped answering", which is the difference between a pump that keeps
    // going and a 4-hour task whose backstop granularity collapses to undici's
    // 300-second default.
    AbortSignal.timeout(waitMs + AGENT_HTTP_TIMEOUT_MS),
  );
  if (res.status === 404) {
    // the session is gone — the survival obligation was broken (or the job was
    // already released). Louder than an empty chunk on purpose: silently reporting
    // "no new output, still running" would hang the caller forever.
    throw new SandboxProviderError(
      SandboxProviderErrorCode.NOT_FOUND,
      `in-sandbox agent no longer knows job session ${job.sessionId} — its output ` +
        'and exit status are gone (04 §2.6 生存义务)',
    );
  }
  const parsed = await readEnvelope(res);
  if (!res.ok || parsed.success === false) {
    throw new SandboxProviderError(
      SandboxProviderErrorCode.INTERNAL,
      `AIO agent job read failed: HTTP ${res.status} ${parsed.message ?? ''}`.trim(),
    );
  }
  const data = parsed.data ?? {};
  const command = data.command ?? {};
  const running = command.status === undefined ? true : command.status === 'running';
  const exitCode = jobExitCodeOf(command);
  return {
    stdout: data.stdout ?? '',
    status: running ? 'running' : 'exited',
    ...(running || exitCode === undefined ? {} : { exitCode }),
  };
}

/** Poll ONLY the terminal flag, for the kill grace window. Cheap: offset = end. */
async function waitForExit(http: AioAgentHttp, job: DecodedJobId, ms: number): Promise<boolean> {
  const deadlineTicks = Math.max(1, Math.round(ms / KILL_POLL_MS));
  for (let i = 0; i < deadlineTicks; i++) {
    await new Promise((r) => setTimeout(r, KILL_POLL_MS));
    try {
      const r = await readBashOutput(http, job, Number.MAX_SAFE_INTEGER, 0);
      if (r.status === 'exited') return true;
    } catch {
      // session vanished ⇒ nothing left to escalate against
      return true;
    }
  }
  return false;
}

/**
 * The stderr increment, taken from the redirect file through the FILE plane.
 *
 * It reads the whole file and slices from the cursor rather than range-requesting,
 * which is O(n) per read. That is a deliberate trade: on the measured success path
 * stderr is EMPTY for both CLIs, on the failure path it is a handful of tracing
 * lines, and the read is a loopback GET (8 MB in ~36 ms). Slicing whole-file also
 * means no byte can be lost to a partial range — and unlike the session channel,
 * this file still answers after `releaseJob`.
 */
async function readStderrIncrement(
  http: AioAgentHttp,
  path: string,
  from: number,
): Promise<{ text: string; next: number }> {
  const buf = await readFileBytes(http, path);
  if (!buf || buf.length <= from) return { text: '', next: from };
  const slice = buf.subarray(from);
  return { text: slice.toString('utf8'), next: from + slice.length };
}

/**
 * ATTACH to an existing job session — never create one.
 *
 * The `?session_id=` is what makes the agent treat this socket as an attachment
 * (`created_by_ws = false`), so disconnecting leaves the session, its buffered
 * output and the running command untouched. Without it the socket owns the
 * session and closing it destroys the job. Verified end to end: 33-minute run,
 * 100 s of silence × 20 rounds, zero disconnects; three client SIGKILLs left the
 * session and the job alive.
 *
 * Failure to attach is NOT fatal — `readJob` falls back to the agent's own
 * long-poll — so this returns `null` instead of throwing.
 */
async function ensureJobStream(http: AioAgentHttp, sessionId: string): Promise<JobStream | null> {
  const key = streamKey(http, sessionId);
  const existing = jobStreams.get(key);
  if (existing?.alive) return existing;
  try {
    const ticket = http.authenticated ? await http.issueWsTicket() : undefined;
    const base = `${http.baseUrl.replace(/^http/i, 'ws')}/v1/bash/ws`;
    const query = new URLSearchParams({ session_id: sessionId });
    if (ticket !== undefined) query.set('ticket', ticket);
    const url = `${base}?${query.toString()}`;
    const ws = new WebSocket(url);
    await awaitJobSocketOpen(ws, url);
    const stream = new JobStream(ws, key);
    jobStreams.set(key, stream);
    return stream;
  } catch {
    return null;
  }
}

function streamKey(http: AioAgentHttp, sessionId: string): string {
  return `${http.baseUrl}|${sessionId}`;
}

/**
 * What a `JobHandle.jobId` actually carries. The platform NEVER parses it (04 §2.6
 * 裁决 1) — it stores the string and hands it back — so the encoding is free to be
 * whatever this provider needs, as long as it survives a round trip through the
 * database. JSON is chosen over a delimiter because a path can contain anything.
 */
interface DecodedJobId {
  sessionId: string;
  commandId: string;
  stderrPath: string;
  scratchDir: string;
}

function encodeJobId(job: DecodedJobId): string {
  return JSON.stringify({
    s: job.sessionId,
    c: job.commandId,
    e: job.stderrPath,
    d: job.scratchDir,
  });
}

function decodeJobId(jobId: string): DecodedJobId {
  let raw: unknown;
  try {
    raw = JSON.parse(jobId);
  } catch {
    raw = null;
  }
  if (typeof raw !== 'object' || raw === null) {
    throw new SandboxProviderError(
      SandboxProviderErrorCode.INVALID_STATE,
      'job handle was not minted by this provider (unreadable jobId)',
    );
  }
  const o = raw as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  const decoded = {
    sessionId: str(o.s),
    commandId: str(o.c),
    stderrPath: str(o.e),
    scratchDir: str(o.d),
  };
  if (decoded.sessionId === '' || decoded.commandId === '') {
    throw new SandboxProviderError(
      SandboxProviderErrorCode.INVALID_STATE,
      'job handle is missing its session/command identity',
    );
  }
  return decoded;
}

/**
 * The two independent byte offsets a job read carries. Opaque to the platform for the
 * reason 04 §2.6 裁决 2 gives: a byte offset is THIS provider's encoding of "where I
 * left off", another may count lines or frames, and a number on the wire invites
 * arithmetic that breaks on the next provider.
 */
interface DecodedCursor {
  stdout: number;
  stderr: number;
}

function encodeCursor(c: DecodedCursor): JobCursor {
  return JSON.stringify({ o: c.stdout, e: c.stderr });
}

function decodeCursor(cursor?: JobCursor): DecodedCursor {
  if (cursor === undefined || cursor === '') return { stdout: 0, stderr: 0 };
  try {
    const raw: unknown = JSON.parse(cursor);
    if (typeof raw !== 'object' || raw === null) return { stdout: 0, stderr: 0 };
    const o = raw as Record<string, unknown>;
    const num = (v: unknown): number => (typeof v === 'number' && v >= 0 ? v : 0);
    return { stdout: num(o.o), stderr: num(o.e) };
  } catch {
    // An unreadable cursor reads from the START rather than throwing: re-delivering
    // output is recoverable (the platform's own seq de-duplicates), losing the rest
    // of a running job's output is not.
    return { stdout: 0, stderr: 0 };
  }
}

/**
 * Emit only whole lines while the job is alive; flush everything once it has exited.
 *
 * Returning a half line would hand `parseOutput` an unparseable fragment, and there
 * is no in-memory place to keep it that survives a platform restart — so the tail is
 * left BEHIND THE CURSOR and re-read next time instead.
 */
function trimToLineBoundary(s: string, flush: boolean): string {
  if (flush) return s;
  const i = s.lastIndexOf('\n');
  return i < 0 ? '' : s.slice(0, i + 1);
}

/**
 * An ATTACHED job websocket, used purely as a wakeup channel (see `readJob` for why
 * no byte is ever taken off it).
 *
 * It is pooled at MODULE scope rather than per client instance because a fresh
 * `AioSandboxAgentClient` is constructed for every provider call — a per-instance
 * socket would be opened and thrown away on each read, which is strictly worse than
 * the polling it replaces. The pool key includes the agent origin, so two sandboxes
 * can never share an entry, and an entry removes itself the moment the socket dies.
 */
class JobStream {
  alive = true;
  private done = false;
  private readonly waiters: (() => void)[] = [];

  constructor(
    private readonly ws: WebSocket,
    readonly key: string,
  ) {
    ws.addEventListener('message', (ev: MessageEvent) => this.onMessage(ev));
    ws.addEventListener('close', () => this.die());
    ws.addEventListener('error', () => this.die());
  }

  private onMessage(ev: MessageEvent): void {
    const raw = typeof ev.data === 'string' ? ev.data : String(ev.data);
    let frame: { type?: string };
    try {
      frame = JSON.parse(raw) as { type?: string };
    } catch {
      return;
    }
    if (frame.type === 'command_done') this.done = true;
    if (frame.type === 'output' || frame.type === 'command_done') this.wake();
  }

  /** Resolve as soon as the job produced output or finished, else after `ms`. */
  wait(ms: number): Promise<void> {
    if (this.done || !this.alive) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const i = this.waiters.indexOf(onWake);
        if (i >= 0) this.waiters.splice(i, 1);
        resolve();
      }, ms);
      timer.unref?.();
      const onWake = (): void => {
        clearTimeout(timer);
        resolve();
      };
      this.waiters.push(onWake);
    });
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      /* already closing */
    }
    this.die();
  }

  private die(): void {
    if (!this.alive) return;
    this.alive = false;
    if (jobStreams.get(this.key) === this) jobStreams.delete(this.key);
    this.wake();
  }

  private wake(): void {
    for (const w of this.waiters.splice(0)) w();
  }
}

const jobStreams = new Map<string, JobStream>();

function closeJobStream(key: string): void {
  jobStreams.get(key)?.close();
}

/**
 * Drop every attached job socket. Exported for the process-teardown path (and for
 * tests, which must not leave a live socket keeping the event loop busy).
 */
export function closeAllJobStreams(): void {
  for (const stream of [...jobStreams.values()]) stream.close();
}
