/**
 * SandboxProvider SPI — framework-agnostic contract (docs/backend/04 §2).
 *
 * ⚠️ Doc 04 is the user-maintained AUTHORITATIVE spec; this file is the code
 * expression of it (read-only reference — do not change 04). Third-party
 * providers implement the 6 required methods; `aio` and `boxlite` are the two
 * built-in implementations (§2.1). The contract contains NO runtime-specific
 * vocabulary (container / micro-VM / docker) — that is implementation detail.
 */

/** Boolean capability struct — NOT a numeric bitmask (04 §2.5). */
export interface SandboxProviderCapabilities {
  spawnTty: boolean;
  volumeMount: boolean;
  updateResources: boolean;
  pauseResume: boolean;
  snapshot: boolean;
  watchEvents: boolean;
  /**
   * BOTH optional planes below are present — `provider.jobs` AND `provider.files`
   * (§2.6). One bit rather than two because they gate ONE platform branch: a headless
   * Task is refused up front unless the provider can run it. Splitting them would
   * license a provider that runs a Task whose artifacts can never be fetched, which is
   * not a shippable half of anything — and a bit with no branch behind it is exactly
   * what §2.5's admission rule exists to keep out (it is why `networkPolicy` and
   * `gpuAllocation` were deleted).
   */
  headlessTask: boolean;
}

export interface ResourceQuota {
  cores: number;
  ramMb: number;
  diskMb: number;
}

/** Already resolved + validated image (04 §7); providers do not re-validate. */
export interface ResolvedImageSpec {
  ref: string;
  digest: string;
  entrypoint?: string[];
  /**
   * What the image DECLARES it preinstalls (`platform.supportedRuntimes`), carried
   * over from the registered manifest. The ONLY reader is `getInstallPlan(imageSpec)`
   * (04 §3 ★1) — it decides `preinstalled` vs `install-on-start`, i.e. whether the
   * plan says 「0 秒」 or 「约 12.5 分钟」.
   *
   * ⚠️ ADDED IN 2026-08 TO RETIRE A REGEX THAT MATCHED THE REF STRING. `imagePreinstalls`
   * used to test `imageSpec.ref` against `/agent-infra\/sandbox/i` — which is a guess
   * about a NAME, not a fact about the BITS: it mis-fires on a mirror
   * (`localhost:5001/platform/sandbox:v1`) and knows nothing at all about a
   * user-registered image (04 §7 ★ 第 3 条, registered as 「被别的机制兜住的错，不是
   * 没错」). Reading the manifest's own declaration is the fix.
   *
   * ⚠️ OPTIONAL, AND THAT IS NOT LAZINESS — it is 04 §8 取舍① applied honestly. The
   * adapters' documented `ANY_IMAGE` neutral spec and every hand-built provider e2e
   * context legitimately have nothing to say here; `undefined` means 「未声明」 and
   * degrades to 现装, which is the safe direction (a live `isInstalled` probe still
   * runs either way, 04 §3).
   */
  supportedRuntimes?: string[];
}

export interface VolumeMount {
  source: string; // host absolute path when kind='host-path' (03 §7.1)
  target: string;
  mode: 'ro' | 'rw';
  kind: 'host-path' | 'persistent' | 'ephemeral';
}

/** The full input the platform hands a provider; it reads nothing else. */
export interface SandboxProviderContext {
  sandboxId: string;
  quota: ResourceQuota;
  image: ResolvedImageSpec;
  env: Record<string, string>;
  /** platform guarantees the mount source EXISTS before create() (03 §4). */
  volumes?: VolumeMount[];
  labels?: Record<string, string>;
}

