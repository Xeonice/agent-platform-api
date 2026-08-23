import type { ProcessSpec, ProcessStream, ResolvedImageSpec } from './sandbox-provider.contract';
import type { AuthChallengeDto, RuntimeAuthMethod } from './schemas/runtime.schema';

/**
 * RuntimeAdapter contract — S4 AUTH + INJECT subset (docs/backend/04 §3). A
 * RuntimeAdapter encapsulates "a CLI's quirks" (how it logs in, how a credential
 * is injected) and touches NO sandbox implementation detail — it only ever sees
 * the neutral primitives `ProcessStream` (interactive pty) / `SandboxExecFn`
 * (one-shot exec). So one `ClaudeCodeAdapter` runs identically under aio/boxlite.
 *
 * S5 (sandbox-run slice) COMPLETES the contract: the run half —
 * `getInstallPlan` / `isInstalled` / `install` / `buildStartCommand` /
 * `buildAttachCommand` / `parseOutput?` — is now present exactly as 04 §3 sketches
 * it. Five of those six are REQUIRED, which by 04 §9's release semantics makes this
 * a MAJOR contract change ("必须方法签名变更"). It is taken deliberately rather than
 * softened into optional methods with platform defaults, because:
 *   - 04 §3 states them as required and 04 §10.3 RA-01/RA-02/RA-07 are MUST clauses
 *     that only mean something if every adapter really has them;
 *   - a platform-default `buildStartCommand` is not writable: 04 §3 ★2 shows the
 *     inner-sandbox switch (`codex -s danger-full-access` vs claude's permission
 *     model) has NO common shape, and inventing a default would put per-CLI quirks
 *     back into platform code — the exact thing this contract exists to prevent;
 *   - there is no out-of-tree implementer yet (04 §9 落地状态: the package is still
 *     private `@platform/contracts`), so the cost of the major is zero today and
 *     strictly rising later.
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
 * `seedStartupFiles` 的入参。当前只需要工作目录：codex 的目录信任是**按路径**记的
 * （`[projects."<workdir>"] trust_level`），所以要落什么内容取决于 agent 会 cd 到哪。
 */
