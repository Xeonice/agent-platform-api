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

export interface RuntimeAdapter {
  readonly id: string;
  readonly displayName: string;
  readonly vendor: string;

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
  /** api-key / access-token-paste short-circuit — pure, no sandbox host (05 §3.1). */
  createCredentialFromSecret?(
    method: 'api-key' | 'access-token-paste',
    secret: string,
  ): Promise<RuntimeCredential>;
  /** Materialize an existing Vault credential into a new sandbox (05 §4). */
  injectCredential(cred: RuntimeCredential, exec: SandboxExecFn): Promise<void>;
}

export interface RuntimeAdapterRegistry {
  get(id: string): RuntimeAdapter;
  has(id: string): boolean;
  list(): RuntimeAdapter[];
}
