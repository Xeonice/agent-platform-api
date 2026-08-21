import type { ProcessSpec, ProcessStream } from './sandbox-provider.contract';
import type { AuthChallengeDto, RuntimeAuthMethod } from './schemas/runtime.schema';

/**
 * RuntimeAdapter contract — S4 AUTH + INJECT subset (docs/backend/04 §3). A
 * RuntimeAdapter encapsulates "a CLI's quirks" (how it logs in, how a credential
 * is injected) and touches NO sandbox implementation detail — it only ever sees
 * the neutral primitives `ProcessStream` (interactive pty) / `SandboxExecFn`
 * (one-shot exec). So one `ClaudeCodeAdapter` runs identically under aio/boxlite.
 *
 * NOTE (S4 scope): the run methods (`getInstallPlan/install/buildStartCommand/…`,
 * 04 §3) are added by a later sandbox-run slice; S4 defines exactly the auth +
 * inject surface it exercises so the built-in adapters stay lean and testable.
 */

/**
 * A one-shot command execution derived by the platform from `spawn({tty:false})`
 * (04 §2.3) — NOT a SandboxProvider method. `injectCredential` receives it from
 * the sandbox orchestration side (which holds the exec); the credential context
 * never depends on it (23 §8.2, direction discipline).
 */
export type SandboxExecFn = (
  cmd: string[],
  opts?: Omit<ProcessSpec, 'cmd' | 'tty'>,
) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

/** User-supplied completion for an interactive challenge (04 §3). */
export interface AuthCompletionInput {
  pastedText?: string;
  cancel?: boolean;
}

/**
 * The per-login helper session an adapter drives (05 §3). Carries the real pty
 * `ProcessStream` AND the per-op isolated `homeDir` (a fresh mkdtemp HOME /
 * CLAUDE_CONFIG_DIR / CODEX_HOME, P1-3) so a file-based CLI (codex reads
 * `$CODEX_HOME/auth.json`, 05 §1 ★2) can collect its credential from disk. The
 * runtime orchestration `finally`-deletes `homeDir` after the session ends.
 */
export interface AuthSessionContext {
  pty: ProcessStream;
  homeDir: string;
  /** Session id minted by the app layer (= the in-memory AuthSession key). */
  challengeRef: string;
  /**
   * Absolute ISO deadline the app layer pre-computed from its Clock for a
   * device-code challenge (adapters are clock-free — the time/random ban keeps
   * `new Date()` out of infrastructure). Undefined for non-expiring challenges.
   */
  deviceCodeExpiresAt?: string;
}

/**
 * RuntimeCredential — the controlled-plaintext wrapper the credential facade hands
 * out for injection (04 §3, 23 §8.2 relaxed I-CRD-2). `credentialFiles[].content`
 * is PLAINTEXT and lives in memory only; the orchestration side injects it via a
 * one-shot exec and `zeroize()`s it. The injection FORMAT obeys the minimal-exposure
 * priority (05 §4/§7 #3): access-token-only (stdin) > 0600 file > (banned) whole env.
 */
export interface RuntimeCredential {
  runtimeId: string;
  obtainedVia: RuntimeAuthMethod;
  maskedIdentifier?: string;
  issuedAt: string;
  expiresAt?: string;
  /** Absolute container paths + plaintext content; `mode` e.g. '0600'. Memory-only. */
  credentialFiles: Array<{ containerPath: string; content: string; mode?: string }>;
  /**
   * Plaintext env to inject (e.g. `CLAUDE_CODE_OAUTH_TOKEN` / `OPENAI_API_KEY`).
   * NEVER the whole `auth.json` (that carries the refresh_token — P0-3).
   */
  env?: Record<string, string>;
  /**
   * A short-lived ACCESS token (no refresh token). When present the adapter injects
   * it via the highest-priority, lowest-exposure form — fed on process STDIN to a
   * login command (codex `--with-access-token`), never into argv/env/files (05 §4).
   * The adapter (not the credential context) owns the CLI command.
   */
  accessToken?: string;
  /**
   * The COMPLETE provider auth file (e.g. codex `auth.json` WITH refresh_token) —
   * PLATFORM-ONLY. Used solely by the refresh scanner (05 §5.1) to seed a helper
   * HOME. `injectCredential` MUST NEVER write this into a sandbox (it carries the
   * refresh_token, P0-3); injection uses `accessToken`/`env`/a sanitized file only.
   */
  authFile?: string;
  /** Wipe every plaintext buffer this credential carries (called in `finally`). */
  zeroize(): void;
}

/**
 * Re-export of the wire AuthChallenge shape for adapter method signatures (the
 * runtime domain uses the identical structure; the adapter lives in
 * runtime/infrastructure, which may import contracts).
 */
