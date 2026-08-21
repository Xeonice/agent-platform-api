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
 * One provider credential file the adapter wants materialized inside the sandbox.
 *
 * `containerPath` is a **`~/`-RELATIVE** path (e.g. `~/.codex/auth.json`) — NOT an
 * absolute one (05 §4.3 裁决 D-19, testkit RA-06). `prepareRuntimeCredential(runtimeId)`
 * has no sandbox in its signature: at the moment a credential is built nobody knows
 * which sandbox it will be injected into, let alone that sandbox's `$HOME`. The same
 * credential is meant to be injectable into MANY sandboxes ("log in once, use
 * everywhere", 05 §2 决策 A). `$HOME` is therefore expanded ONLY inside
 * `injectCredential(cred, exec)`, by probing the live sandbox through `exec`.
 *
 * `content` is PLAINTEXT and lives in memory only. For a provider auth file it is the
 * SANITIZED form produced at credential BIRTH — see `RuntimeCredential.authFile`.
 */
export interface RuntimeCredentialFile {
  /** `~/`-relative path inside the sandbox, e.g. `~/.codex/auth.json`. */
  containerPath: string;
  /** Plaintext file content — already sanitized for a provider auth file. */
  content: string;
  /** POSIX mode string, e.g. `'0600'` (the default for credential material). */
  mode?: string;
}

/**
 * InjectableRuntimeCredential — the ONLY credential shape the injection path ever
 * sees (04 §3, 05 §4.3 裁决 D-18, 23 §8.2 I-CRD-9).
 *
 * **It has NO `authFile` field, on purpose.** Injection and platform-side refresh used
 * to share ONE object that carried the real `refresh_token`, and the only thing
 * stopping `injectCredential` from writing it into a sandbox was a comment. A real
 * `refresh_token` inside a sandbox is a long-lived credential the platform cannot
 * revoke upstream (one `echo` steals it — P0-3), so the discipline is now a TYPE:
 * `injectCredential(cred: InjectableRuntimeCredential, …)` simply cannot reach a
 * refresh token, and no future branch, fallback or rewrite can make it reachable.
 *
 * The refresh path uses the separate `RefreshableRuntimeCredential`, handed out by
 * `CredentialFacade.prepareForRefresh(credentialId)` — whose only caller is the
 * refresh scanner (05 §5.1).
 */
export interface InjectableRuntimeCredential {
  runtimeId: string;
  obtainedVia: RuntimeAuthMethod;
  maskedIdentifier?: string;
  issuedAt: string;
  expiresAt?: string;
  /** `~/`-relative paths + plaintext (already-sanitized) content. Memory-only. */
  credentialFiles: RuntimeCredentialFile[];
  /**
   * Plaintext env to inject (e.g. `CLAUDE_CODE_OAUTH_TOKEN` / `OPENAI_API_KEY`).
   * NEVER the whole `auth.json` — that carries the refresh_token (P0-3), and env is
   * readable from inside the sandbox by any process.
   */
  env?: Record<string, string>;
  /**
   * A short-lived ACCESS token (never a refresh token). Injected by feeding it on
   * process STDIN to a login command (codex `--with-access-token`), never into
   * argv/env/files. This form is OPTIONAL and VERSION-SENSITIVE (05 §1★★: a token
   * minted by codex 0.147.0 is rejected by 0.139.0), so it ranks BELOW the 0600
   * sanitized auth file in the minimal-exposure priority. The adapter (not the
   * credential context) owns the CLI command.
   */
  accessToken?: string;
  /** Wipe every plaintext buffer this credential carries (called in `finally`). */
  zeroize(): void;
}

/**
 * RefreshableRuntimeCredential — PLATFORM-ONLY (05 §4.3, §5.1). Injectable material
 * PLUS the COMPLETE provider auth file (codex `auth.json` WITH the real
 * `refresh_token`), used solely to seed the refresh scanner's throw-away helper HOME
 * so the CLI can refresh itself. Handed out ONLY by
 * `CredentialFacade.prepareForRefresh(credentialId)`; it must never be passed to
 * `injectCredential` — which cannot accept it as anything but its injectable half.
 */
export type RefreshableRuntimeCredential = InjectableRuntimeCredential & { authFile: string };

/**
 * RuntimeCredential — what an adapter MINTS at credential BIRTH (`completeAuth` /
 * `createCredentialFromSecret`), before anything is persisted. This is the one place
 * where both forms legitimately coexist, because it is the moment the adapter
 * SEPARATES them (05 §4.3 裁决 D-18 ②):
 *
 *   credentialFiles: [{ containerPath: '~/.codex/auth.json', content: <SANITIZED>, mode: '0600' }]
 *   authFile:        <COMPLETE, with the real refresh_token>   // platform-only
 *
 * The two fields are stored in separate `RuntimeSecretPayload` fields and are read
 * back by two different facade methods. **The injection path performs NO conversion
 * whatsoever** — it does not parse provider JSON and does not rewrite fields; it just
 * writes `credentialFiles[].content` out verbatim.
 *
 * WHY SANITIZE AT BIRTH RATHER THAN AT INJECTION TIME: the shape of `auth.json` is one
 * CLI's quirk, and 04 §3 assigns that knowledge to the adapter. Sanitizing in the
 * credential context would force an `if (runtimeId === 'codex')` there, which breaks
 * the moment a third party registers a runtime with a different file format (runtime
 * ids are an OPEN registry, 10 §7.2). Birth-time sanitization is also strictly
 * stronger: sanitizing at injection time would still require handing the real value to
 * the injection path once — here it is never handed over at all.
 */
export type RuntimeCredential = InjectableRuntimeCredential & {
  /**
   * The COMPLETE provider auth file (with the real `refresh_token`) — PLATFORM-ONLY,
   * consumed exclusively by the refresh scanner (05 §5.1). It is deliberately absent
   * from `InjectableRuntimeCredential`, so it cannot travel down the injection path.
   */
  authFile?: string;
};

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
  /**
   * Parse the CLI-rewritten provider auth file into the material a REFRESHED credential
   * is stored from. This is the THIRD birth site of a credential (alongside
   * `completeAuth` / `createCredentialFromSecret`), so it obeys the same split as the
   * other two (05 §4.3 裁决 D-18 ②): it returns the fresh short-lived access token AND
   * the SANITIZED `credentialFiles` (refresh_token value = the shared-kernel
   * placeholder). The scanner pairs those with the raw file as the platform-only
   * `authFile`. An adapter that returned only `accessToken` would silently drop the
   * sanitized file on every refresh and leave later injections with nothing to write.
   */
  parseRefreshedAuth(raw: string): RefreshedRuntimeAuth;
}

/** What `parseRefreshedAuth` yields — mirrors the birth-time split of a credential. */
export interface RefreshedRuntimeAuth {
  /** The fresh short-lived access token the CLI just obtained. */
  accessToken: string;
  /** Sanitized injectable files rebuilt from the refreshed auth file (05 §4.3 ②). */
  credentialFiles?: RuntimeCredentialFile[];
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
  /**
   * Materialize an existing Vault credential into a NEW sandbox (05 §4).
   *
   * The parameter type is `InjectableRuntimeCredential` — structurally WITHOUT
   * `authFile` — so "the injection path cannot reach the real refresh_token" is a
   * compile-time fact rather than a comment (05 §4.3 裁决 D-18 ①, 23 §8.2 I-CRD-9).
   * The implementation writes `credentialFiles[].content` VERBATIM: no JSON parsing,
   * no field rewriting (the sanitized form was produced at credential birth). `$HOME`
   * for the `~/`-relative `containerPath`s is expanded HERE and only here, by probing
   * the live sandbox through `exec` (裁决 D-19) — never hard-coded, never reused
   * across sandboxes.
   */
  injectCredential(cred: InjectableRuntimeCredential, exec: SandboxExecFn): Promise<void>;
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