export interface RuntimeStartupSpec {
  /** 沙箱内的工作目录绝对路径（如 `/workspace`）。 */
  workdir: string;
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

/**
 * What `getInstallPlan(imageSpec)` answers: "does THIS runtime need installing on
 * THIS image, how, and roughly how long" (04 §3 ★1). The verdict is keyed on the
 * (image, runtime) PAIR, never on the runtime alone — the same `claude-code` is a
 * zero-install on one image and a measured 753s install on another.
 *
 * It is a PURE function: no IO, no network, no side effects. It is called twice for
 * different purposes — once in the create-time validation path purely to WARN the
 * user ("claude-code takes ~12.5 min on this image, consider another one"), and once
 * inside the provision workflow's `starting`段 to decide whether `install()` runs
 * (03 §4.3 ③). Only the second call writes anything, and it writes in its OWN short
 * transaction, never in T1 (13 §2.3.2 / 23 §4.3).
 */
export interface RuntimeInstallPlan {
  /**
   * `preinstalled` — the image ships the CLI; `isInstalled()` returning false is
   * then a LOUD failure (`INSTALL_FAILED`), not a cue to install.
   * `install-on-start` — the platform may install it on first boot (the fallback,
   * not the recommendation: 04 §7 asks image authors to preinstall).
   * `sidecar-inject` — reserved; no built-in uses it.
   */
  strategy: 'preinstalled' | 'install-on-start' | 'sidecar-inject';
  /** Shell command lines run IN ORDER by `install()`. Empty for `preinstalled`. */
  packageManagerCmds: string[];
  /**
   * Executables that must resolve on PATH once installed. The orchestrator uses
   * `requiredBinaries[0]` for the `--version` probe that fills
   * `runtime_installations.version_detected` (13 §2.3.2), so the platform never
   * hard-codes a per-runtime binary name.
   */
  requiredBinaries: string[];
  /** Env var names the CLI needs present to install/run (documentation-grade). */
  envRequirements: string[];
  /** Measured wall time, seconds — feeds the "this will take a while" hint. */
  estimatedInstallSec?: number;
}

/**
 * What to run when the platform starts an agent task (04 §3 `buildStartCommand`).
 * `headless:false` is the S5 path: the provision workflow's `bootstrapAgentSession`
 * turns `initialPrompt` into "start the CLI carrying this instruction" (03 §4.3 ⑤).
 * `headless:true` is the MCP `run_agent_task` path, whose PRODUCTISATION is out of
 * S5 (TASK-LAUNCH-DECISIONS T-4) — the shape is defined here so adapters answer it
 * consistently when that slice lands.
 */
export interface RuntimeTaskSpec {
  prompt?: string;
  taskId?: string;
  headless: boolean;
  outputFormat?: 'text' | 'json-stream';
  extraArgs?: string[];
  /** Working directory inside the sandbox — the platform's workspace mount. */
  workdir?: string;
  /**
   * The previous turn's session reference (see `'session-started'` below). Present ⇒
   * "carry on from that conversation"; absent ⇒ a fresh one.
   *
   * WHY IT LIVES IN THE ADAPTER AND NOT IN PLATFORM-GENERIC CODE: each CLI spells
   * resumption differently — codex takes a SUBCOMMAND (`codex exec resume <ref>
   * [prompt]`), claude takes a FLAG (`claude -p --resume <ref>`, with `--session-id
   * <uuid>` additionally able to pin the id up front). Same reason `buildStartCommand`
   * owns switching each CLI's inner sandbox off (04 §3 ★2): the shapes have nothing
   * in common, so no generic wrapper can hold them.
   *
   * WHAT MAKES IT CHEAP: both CLIs persist conversation state INSIDE the sandbox by
   * default (codex under `$CODEX_HOME/sessions/<date>/rollout-<ts>-<id>.jsonl`; claude
   * under `$CLAUDE_CONFIG_DIR/projects/<encoded-cwd>/<session_id>.jsonl`). So resuming
   * within one sandbox needs no export/import at all — only the reference travels.
   * Verified end to end on both CLIs with real credentials (2026-08).
   *
   * ⚠️ THE RESUME INVOCATION IS NOT THE START INVOCATION WITH A FLAG ADDED. Measured:
   * `codex exec resume` accepts a DIFFERENT option set from `codex exec` — it has
   * neither `-s/--sandbox` nor `-C/--cd`. Since `-s danger-full-access` is exactly how
   * this adapter switches codex's inner sandbox off (★2), a resume built by appending
   * to the start argv dies with `unexpected argument '-s' found`; the equivalent must
   * go through `-c sandbox_mode="danger-full-access"` instead. Assume nothing carries
   * over between the two subcommands.
   *
   * CONFIRMATION SIGNAL: both CLIs echo the SAME id back on a successful resume
   * (codex in `thread.started`, claude in `system/init`), so the platform can verify a
   * resume really attached rather than trusting that it did. A reference that no longer
   * exists fails LOUDLY on both — exit 1, with codex writing nothing at all to stdout
   * and claude emitting `result/error_during_execution` with `is_error: true`.
   */
  resumeFrom?: string;
}

/**
 * A command an adapter wants run inside the sandbox.
 *
 * ⚠️ `env` is NOT a secret channel: the platform materialises it as `K=V` in front
 * of the command, and both argv and env are readable from inside the sandbox via
 * `ps` / `/proc/<pid>/cmdline` (04 §2.3★ 第 2 条). Credentials go through
 * `injectCredential` (0600 file / stdin) or the sandbox-creation env, never here.
 */
export interface SandboxCommand {
  cmd: string[];
  env?: Record<string, string>;
  cwd?: string;
}

/**
 * Measured event surfaces on the SUCCESS path (2026-08, real credentials, a task that
 * forces tool use). Both stay 100% clean JSONL on stdout with an empty stderr.
 *
 *   codex   top level  thread.started · turn.started · item.started · item.completed ·
 *                      turn.completed          (failure: turn.failed · error)
 *           item.type  agent_message{id,type,text}
 *                      command_execution{id,type,command,aggregated_output,exit_code,status}
 *                      file_change{id,type,changes:[{path,kind}],status}
 *
 *   claude  top level  system/init · system/thinking_tokens · assistant · user ·
 *                      result/success
 *           blocks     text · thinking{thinking,signature} ·
 *                      tool_use{id,name,input,caller} ·
 *                      tool_result{tool_use_id,content}   ← in a FOLLOWING `user` message
 *
 * ⚠️ The two shapes are NOT isomorphic: codex reports one item per call carrying its own
 * output, while claude splits call and result across two messages correlated by
 * `tool_use_id`. A shared parser cannot be written over these; each adapter maps its own
 * onto the union below, which is where they finally agree.
 */
export type RuntimeEventType =
  | 'session-started'
  | 'agent-message'
  | 'stdout-chunk'
  | 'tool-call'
  | 'task-complete'
  | 'error'
  | 'auth-required';

/**
 * ⚠️ THE PAYLOAD IS PINNED PER MEMBER, NOT `unknown`.
 *
 * This union used to be `{ type: RuntimeEventType; timestamp: string; data: unknown }`,
 * and that was a real defect rather than a stylistic one: with `data` opaque, a
 * consumer can only GUESS which field holds the text (`text`? `chunk`? `content`?
 * `message`?), so whether output renders at all depends on which name a producer
 * happened to pick — and renaming it breaks nothing at compile time and nothing in a
 * schema check. It fails silently, in the one place a user would notice first.
 *
 * Pinning the payload makes producer and consumer fail TOGETHER, at build time.
 *
 * ── `'agent-message'` vs `'stdout-chunk'` ────────────────────────────────────────
 * 04 §3 ★4 deferred this member with "do not guess one before a consumer needs it".
 * A consumer now does: the UI renders the agent's prose differently from its tool
 * calls. So codex's `agent_message` items and claude's `text` blocks map to
 * `'agent-message'`, and `'stdout-chunk'` is left for what its name says — RAW bytes
 * from a runtime with no structured mode.
 *
 * ── `'tool-call'` covers BOTH halves of a call ───────────────────────────────────
 * `status` distinguishes them, and `id` is the correlation key. codex fills both
 * halves from one item; claude emits `started` from a `tool_use` block and
 * `completed` later from the `tool_result` in a FOLLOWING `user` message.
 *
 * ⚠️ On claude's `completed` half the tool NAME is empty: `tool_result` carries only
 * `tool_use_id`, and the parser is stateless per line ON PURPOSE — a lookup table
 * would make a live parse and a replayed parse produce different payloads. Consumers
 * correlate by `id`, where the name already arrived with the `started` event.
 *
 * `timestamp` is ISO-8601 and may be EMPTY as produced: `parseOutput` runs in
 * infrastructure, which has no `Clock` (01 §3), and none of the CLI events carries a
 * time of its own. The application layer stamps it before the event goes anywhere.
 */
export type RuntimeEvent =
  /** The CLI's own conversation id — store it, hand it back as `resumeFrom` next turn. */
  | { type: 'session-started'; timestamp: string; data: { ref: string } }
  /** The agent's own prose. */
  | { type: 'agent-message'; timestamp: string; data: { text: string } }
  /** Raw bytes from a runtime with no structured output mode. */
  | { type: 'stdout-chunk'; timestamp: string; data: { text: string } }
  /**
   * One HALF of a tool call. `id` correlates the two halves; `status` discriminates
   * the payload.
   *
   * ⚠️ `name` LIVES ONLY ON `started`, AND THAT IS THE POINT. It was briefly on both
   * halves, which forced claude's completed half to send an EMPTY name — `tool_result`
   * carries only `tool_use_id`, and the parser is stateless per line ON PURPOSE (an
   * id→name table would make a live parse and a replayed parse produce DIFFERENT
   * payloads for the same bytes, which is the one thing `seq` replay must never do).
   * A required field that is sometimes a lie is the same silent-payload defect this
   * union was pinned to remove — so the field simply is not there when it is not
   * knowable. Consumers pair by `id`, where the name already arrived.
   */
  | {
      type: 'tool-call';
      timestamp: string;
      data:
        | { status: 'started'; id: string; name: string; input?: unknown }
        | {
            status: 'completed';
            id: string;
            /**
             * A REAL process exit code, or absent. It is NEVER synthesised.
             */
            exitCode?: number;
            /**
             * The tool itself reported failure.
             *
             * ⚠️ THE ONLY REASON THIS FIELD EXISTS IS TO KEEP SYNTHESISED VALUES OUT OF
             * `exitCode`. codex reports a real exit code; claude reports a boolean
             * (`tool_result.is_error`) and no code at all. Folding the boolean into
             * `exitCode` as a 1 would put a MEASURED 1 and a MANUFACTURED 1 in the same
             * field, indistinguishable to every consumer — the same silent-payload
             * defect this union was pinned to remove, just relocated. (It is NOT
             * comparable to reporting a sandbox-side hard timeout as 124: that is a real
             * process's real exit code, not a boolean dressed up as one.)
             *
             * So each runtime says what it actually knows and neither impersonates the
             * other. Absent means "no failure was reported", not "it succeeded".
             * Consumers judge failure as:
             *   `isError === true || (exitCode !== undefined && exitCode !== 0)`
             */
            isError?: boolean;
            output?: string;
          };
    }
  /**
   * The runtime says the turn finished. The payload is EMPTY, deliberately.
   *
   * ⚠️ THE EXIT CODE IS NOT HERE — it is on the `/tasks` `exit` frame. Measured:
   * neither CLI puts one in its completion event, because the process's exit status is
   * the JOB's fact, not the turn's. An optional field with no producer only sends the
   * next reader looking for something that is never populated.
   */
  | { type: 'task-complete'; timestamp: string; data: Record<string, never> }
  | { type: 'error'; timestamp: string; data: { message: string } }
  /** ⏳ Not produced by either built-in adapter yet — no measured shape to map from. */
  | { type: 'auth-required'; timestamp: string; data: { method?: string } };

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
  /**
   * 启动前把 runtime 需要的文件落进它的 HOME —— **与凭证无关**。
   *
   * 为什么不能挂在 `injectCredential` 上（这是本钩子存在的全部理由）：那条路**只在
   * 有凭证时才跑**（`prepareRuntimeCredential` 抛 `NO_CREDENTIAL` 时整步跳过），
   * 而这里要处理的闸门在**没有凭证时照样拦**。实测的那个：codex 首次在某目录里启动
   * 会停在 "Do you trust the contents of this directory?" 等人按键 —— 没凭证也一样停，
   * 于是 agent 连"我没登录"都报不出来，界面上只是一个不动的终端。
   *
   * 可选：绝大多数 runtime 不需要。没实现 = 不落任何文件，与本钩子出现之前完全一致
   * （所以它不是"每个 adapter 都要补一遍"的负担）。
   *
   * ⚠️ 实现方注意：这一步跑在**每次 provision** 上（含重启），必须幂等。
   */
  seedStartupFiles?(spec: RuntimeStartupSpec, exec: SandboxExecFn): Promise<void>;

