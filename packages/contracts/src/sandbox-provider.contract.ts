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
   * Optional provider-specific runtime binding the platform PERSISTS verbatim
   * (with the sandbox) and hands back on every later call — so a backend restart
   * can still reach the instance. The platform treats it opaquely; only the
   * owning provider reads it. Used by `boxlite` to remember the forwarded host
   * loopback port of the in-sandbox agent (its runtime does not surface port
   * mappings, so the port cannot be re-resolved after a restart). `aio` leaves
   * it unset — its container backend re-resolves the published port at spawn time.
   */
  readonly agentEndpointPort?: number;
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
}

export interface ProviderEvent {
  providerSandboxId: string;
  lifecycleState: SandboxRuntimeLifecycleState;
  at: string;
}

/** The 6 required methods + 2 optional (04 §2.2). */
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
}

/** Open registry keyed by ProviderId string (not a closed enum, 04 §8). */
export interface ProviderRegistry {
  get(name: string): SandboxProvider;
  has(name: string): boolean;
  list(): SandboxProvider[];
  readonly defaultProvider: string;
}

// ── Unified error model (04 §4). Infrastructure throws these; application maps
// them to domain errors at the boundary (domain never imports this class). ──
export enum SandboxProviderErrorCode {
  IMAGE_PULL_FAILED = 'IMAGE_PULL_FAILED',
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
