import { SandboxProviderError, SandboxProviderErrorCode } from '@platform/contracts';
import { authHeader } from './agent-auth';
import type { AgentSignal } from './aio-process.stream';

/**
 * 沙箱内 AIO agent 的**传输层** —— 一个 origin + 一把 key，外加「怎么拆信封」。
 *
 * ══ 为什么它是一个独立文件（2026-08-29 从 1545 行的单文件里拆出来）══════════════
 *
 * 数据面原本整个塞在 `AioSandboxAgentClient` 一个类里：pty、exec、作业面、文件面、
 * HTTP 传输、信封解析、job id 编解码，1545 行。boxlite 那侧早就按面切开了
 * （`boxlite-guest-shell` / `boxlite-process.stream` / `boxlite-files` /
 * `boxlite-jobs`），两档看起来因此像**结构不同的东西**，而它们其实是同一份契约的两个
 * 实现。这一层是那次对称化的最底层。
 *
 * ⚠️ **它只管「怎么把一次调用送出去」，不管任何业务语义。** `startJob` 的三步顺序、
 * 游标的行边界、pty 的 ready 判定——那些都不在这里，也不该被顺手挪进来：传输层一旦
 * 开始知道 job 是什么，下一个人就会在这里加一个「顺便重试」的分支，而那正好会把
 * `/v1/bash/exec` 的 `async_mode` 语义悄悄改成「可能执行两次」。
 */
/**
 * Ceiling on a single agent HTTP call.
 *
 * ⚠️ Long-poll reads pass their OWN signal, so this never truncates a `waitMs` budget
 * — it only bounds the calls that are supposed to answer immediately.
 */
export const AGENT_HTTP_TIMEOUT_MS = 30_000;

export class AioAgentHttp {
  constructor(
    /** agent 的可达 HTTP origin（例如 `http://127.0.0.1:55000`）。 */
    readonly baseUrl: string,
    /**
     * 每沙箱一把的 `SANDBOX_API_KEY`（`agent-auth.ts`）。可选**只是为了**让这个类对一个
     * 没设 key 的 agent（老镜像、夹具）仍然可用——两个 provider 永远会传。
     */
    private readonly apiKey?: string,
  ) {}

  /** 有没有凭证可用来换 ws 票（无 key 的 agent 直接裸连）。 */
  get authenticated(): boolean {
    return this.apiKey !== undefined;
  }

  /** 同一个 origin 的 `ws://` 形式。 */
  get wsOrigin(): string {
    return this.baseUrl.replace(/^http/i, 'ws');
  }

  /** Every agent call carries the sandbox's api key when one was minted. */
  private headers(): Record<string, string> {
    return { 'content-type': 'application/json', ...authHeader(this.apiKey) };
  }

  async post(path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
    try {
      return await fetch(`${this.baseUrl}${path}`, {
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

  /** GET against the agent, carrying the bearer token like every other call. */
  async get(path: string, signal?: AbortSignal): Promise<Response> {
    try {
      return await fetch(`${this.baseUrl}${path}`, {
        method: 'GET',
        headers: authHeader(this.apiKey),
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

  /** POST /v1/bash/exec, unwrapping the agent's `{success,message,data}` envelope. */
  async postBashExec(body: BashExecRequest, signal?: AbortSignal): Promise<BashExecResult> {
    const res = await this.post('/v1/bash/exec', body, signal);
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
  async writeTextFile(file: string, content: string, signal?: AbortSignal): Promise<void> {
    const res = await this.post('/v1/file/write', { file, content }, signal);
    const parsed = await readEnvelope(res);
    if (!res.ok || !parsed.success) {
      throw new SandboxProviderError(
        SandboxProviderErrorCode.INTERNAL,
        `AIO agent file write failed: HTTP ${res.status} ${parsed.message ?? ''}`.trim(),
      );
    }
  }

  /** POST /v1/bash/kill — REAL signal delivery to the session's current command. */
  async killSession(sessionId: string, signal: AgentSignal): Promise<void> {
    try {
      await this.post('/v1/bash/kill', { session_id: sessionId, signal });
    } catch {
      /* agent unreachable — the caller falls back to a local abort */
    }
  }

  /** Sessions are server-side state and accumulate; drop ours when the exec ends. */
  async closeSession(sessionId: string): Promise<void> {
    try {
      await this.post(`/v1/bash/sessions/${encodeURIComponent(sessionId)}/close`, {});
    } catch {
      /* best effort — a stale session is reaped with the sandbox */
    }
  }

  async bestEffort(sessionId: string, command: string): Promise<void> {
    try {
      await this.post('/v1/bash/exec', { session_id: sessionId, command });
    } catch {
      /* best effort — the scratch dir dies with the sandbox at worst */
    }
  }

  /**
   * Trade the bearer token for a short-lived websocket ticket. A failure here is
   * NOT downgraded to an unauthenticated connect — that would silently reopen the
   * hole the token exists to close.
   */
  async issueWsTicket(): Promise<string> {
    const res = await this.post('/tickets', {});
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
}

/** POSIX single-quote a shell word so the agent's shell preserves it verbatim. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * `timed_out` is the agent's HARD-timeout kill; report the conventional 124 the
 * platform already speaks (03 §8.3) instead of the agent's internal -1.
 */
export function exitCodeOf(data: BashExecResult): number | null {
  if (data.status === 'timed_out') return 124;
  return typeof data.exit_code === 'number' ? data.exit_code : null;
}

export async function readEnvelope(res: Response): Promise<AgentEnvelope> {
  try {
    return (await res.json()) as AgentEnvelope;
  } catch {
    return { success: false };
  }
}

export interface AgentEnvelope {
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
export interface AgentData extends BashExecResult {
  command?: BashCommandState;
  files?: unknown;
  entries?: unknown;
  items?: unknown;
}

export interface BashExecResult {
  status?: string;
  stdout?: string | null;
  stderr?: string | null;
  exit_code?: number | null;
  command_id?: string;
}

export interface BashCommandState {
  status?: string;
  exit_code?: number | null;
}

export interface BashExecRequest {
  session_id: string;
  command: string;
  exec_dir?: string;
  env?: Record<string, string>;
  hard_timeout?: number;
  async_mode?: boolean;
}

export interface ExecResult {
  output: string;
  code: number | null;
}

export function isJsonResponse(res: Response): boolean {
  return (res.headers.get('content-type') ?? '').includes('json');
}

/**
 * The agent's OTHER way of saying "no such file": HTTP 200 with
 * `{success:false, error_type:"not_found"}`. Normalised to `null` alongside the
 * download endpoint's plain 404 so callers never learn the two disagree.
 */
export function isNotFoundEnvelope(res: Response, body: Buffer): boolean {
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

export function isNotFoundMessage(message?: string): boolean {
  return message !== undefined && /not[_ ]?found|no such file|does not exist/i.test(message);
}

/**
 * `timed_out` is the agent's HARD-timeout kill; report the conventional 124 the
 * platform already speaks (03 §8.3) rather than the agent's internal -1, so a
 * sandbox-side timeout is distinguishable from an ordinary non-zero exit.
 * A `null` exit code stays ABSENT — a signal-killed process genuinely has none.
 */
export function jobExitCodeOf(command: {
  status?: string;
  exit_code?: number | null;
}): number | undefined {
  if (command.status === 'timed_out') return 124;
  return typeof command.exit_code === 'number' ? command.exit_code : undefined;
}