/** Opaque handle: platform only stores/compares it, never parses it. */
export interface SandboxHandle {
  readonly provider: string; // MUST equal provider.name (SP-01)
  readonly providerSandboxId: string;
  /**
   * Provider 的**私有运行期状态**：平台原样持久化（随 sandbox 一起），并在之后每次调用时
   * 原样交还，好让后端重启后仍能接回这个实例。**平台从不解释它的内容**——键、值、语义
   * 全归拥有它的那个 provider。
   *
   * ── 为什么是一坨不透明的 JSON，而不是几个具名字段 ────────────────────────────
   * ⚠️ 这里曾经是 `agentEndpointPort?: number` + `agentAuthToken?: string` 两个具名字段。
   * 名字里的 `agent` 是 **AIO 镜像内那个 HTTP 服务**——也就是说，*一种* provider 的
   * *一种* 数据面实现，爬进了 provider **无关**的契约，还一路穿透到领域实体
   * （`Sandbox` 聚合上曾经有 `agentEndpointPort`）。注释写着「平台把它当不透明的」，
   * 而字段名恰恰不透明。
   *
   * 代价不是抽象洁癖：它让「沙箱里必须跑着一个 agent HTTP 服务」变成了**平台级假设**。
   * 一个用原生 exec 通道的 provider（boxlite 微 VM）根本没有"端口"和"bearer token"
   * 这两样东西，却仍要在契约里带着它们。
   *
   * ⚠️ **放什么进来是有代价的**：这坨东西会**原样落库**。凭证类的值（如 aio 的 agent
   * bearer token）放这里是当前的既定做法（SANDBOX-RUNTIME-DECISIONS 安全姿态：
   * loopback 端口对本机任意进程可达，没有凭证就等于一个无鉴权 shell），
   * 但它意味着 provider 自己要为「落库的是什么」负责——平台不会替它加密或脱敏。
   */
  readonly providerState?: Readonly<Record<string, unknown>>;
}

export type SandboxRuntimeLifecycleState =
  | 'instance_creating'
  | 'instance_running'
  | 'instance_paused'
  | 'instance_exited'
  | 'instance_dead'
  | 'instance_missing';

export type HealthState = 'healthy' | 'unhealthy' | 'unknown' | 'starting';

export interface HealthStatus {
  state: HealthState;
  lastCheckedAt: string;
  message?: string;
  consecutiveFailures: number;
}

export interface SandboxRuntimeStatus {
  lifecycleState: SandboxRuntimeLifecycleState;
  exitCode?: number;
  startedAt?: string;
  finishedAt?: string;
  resourceUsage?: { cpuPercent: number; ramUsedMb: number };
  health?: HealthStatus;
  raw?: unknown;
}

/** The single process-creation input; one-shot vs interactive differ only by `tty`. */
export interface ProcessSpec {
  cmd: string[];
  tty: boolean;
  cols?: number;
  rows?: number;
  env?: Record<string, string>;
  cwd?: string;
  user?: string;
  timeoutMs?: number;
  /**
   * Optional stdin for a one-shot exec — the lowest-exposure channel for feeding a
   * short-lived secret to a login command (e.g. codex `login --with-access-token`,
   * 05 §4/§7 #3). Kept OUT of argv/env so it never reaches `/proc/<pid>/cmdline`.
   */
  stdin?: string;
  reuse?: string; // pass an existing ref to re-attach (06 §6)
}

/** A demultiplexed clean byte stream (04 §2.4). */
export interface ProcessStream {
  readonly ref: string;
  onData(cb: (chunk: Buffer) => void): void;
  write(data: string | Buffer): void;
  resize(cols: number, rows: number): void;
  onExit(cb: (code: number | null) => void): void;
  kill(signal?: NodeJS.Signals): Promise<void>;
  /**
   * Let go of this stream WITHOUT touching the process on the other side: close the
   * transport, drop the callbacks, leave whatever is running exactly as it is.
   *
   * ── Why this cannot just be `kill()` ─────────────────────────────────────────────
   * The interactive terminal is a `tmux attach` onto a session that must SURVIVE the
   * browser going away — that is the entire reason tmux is a hard image requirement
   * (`IMAGE_CONTRACT_VIOLATION`: without it a platform restart loses the running agent
   * session). 06 §6.6/§8.4 spell out the rule: "WS 断开 = detach", and what gets killed
   * is "只是网关侧的 `tmux attach` 进程, agent 会话不受影响".
   *
   * `kill()` cannot express that, because for a PTY the only real signal channel IS the
   * pty: it writes ETX + `exit\n` INTO the terminal (see `AioWsProcessStream.kill`).
   * Those bytes land in the tmux pane — i.e. they SIGINT the agent the user is running
   * and then try to end its shell. Calling `kill()` on disconnect therefore does the
   * exact opposite of detaching, and it does it every time a tab closes or reloads.
   *
   * ⚠️ Implementations MUST NOT write anything to the process here. If a stream has no
   * process of its own to let go of (a one-shot exec that already finished), detaching
   * is just closing the transport.
   */
  detach(): void;
}