  injectCredential(cred: InjectableRuntimeCredential, exec: SandboxExecFn): Promise<void>;

  // ── run half (04 §3; added in S5) ────────────────────────────────────────────
  /**
   * PURE verdict on "(this image, this runtime) → install or not, how long" (★1).
   * No IO, no network — it is called on the request path too, only to warn.
   */
  getInstallPlan(imageSpec: ResolvedImageSpec): RuntimeInstallPlan;
  /**
   * Idempotent probe. MUST go through `command -v` / PATH lookup and MUST NOT
   * hard-code an install path (04 §2.1★ / RA-01): the npm prefix is a user-level
   * non-standard location (`/home/gem/.npm-global`) and `codex` actually resolves
   * to an fnm shim — any hard-coded path is wrong on BOTH built-in providers.
   */
  isInstalled(exec: SandboxExecFn): Promise<boolean>;
  /**
   * Install the CLI per the plan. MUST be re-enterable: a half-failed attempt
   * re-run must converge (RA-02; measured re-entry cost is ~6s, so no incremental
   * recovery machinery is warranted).
   */
  install(exec: SandboxExecFn): Promise<void>;
  /**
   * The command that STARTS an agent task. Pure. This is where the two things
   * platform-generic logic cannot own live (04 §3 ★2): ① turning OFF the CLI's own
   * inner sandbox — codex's bwrap cannot create a mount namespace inside either
   * provider, so it is disabled with `-s danger-full-access`, while claude has no
   * bwrap at all and uses its permission model instead; the two have NO common
   * shape, so this stays per-runtime. ② the CLI's own timeout flag as a first line
   * (the platform's forced kill is the only reliable one, ★3).
   */
  buildStartCommand(task: RuntimeTaskSpec): SandboxCommand;
  /** What a terminal session runs when there is no instruction to carry. Pure. */
  buildAttachCommand(): SandboxCommand;
  /** Optional: structure raw CLI output; unimplemented ⇒ the platform passes bytes. */
  parseOutput?(chunk: Buffer): RuntimeEvent[];
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

/**
 * "This id is not in the registry" — the registry's OWN failure, with its own code.
 *
 * ⚠️ WHY IT IS NOT `INSTALL_FAILED` (04 §4). It used to be: `ensureRuntimeInstalled`
 * raised `RuntimeInstallFailedError('unknown runtime …')`, so a request naming a
 * runtime that does not exist reached the user as 「运行时 CLI 安装失败(该镜像未预装,
 * 现装未成功)」 — a sentence about an install that was never attempted, for a CLI that
 * has no adapter. The code is what the frontend keys its 人话 on (P22 §1), so a wrong
 * code is a wrong explanation, every time, with no way for the reader to tell.
 *
 * ⚠️ AND WHY IT IS NOT `retryable`. `INSTALL_FAILED` is retryable — an npm install can
 * work on the second try. An unregistered id cannot: nothing about waiting or retrying
 * puts an adapter in the registry. Inheriting `retryable: true` would have rendered a
 * [重试] button whose every press is guaranteed to fail.
 *
 * Since the create door now refuses an unregistered runtime SYNCHRONOUSLY
 * (`SandboxApplicationService.create`, 04 §5 / 14 §10), this should be UNREACHABLE from
 * a fresh create. It stays because the door is not the only entrance: a task resumed
 * after a restart, or a terminal attaching to an existing sandbox, can name a runtime
 * whose out-of-tree module is no longer loaded (04 §8) — and that is exactly the case
 * that must say what it is instead of borrowing a neighbour's code.
 */
export const UNKNOWN_RUNTIME = 'UNKNOWN_RUNTIME';

export class UnknownRuntimeError extends Error {
  readonly code = UNKNOWN_RUNTIME;
  readonly retryable = false;
  constructor(readonly runtimeId: string) {
    super(`unknown runtime '${runtimeId}'`);
    this.name = 'UnknownRuntimeError';
  }
}