export type AuthChallenge = AuthChallengeDto;

/**
 * api-key FORMAT verdict — prefix/length/charset (05 §3.1 入库前校验 P1-4c). Each
 * adapter owns its provider's key shape, so the application layer never hard-codes
 * "codex ⇒ sk- / else sk-ant-": it just asks the adapter.
 */
export interface ApiKeyFormatVerdict {
  ok: boolean;
  reason?: string;
}

/**
 * The refresh capability an adapter DECLARES when its account credential carries a
 * short-lived access token that the CLI itself can refresh from a seeded helper HOME
 * (05 §5.1, method A "let the CLI refresh itself"). Adapters WITHOUT it (claude
 * setup-token ~1yr no-refresh / api-key no expiry / any new runtime that never
 * expires) are skipped by the refresh scanner — so the scanner never hard-codes a
 * per-runtime probe command or auth-file parser.
 */
export interface RuntimeRefreshCapability {
  /** Cheap probe the scanner runs in a seeded HOME to trigger the CLI's own refresh. */
  probeCommand: string[];
  /** Parse the CLI-rewritten provider auth file → the fresh short-lived access token. */
  parseRefreshedAuth(raw: string): { accessToken: string };
}

export interface RuntimeAdapter {
  readonly id: string;
  readonly displayName: string;
  readonly vendor: string;

  /**
   * Declared ONLY when this runtime's account credential must be periodically
   * refreshed by the CLI itself (05 §5.1). The refresh scanner reads the probe
   * command + parser from here; adapters that omit it are skipped gracefully.
   */
  readonly refreshCapability?: RuntimeRefreshCapability;

  /**
   * How long a credential obtained via each auth method stays valid, in ms — the
   * platform-side `credentials.expires_at` it stamps at store time (05 §5). This is
   * a VENDOR fact (codex's access token lives ~1h; claude's setup-token ~1yr), so it
   * belongs to the adapter, NOT to the application layer: keying it off the METHOD
   * alone would hand every third-party runtime that happens to use `oauth-device`
   * the Codex hour. A method the adapter does not list carries NO platform expiry
   * (api-key / a never-expiring token) — `undefined` means "no expiry", never "0".
   */
  readonly credentialTtlMs?: Readonly<Partial<Record<RuntimeAuthMethod, number>>>;

  /** The interactive login command for a method (helper starts it in a real pty). */
  loginCommand(method: RuntimeAuthMethod): string[];
  /** Available auth methods; return order = recommended priority (04 §3). */
  getAuthMethods(): RuntimeAuthMethod[];
  /** Start the interactive login in the helper pty; parse the challenge (05 §3). */
  beginAuth(method: RuntimeAuthMethod, ctx: AuthSessionContext): Promise<AuthChallenge>;
  /** Feed the pasted code / await completion; produce an injectable credential. */
  completeAuth(
    challenge: AuthChallenge,
    input: AuthCompletionInput,
    ctx: AuthSessionContext,
  ): Promise<RuntimeCredential>;
  /**
   * api-key FORMAT check (prefix/length/charset) for THIS runtime, run BEFORE the
   * secret enters the Vault (05 §3.1). Absent when the runtime has no api-key method;
   * the application layer treats an absent check as "no format constraint".
   */
  validateApiKey?(secret: string): ApiKeyFormatVerdict;
  /** api-key / access-token-paste short-circuit — pure, no sandbox host (05 §3.1). */
  createCredentialFromSecret?(
    method: 'api-key' | 'access-token-paste',
    secret: string,
  ): Promise<RuntimeCredential>;
  /** Materialize an existing Vault credential into a new sandbox (05 §4). */
  injectCredential(cred: RuntimeCredential, exec: SandboxExecFn): Promise<void>;
}

/**
 * Open RuntimeAdapter registry (04 §8). `register` is the extension point itself:
 * an out-of-tree module injects `RUNTIME_ADAPTER_REGISTRY` and registers its adapter
 * from its own `onModuleInit` — the built-in catalogue is never edited. A duplicate
 * `id` is a FAIL-FAST error (04 §8 "id 唯一，冲突启动即 fail-fast"), never a silent
 * overwrite, so two packages claiming `claude-code` surface at boot, not at runtime.
 *
 * NOTE: unlike `ProviderRegistry` there is no `default` option — this platform has no
 * "default runtime" concept (`CreateSandbox.runtime` is required), and an option that
 * nothing reads would be exactly the dead contract this registry is meant to avoid.
 */
export interface RuntimeAdapterRegistry {
  register(impl: RuntimeAdapter): void;
  get(id: string): RuntimeAdapter;
  has(id: string): boolean;
  list(): RuntimeAdapter[];
}