/**
 * ── The job plane (`capabilities.headlessTask`) ────────────────────────────────
 *
 * `spawn`/`ProcessStream` is a CONNECTION abstraction: short-lived, held in the
 * platform process's memory, caller must stay attached. Installing a CLI, probing
 * tmux and injecting a credential are all that shape, and it is right for them.
 *
 * A headless Task is not that shape. It runs for tens of minutes, a platform restart
 * must not interrupt it, a page refresh must resume it, and its stdout is pure JSONL
 * that must stay separated from stderr. None of that is "open another stream" — it
 * needs a JOB abstraction: long-lived, addressable by id, re-queryable after the fact.
 *
 * We already solved this split once on the interactive side: tmux was raised from
 * SHOULD to MUST (04 §7 ★) precisely because "the session is held by the sandbox's OWN
 * tmux server, so restarting the backend does not interrupt the agent". The job plane
 * is the headless instance of the same idea — the holder is the sandbox's own
 * agent-side command session instead of a tmux server.
 *
 * WHY IT IS NOT `spawn` AND DOES NOT REPLACE IT: the two do not overlap.
 *   spawn    = give me a CONNECTION, I want the bytes now, I will wait
 *   startJob = give me a JOB, I am leaving, I will come back with the id
 * Rewriting `spawn({tty:false})` on top of start+poll would add two HTTP round-trips
 * to every short command (install probe, tmux probe) for no gain — the synchronous
 * path suits them.
 */
export interface JobSpec {
  cmd: string[];
  env?: Record<string, string>;
  cwd?: string;
  /**
   * First-line timeout, really enforced sandbox-side. The platform-side forced kill
   * remains the backstop (04 §3 ★3 / 03 §8.3) — both exist, neither replaces the other.
   *
   * ⚠️ It is ALSO the provider's survival obligation — see `SandboxJobs` below: a job
   * declared with `timeoutMs` MUST stay startable, readable and killable for that whole
   * span. A provider that cannot honour the requested span rejects the job up front
   * with `UNSUPPORTED_CAPABILITY`; it does NOT accept it and let it vanish mid-run.
   */
  timeoutMs?: number;
  /** Same meaning as `ProcessSpec.stdin`: travels in a body, NEVER in argv (05 §7 #3). */
  stdin?: string;
}

/**
 * Opaque job handle.
 *
 * ⚠️ Same discipline as `SandboxHandle`: the platform only STORES and COMPARES it,
 * never parses it. It must survive a round-trip through the database — "a platform
 * restart does not lose a running Task" rests entirely on that.
 */
export interface JobHandle {
  readonly provider: string;
  readonly jobId: string;
}

/**
 * Opaque read cursor — stored, never parsed.
 *
 * WHY NOT `{ stdout: number; stderr: number }`: byte offsets are one provider's
 * encoding of "where I left off"; another may count lines, frames or chunks. Exposing
 * numbers invites the caller to do arithmetic on them, which then breaks on the next
 * provider. Callers detect "anything new?" from the `JobChunk` fields being non-empty,
 * which needs no knowledge of the cursor at all.
 */
export type JobCursor = string;

export type JobStatus = 'running' | 'exited';

export interface JobChunk {
  /**
   * ⚠️ stdout and stderr are SEPARATE fields, and that is not fastidiousness.
   * Measured (2026-08, real CLIs): `codex exec --json` writes 100% clean JSONL to
   * stdout (14/14 lines parsed) while every tracing line goes to stderr; merge the two
   * and the same run yields 14 parseable + 8 garbage lines, which drags `parseOutput`
   * down from "JSON.parse per line" to "guess the format with a regex" — exactly the
   * fragility RA-04 names. `claude --output-format stream-json` is likewise 3/3 clean.
   *
   * `toExecFn` merges them into one `output` and tells callers to redirect inside the
   * command instead. That is fine for short commands; for a headless Task it would put
   * the platform in charge of a temp file's lifetime inside someone else's sandbox.
   */
  stdout: string;
  stderr: string;
  /** Pass back on the next call. Omit the cursor entirely to read from the start. */
  cursor: JobCursor;
  status: JobStatus;
  /**
   * Meaningful only when `status === 'exited'`, and MAY still be absent — a process
   * killed by a signal has no ordinary exit code. Callers treat an absent code as a
   * non-zero exit, never as "has not exited"; same handling as
   * `ProcessStream.onExit(code: number | null)` under SP-09.
   */
  exitCode?: number;
}

