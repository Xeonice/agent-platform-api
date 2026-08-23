import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import {
  SandboxProviderError,
  SandboxProviderErrorCode,
  type FileEntry,
  type JobChunk,
  type JobCursor,
  type JobSpec,
  type JobStatus,
  type ProcessSpec,
  type ProcessStream,
} from '@platform/contracts';
import { epochSecondsToIso } from '@platform/shared-kernel';

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
  private async postBashExec(body: BashExecRequest, signal?: AbortSignal): Promise<BashExecResult> {
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
  private async writeFile(file: string, content: string, signal?: AbortSignal): Promise<void> {
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
    return { 'content-type': 'application/json', ...authOnlyHeaders(this.authToken) };
  }

  private async fetchAgent(path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
    try {
      return await fetch(`${this.baseHttpUrl}${path}`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: signal ?? AbortSignal.timeout(AGENT_HTTP_TIMEOUT_MS),
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
    return this.awaitOpenAt(ws, this.wsUrl());
  }

  private awaitOpenAt(ws: WebSocket, url: string): Promise<void> {
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

  private safeSend(ws: WebSocket, frame: unknown): void {
    try {
      ws.send(JSON.stringify(frame));
    } catch {
      /* socket not open — ignore, exit will be synthesised on close */
    }
  }

  // ── 作业面 / job plane (SandboxJobs, 04 §2.6) ────────────────────────────────

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
  async startJob(spec: JobSpec): Promise<string> {
    const sessionId = `platform-job-${randomBytes(8).toString('hex')}`;
    const scratchDir = `/tmp/.platform-job-${randomBytes(16).toString('hex')}`;
    const stderrPath = `${scratchDir}/stderr`;
    await this.createBashSession(sessionId);
    // `mkdir -m 700` (no -p) is atomic and fails on a pre-existing path, so the
    // scratch dir cannot be squatted before the stdin payload lands in it.
    await this.postBashExec(
      { session_id: sessionId, command: `mkdir -m 700 -- ${shellQuote(scratchDir)}` },
      undefined,
    );
    await this.assertSurvivesTheJob(sessionId, scratchDir, spec.timeoutMs);
    // pre-create the sink so `readJob` can read it before the job has written a byte
    // (a missing file answers 404 ⇒ `null`, which is fine, but this keeps the
    // "file plane returns null" path for genuinely absent artifacts).
    await this.writeFile(stderrPath, '');

    let command = `${spec.cmd.map(shellQuote).join(' ')} 2> ${shellQuote(stderrPath)}`;
    if (spec.stdin !== undefined) {
      const stdinPath = `${scratchDir}/stdin`;
      // content travels in an HTTP BODY; only the PATH ever reaches argv, which is
      // world-readable inside the sandbox via `ps` / `/proc/<pid>/cmdline` (05 §7 #3).
      await this.writeFile(stdinPath, spec.stdin);
      command = `${command} < ${shellQuote(stdinPath)}`;
    }

    const data = await this.postBashExec(
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
  async readJob(jobId: string, cursor?: JobCursor, waitMs?: number): Promise<JobChunk> {
    const job = decodeJobId(jobId);
    const at = decodeCursor(cursor);
    const budget = waitMs ?? 0;

    let raw = await this.readBashOutput(job, at.stdout, 0);
    // ⚠️ THE TEST IS "IS THERE A DELIVERABLE WHOLE LINE", NOT "ARE THERE BYTES".
    // A half line sitting in the agent's buffer makes `raw.stdout` NON-EMPTY while
    // `trimToLineBoundary` still yields '' and the cursor still does not move — so a
    // byte-emptiness test would skip the wait and hand the pump an empty chunk it
    // instantly re-reads. Measured before the fix: ~150k reads/second, each carrying a
    // POST /v1/bash/output plus a whole-file stderr download.
    if (trimToLineBoundary(raw.stdout, false) === '' && raw.status === 'running' && budget > 0) {
      const stream = await this.ensureJobStream(job.sessionId);
      if (stream) {
        await stream.wait(budget);
        raw = await this.readBashOutput(job, at.stdout, 0);
      } else {
        // no socket ⇒ the agent's native long-poll. This is the branch that makes
        // "never busy poll" TRUE rather than aspirational.
        raw = await this.readBashOutput(job, at.stdout, budget);
      }
    }
    const exited = raw.status === 'exited';
    if (exited) closeJobStream(this.streamKey(job.sessionId));

    const stdout = trimToLineBoundary(raw.stdout, exited);
    const stderr = await this.readStderrIncrement(job.stderrPath, at.stderr);
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
  async killJob(
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
    await this.killSession(job.sessionId, requested);
    if (requested === 'SIGKILL') return;
    if (await this.waitForExit(job, graceMs)) return;
    await this.killSession(job.sessionId, 'SIGKILL');
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
  async releaseJob(jobId: string): Promise<void> {
    const job = decodeJobId(jobId);
    closeJobStream(this.streamKey(job.sessionId));
    // shred the scratch dir FIRST: it may hold the job's stdin payload, and after
    // the session is closed there is no longer a shell in which to remove it.
    await this.bestEffort(job.sessionId, `rm -rf -- ${shellQuote(job.scratchDir)}`);
    await this.closeSession(job.sessionId);
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
  private async assertSurvivesTheJob(
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
    const wrote = await this.postBashExec(
      {
        session_id: sessionId,
        command: `printf %s "\${BASH_SESSION_TIMEOUT-}" > ${shellQuote(probePath)}`,
      },
      undefined,
    ).then(
      () => true,
      () => false,
    );
    // an agent that cannot answer is a problem the first read reports; do not turn an
    // unverifiable answer into a refusal.
    if (!wrote) return;
    const buf = await this.readFileBytes(probePath).catch(() => null);
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
  private async createBashSession(sessionId: string): Promise<void> {
    const res = await this.fetchAgent('/v1/bash/sessions/create', { session_id: sessionId });
    const parsed = await readEnvelope(res);
    if (!res.ok || parsed.success === false) {
      throw new SandboxProviderError(
        SandboxProviderErrorCode.INTERNAL,
        `AIO agent could not create a bash session: HTTP ${res.status} ${parsed.message ?? ''}`.trim(),
      );
    }
  }

  /** `POST /v1/bash/output` — the ONE authoritative byte source for a job. */
  private async readBashOutput(
    job: DecodedJobId,
    offset: number,
    waitMs: number,
  ): Promise<{ stdout: string; status: JobStatus; exitCode?: number }> {
    const res = await this.fetchAgent(
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
  private async waitForExit(job: DecodedJobId, ms: number): Promise<boolean> {
    const deadlineTicks = Math.max(1, Math.round(ms / KILL_POLL_MS));
    for (let i = 0; i < deadlineTicks; i++) {
      await new Promise((r) => setTimeout(r, KILL_POLL_MS));
      try {
        const r = await this.readBashOutput(job, Number.MAX_SAFE_INTEGER, 0);
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
  private async readStderrIncrement(
    path: string,
    from: number,
  ): Promise<{ text: string; next: number }> {
    const buf = await this.readFileBytes(path);
    if (!buf || buf.length <= from) return { text: '', next: from };
    const slice = buf.subarray(from);
    return { text: slice.toString('utf8'), next: from + slice.length };
  }

  // ── 文件面 / file plane (SandboxFiles, 04 §2.6) ──────────────────────────────

  /**
   * Whole-file read, BINARY SAFE. It must go through `GET /v1/file/download`
   * (`application/octet-stream`): the agent's text-oriented `POST /v1/file/read`
   * raises `'utf-8' codec can't decode byte 0xa3` on binary content, so it cannot
   * back this method at all.
   *
   * A MISSING FILE IS `null`, NOT AN ERROR — that is a normal path: codex's
   * `-o/--output-last-message <FILE>` is simply not created when the task fails. The
   * two agent endpoints disagree on how they report it (download answers 404, read
   * answers HTTP 200 with `success:false` + `error_type:"not_found"`); both are
   * normalised here so no caller ever sees the difference.
   */
  async readFileBytes(path: string): Promise<Buffer | null> {
    const res = await this.getAgent(`/v1/file/download?path=${encodeURIComponent(path)}`);
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new SandboxProviderError(
        SandboxProviderErrorCode.INTERNAL,
        `AIO agent file download failed: HTTP ${res.status} for ${path}`,
      );
    }
    const body = Buffer.from(await res.arrayBuffer());
    return isNotFoundEnvelope(res, body) ? null : body;
  }

  /** Streaming read for artifacts too large to hold in memory. `null` when absent. */
  async openFileStream(path: string): Promise<NodeJS.ReadableStream | null> {
    const res = await this.getAgent(`/v1/file/download?path=${encodeURIComponent(path)}`);
    if (res.status === 404) return null;
    if (!res.ok || res.body === null) {
      if (res.ok) return null;
      throw new SandboxProviderError(
        SandboxProviderErrorCode.INTERNAL,
        `AIO agent file download failed: HTTP ${res.status} for ${path}`,
      );
    }
    // A JSON `not_found` envelope arrives with a 200, so it cannot be detected from
    // headers alone without consuming the body — only the JSON content type can
    // possibly be one, and an artifact served as octet-stream never is.
    if (isJsonResponse(res)) {
      const body = Buffer.from(await res.arrayBuffer());
      return isNotFoundEnvelope(res, body) ? null : Readable.from(body);
    }
    return Readable.fromWeb(res.body);
  }

  /**
   * Write through the agent's file API so the content travels in an HTTP BODY.
   * Measured: missing parent directories are created for us, and `encoding:"base64"`
   * round-trips binary intact — which is why `mkdir` is absent from the plane rather
   * than merely discouraged.
   */
  async writeFileContent(path: string, content: string | Buffer): Promise<void> {
    const body = Buffer.isBuffer(content)
      ? { file: path, content: content.toString('base64'), encoding: 'base64' }
      : { file: path, content };
    const res = await this.fetchAgent('/v1/file/write', body);
    const parsed = await readEnvelope(res);
    if (!res.ok || parsed.success === false) {
      throw new SandboxProviderError(
        SandboxProviderErrorCode.INTERNAL,
        `AIO agent file write failed: HTTP ${res.status} ${parsed.message ?? ''}`.trim(),
      );
    }
  }

  /**
   * Directory listing, normalised to `FileEntry`. Two agent encodings are converted
   * HERE so they never leak into the contract (04 §2.6): `size` is `null` for
   * directories (⇒ the field is ABSENT, not 0), and `modified_time` is epoch SECONDS
   * WRAPPED IN A STRING (⇒ ISO-8601). A missing directory lists as EMPTY rather than
   * throwing — "the task produced no artifacts" is a normal outcome, not a fault.
   */
  async listFiles(
    path: string,
    opts?: { recursive?: boolean; maxEntries?: number },
  ): Promise<FileEntry[]> {
    const res = await this.fetchAgent('/v1/file/list', {
      path,
      recursive: opts?.recursive ?? false,
      include_size: true,
    });
    if (res.status === 404) return [];
    const parsed = await readEnvelope(res);
    if (!res.ok || parsed.success === false) {
      if (isNotFoundMessage(parsed.message)) return [];
      throw new SandboxProviderError(
        SandboxProviderErrorCode.INTERNAL,
        `AIO agent file list failed: HTTP ${res.status} ${parsed.message ?? ''}`.trim(),
      );
    }
    const rows = agentFileRows(parsed.data);
    const limit = opts?.maxEntries;
    const capped = limit !== undefined && limit >= 0 ? rows.slice(0, limit) : rows;
    return capped.map((row) => toFileEntry(row));
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
  private async ensureJobStream(sessionId: string): Promise<JobStream | null> {
    const key = this.streamKey(sessionId);
    const existing = jobStreams.get(key);
    if (existing?.alive) return existing;
    try {
      const ticket = this.authToken !== undefined ? await this.issueWsTicket() : undefined;
      const base = `${this.baseHttpUrl.replace(/^http/i, 'ws')}/v1/bash/ws`;
      const query = new URLSearchParams({ session_id: sessionId });
      if (ticket !== undefined) query.set('ticket', ticket);
      const url = `${base}?${query.toString()}`;
      const ws = new WebSocket(url);
      await this.awaitOpenAt(ws, url);
      const stream = new JobStream(ws, key);
      jobStreams.set(key, stream);
      return stream;
    } catch {
      return null;
    }
  }

  private streamKey(sessionId: string): string {
    return `${this.baseHttpUrl}|${sessionId}`;
  }

  /** GET against the agent, carrying the bearer token like every other call. */
  private async getAgent(path: string, signal?: AbortSignal): Promise<Response> {
    try {
      return await fetch(`${this.baseHttpUrl}${path}`, {
        method: 'GET',
        headers: authOnlyHeaders(this.authToken),
        signal: signal ?? AbortSignal.timeout(AGENT_HTTP_TIMEOUT_MS),
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
}

/** Extra wall-time the transport gets beyond the agent's own `hard_timeout`. */
const ABORT_SLACK_MS = 5_000;
/**
 * Deadline on ANY single agent HTTP call.
 *
 * ⚠️ WITHOUT ONE, A WEDGED AGENT HANGS THE CALLER FOR undici's 300-SECOND DEFAULT.
 * That is not merely slow: the pump's platform-side backstop only gets to run between
 * reads, so a 4-hour task's "is it overdue?" check would fire at 5-minute granularity
 * at best — and `readFileBytes` (the whole-file stderr download on EVERY read) has the
 * same exposure. 30s is far beyond any measured loopback call (8 MB in ~36 ms) and far
 * below the granularity the backstop needs.
 */
const AGENT_HTTP_TIMEOUT_MS = 30_000;
/**
 * What the agent falls back to when `BASH_SESSION_TIMEOUT` is unset — measured, and
 * documented in `agent-auth.ts`. An ABSENT variable therefore means 3600s, not
 * "unlimited", which is why `assertSurvivesTheJob` treats the two identically.
 */
const AGENT_DEFAULT_SESSION_TTL_SECONDS = 3600;
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
  error_type?: string;
  data?: AgentData;
}

/**
 * The union of the envelope payloads this client reads. Kept as ONE optional-field
 * shape rather than a discriminated union because the agent's envelope carries no
 * discriminator — every endpoint answers `{success,message,data}` and the caller
 * already knows which fields it asked for.
 */
interface AgentData extends BashExecResult {
  command?: BashCommandState;
  files?: unknown;
  entries?: unknown;
  items?: unknown;
}

interface BashExecResult {
  status?: string;
  stdout?: string | null;
  stderr?: string | null;
  exit_code?: number | null;
  command_id?: string;
}

interface BashCommandState {
  status?: string;
  exit_code?: number | null;
}

interface BashExecRequest {
  session_id: string;
  command: string;
  exec_dir?: string;
  env?: Record<string, string>;
  hard_timeout?: number;
  async_mode?: boolean;
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

// ── job-plane helpers ────────────────────────────────────────────────────────

/** Beat of the kill grace poll (ticks, not a wall clock — 01 §3). */
const KILL_POLL_MS = 250;

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
 * `timed_out` is the agent's HARD-timeout kill; report the conventional 124 the
 * platform already speaks (03 §8.3) rather than the agent's internal -1, so a
 * sandbox-side timeout is distinguishable from an ordinary non-zero exit.
 * A `null` exit code stays ABSENT — a signal-killed process genuinely has none.
 */
function jobExitCodeOf(command: {
  status?: string;
  exit_code?: number | null;
}): number | undefined {
  if (command.status === 'timed_out') return 124;
  return typeof command.exit_code === 'number' ? command.exit_code : undefined;
}

/** `Authorization` only — for GETs, which carry no JSON body. */
function authOnlyHeaders(token: string | undefined): Record<string, string> {
  return token === undefined ? {} : { authorization: `Bearer ${token}` };
}

function isJsonResponse(res: Response): boolean {
  return (res.headers.get('content-type') ?? '').includes('json');
}

/**
 * The agent's OTHER way of saying "no such file": HTTP 200 with
 * `{success:false, error_type:"not_found"}`. Normalised to `null` alongside the
 * download endpoint's plain 404 so callers never learn the two disagree.
 */
function isNotFoundEnvelope(res: Response, body: Buffer): boolean {
  if (!isJsonResponse(res)) return false;
  try {
    const parsed: unknown = JSON.parse(body.toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null) return false;
    const o = parsed as Record<string, unknown>;
    return o.success === false && isNotFoundMessage(String(o.error_type ?? o.message ?? ''));
  } catch {
    return false;
  }
}

function isNotFoundMessage(message?: string): boolean {
  return message !== undefined && /not[_ ]?found|no such file|does not exist/i.test(message);
}

/** Locate the row array whichever key this agent build puts it under. */
function agentFileRows(data: unknown): Record<string, unknown>[] {
  const candidates: unknown[] = [data];
  if (typeof data === 'object' && data !== null) {
    const o = data as Record<string, unknown>;
    candidates.push(o.files, o.entries, o.items);
  }
  for (const c of candidates) {
    if (Array.isArray(c)) {
      return c.filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null);
    }
  }
  return [];
}

function toFileEntry(row: Record<string, unknown>): FileEntry {
  const isDir = row.is_directory === true;
  const size = typeof row.size === 'number' ? row.size : undefined;
  return {
    path: typeof row.path === 'string' ? row.path : String(row.name ?? ''),
    kind: isDir ? 'dir' : 'file',
    // measured: the agent reports `size: null` for a directory ⇒ ABSENT, not 0.
    ...(isDir || size === undefined ? {} : { size }),
    modifiedAt: epochSecondsToIso(row.modified_time) ?? '',
  };
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