export interface JobReadOptions {
  /**
   * Long-poll budget. 0/absent ⇒ return whatever is buffered right now, possibly
   * nothing. Without it the only option is busy polling: a 40-minute task that emits
   * an event every few seconds costs ~2400 empty round-trips at 1s intervals.
   */
  waitMs?: number;
}

/**
 * Grouped rather than flat optional methods on `SandboxProvider`, so that "a provider
 * implements all three or none" is STRUCTURAL instead of conventional — a provider
 * with `startJob` but no `readJob` cannot be expressed. Same reasoning as splitting
 * `InjectableRuntimeCredential` from `RefreshableRuntimeCredential` (05 §4).
 *
 * ⚠️ SURVIVAL OBLIGATION (the clause a naive implementation silently breaks). Between
 * `startJob` and `releaseJob`, a job MUST remain startable, readable and killable for
 * at least its `JobSpec.timeoutMs`, and reading it MUST NOT be what keeps it alive.
 *
 * This is stated because the obvious backing implementation violates it by DEFAULT.
 * Measured on the built-ins' in-sandbox agent (2026-08): sessions carry an idle TTL
 * (1 hour by default) whose clock is refreshed by SUBMITTING a command but NOT by
 * reading its output, and the reaper does not check whether a command is still
 * running. A job polled diligently every few seconds is therefore still destroyed the
 * moment the TTL elapses — verified end to end with the TTL compressed to 5s: a
 * 300-second command that had been polled at t=10/30/55 was gone at t=70, answering
 * 404, output and exit status lost. There is also a per-sandbox session cap (50 by
 * default) that EVICTS THE OLDEST job when a new one is started.
 *
 * ⇒ A provider advertising `headlessTask` is responsible for configuring the sandbox so
 * both limits exceed the longest `timeoutMs` it accepts (for the built-ins that is an
 * env var set at creation time, the same channel `JWT_PUBLIC_KEY` already uses). "The
 * platform polls often enough" is NOT a valid strategy — polling does not refresh the
 * clock.
 */
export interface SandboxJobs {
  /**
   * Returns as soon as the job is accepted; does NOT wait for the command to finish.
   *
   * ⚠️ ORDERING IS PART OF THE IMPLEMENTATION, NOT A DETAIL. On the built-ins' backing
   * service the streaming socket CLOSES the session it created when it disconnects —
   * which destroys the output and kills the command. So the session must already exist
   * before anything attaches to it: create the session, start the command, and only
   * then attach a stream. Get this backwards and nothing fails until the first platform
   * restart, at which point running jobs die silently. Measured 2026-08; see 04 §2.6 ★★.
   */
  startJob(handle: SandboxHandle, spec: JobSpec): Promise<JobHandle>;

  /**
   * Read forward from `cursor`. Omitting `cursor` reads from the beginning — refresh
   * recovery and reconnect-after-disconnect are that, and nothing more.
   */
  readJob(
    handle: SandboxHandle,
    job: JobHandle,
    cursor?: JobCursor,
    opts?: JobReadOptions,
  ): Promise<JobChunk>;

  /** Same semantics as `ProcessStream.kill`: two-phase SIGTERM → 5s → SIGKILL (03 §8.3). */
  killJob(handle: SandboxHandle, job: JobHandle, signal?: NodeJS.Signals): Promise<void>;

  /**
   * Drop the job's server-side state. Idempotent; a released or unknown job is a
   * silent success (same discipline as `destroy`).
   *
   * ⚠️ THIS IS NOT OPTIONAL BOOKKEEPING, AND IT MUST NOT BE CALLED EARLY. Measured
   * (2026-08): closing the sandbox-side session DESTROYS the recorded output — a read
   * afterwards answers `Session <id> not found`, not an empty chunk. So the platform
   * releases only once it has persisted everything it needs; `killJob` deliberately
   * does NOT release, because the exit code and the tail of the output are exactly
   * what a caller wants AFTER killing something.
   *
   * WHY IT EXISTS AT ALL: sessions are server-side state and accumulate, so a sandbox
   * that runs many Tasks would leak them. The existing one-shot `exec` path closes its
   * session in a `finally` for that reason — a job MUST NOT copy that pattern, which
   * is precisely why release is a separate call rather than something `readJob` or
   * `killJob` does implicitly.
   */
  releaseJob(handle: SandboxHandle, job: JobHandle): Promise<void>;
}

export interface FileEntry {
  path: string;
  kind: 'file' | 'dir';
  /** Absent for directories — measured: the agent reports `size: null` for them. */
  size?: number;
  /**
   * ISO-8601. ⚠️ The agent reports epoch SECONDS in a STRING (`"1787396751"`), so the
   * provider converts; the contract does not leak that encoding to callers.
   */
  modifiedAt: string;
}

/**
 * ── The file plane (`capabilities.headlessTask`) ────────────────────────────
 *
 * WHY NOT just `exec` + `cat`/`ls`:
 *   ① `cat` on a binary returns bytes already mangled by the shell;
 *   ② the command string is readable from inside the sandbox via `ps` /
 *      `/proc/<pid>/cmdline`, so a write path that carries content violates
 *      05 §7 #3 / RA-14 — the very reason `injectCredential` goes through a file
 *      write and not a heredoc;
 *   ③ a large artifact must stream; `cat` over exec buffers the whole file into one
 *      response.
 */
export interface SandboxFiles {
  /**
   * Whole-file read. A MISSING FILE RETURNS `null` RATHER THAN THROWING — that is a
   * normal path, not an error: measured, codex's `-o/--output-last-message <FILE>` is
   * not created at all when the task fails.
   *
   * ⚠️ MUST be backed by a BINARY-SAFE channel. Measured (2026-08): the agent's
   * text-oriented read endpoint raises `'utf-8' codec can't decode byte 0xa3` on a
   * binary file, so it cannot back this method; the octet-stream download endpoint
   * round-trips bytes exactly (264-byte payload verified byte-for-byte) and serves
   * 8 MB in ~36 ms. Also measured: the two endpoints disagree on how a missing file is
   * reported (one answers HTTP 200 with `success:false` + `error_type:"not_found"`,
   * the other a plain 404) — the provider normalises both to `null`.
   */
  readFile(handle: SandboxHandle, path: string): Promise<Buffer | null>;

  /**
   * Streaming read, for artifacts too large to hold in memory (screenshots, archives,
   * long logs). Text is deliberately NOT a third format — callers decode the bytes.
   */
  openFileStream(handle: SandboxHandle, path: string): Promise<NodeJS.ReadableStream | null>;

  /**
   * Content travels in a body, never in a command string.
   *
   * Measured: the agent creates missing parent directories on write, and a `Buffer`
   * round-trips intact through its base64 encoding — which is why `mkdir` is absent
   * from this plane rather than merely discouraged.
   */
  writeFile(handle: SandboxHandle, path: string, content: string | Buffer): Promise<void>;

  /**
   * Without this the platform can only hard-code one artifact path, which removes the
   * agent's freedom to decide what it produced.
   */
  listFiles(
    handle: SandboxHandle,
    path: string,
    opts?: { recursive?: boolean; maxEntries?: number },
  ): Promise<FileEntry[]>;
}

/**
 * Deliberately NOT on the file plane: `mkdir` / `rename` / `remove` / `exists` / `watch`.
 *   - mkdir/rename/remove carry no secret (a path is not a credential), so plain `exec`
 *     is safe for them and does not cost every provider another method to implement.
 *   - `exists` is `readFile` returning `null`.
 *   - `watch` exists agent-side as a whole family with cursor polling, but no caller
 *     needs it: a Task's artifacts are read once, when the Task ends. Adding it now
 *     would fix its shape against a guess instead of against a real requirement.
 */

export interface ProviderEvent {
  providerSandboxId: string;
  lifecycleState: SandboxRuntimeLifecycleState;
  at: string;
}

/** The 6 required methods + 2 optional lifecycle extras + 2 optional planes (04 §2.2). */
export interface SandboxProvider {
  readonly name: string;
  readonly capabilities: SandboxProviderCapabilities;

  create(ctx: SandboxProviderContext): Promise<SandboxHandle>;
  start(handle: SandboxHandle): Promise<void>;
  stop(handle: SandboxHandle, opts?: { timeoutSec?: number }): Promise<void>;
  destroy(handle: SandboxHandle): Promise<void>;
  inspect(handle: SandboxHandle): Promise<SandboxRuntimeStatus>;
  spawn(handle: SandboxHandle, spec: ProcessSpec): Promise<ProcessStream>;

  updateResources?(handle: SandboxHandle, quota: ResourceQuota): Promise<void>;
  watchEvents?(): AsyncIterable<ProviderEvent>;

  /** Present iff `capabilities.headlessTask` (CAP-02) — together with `files`. */
  readonly jobs?: SandboxJobs;
  /** Present iff `capabilities.headlessTask` (CAP-02) — together with `jobs`. */
  readonly files?: SandboxFiles;
}

/**
 * Open registry keyed by ProviderId string (not a closed enum, 04 §8).
 *
 * `register` is the extension point itself: an out-of-tree module injects
 * `SANDBOX_PROVIDER_REGISTRY` and registers its provider from its own
 * `onModuleInit` — no built-in module's providers array is edited, and the new
 * provider immediately shows up on `GET /api/providers` and in `create`. A
 * duplicate `name` is a FAIL-FAST error (04 §8 "name 唯一，冲突启动即 fail-fast"),
 * never a silent overwrite. `opts.default` moves `defaultProvider` to the newly
 * registered implementation (built-in `aio` holds it otherwise).
 */
export interface ProviderRegistry {
  register(impl: SandboxProvider, opts?: { default?: boolean }): void;
  get(name: string): SandboxProvider;
  has(name: string): boolean;
  list(): SandboxProvider[];
  readonly defaultProvider: string;
}

// ── Unified error model (04 §4). Infrastructure throws these; application maps
// them to domain errors at the boundary (domain never imports this class). ──
export enum SandboxProviderErrorCode {
  IMAGE_PULL_FAILED = 'IMAGE_PULL_FAILED',
  /**
   * The pinned digest is gone upstream (deleted / GC'd) although the tag still
   * resolves — a failure mode that only EXISTS because the platform now pulls
   * `ref@digest` (04 §7 时刻④). Following a tag always fetched 「某个东西」.
   *
   * ⚠️ DELIBERATELY NOT `IMAGE_PULL_FAILED`. That one sends the user to check the
   * address and the network; here the address is exactly right, and neither editing
   * it nor retrying helps — the way out is [检查更新] onto a new digest. Different
   * thing to do ⇒ different code (04 §4 四类分类法).
   */
  IMAGE_DIGEST_GONE = 'IMAGE_DIGEST_GONE',
  RESOURCE_EXHAUSTED = 'RESOURCE_EXHAUSTED',
  NOT_FOUND = 'NOT_FOUND',
  ALREADY_EXISTS = 'ALREADY_EXISTS',
  TIMEOUT = 'TIMEOUT',
  PERMISSION_DENIED = 'PERMISSION_DENIED',
  INVALID_STATE = 'INVALID_STATE',
  PROVIDER_UNAVAILABLE = 'PROVIDER_UNAVAILABLE',
  UNSUPPORTED_CAPABILITY = 'UNSUPPORTED_CAPABILITY',
  INTERNAL = 'INTERNAL',
}

export class SandboxProviderError extends Error {
  constructor(
    readonly code: SandboxProviderErrorCode,
    message: string,
    override readonly cause?: unknown,
    readonly retryable: boolean = false,
  ) {
    super(message);
    this.name = 'SandboxProviderError';
  }
}

export const UNSUPPORTED_CAPABILITY = SandboxProviderErrorCode.UNSUPPORTED_CAPABILITY;
