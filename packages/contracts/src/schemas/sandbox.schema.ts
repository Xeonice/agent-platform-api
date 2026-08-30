import { z } from 'zod';
import type { SandboxProviderCapabilities } from '../sandbox-provider.contract';
import { SandboxStatusSchema, TimeoutMinutesSchema } from './enums';

/**
 * zod single source (docs/backend/02 §3). These schemas produce, from one place:
 *   - REST DTO (via createZodDto in the interface layer)
 *   - Swagger/OpenAPI reflection (nestjs-zod patchNestJsSwagger)
 *   - MCP tool inputSchema (@Tool parameters)
 * Wire types are camelCase (02 §5.1).
 */

/**
 * The capability bits a create request may DEMAND (04 §5 「创建前静态校验」, the
 * `requireSnapshot` rule generalised to one field per bit). A bit set to `true` that
 * the chosen provider does not advertise → the request is rejected in the application
 * layer BEFORE scheduling, with `UNSUPPORTED_CAPABILITY`.
 *
 * `watchEvents` is deliberately NOT requestable: push-vs-poll is fully encapsulated
 * from callers (04 §5), so "require watchEvents" would mean nothing to an API client.
 */
export const RequiredCapabilitiesSchema = z.object({
  spawnTty: z.boolean().optional(),
  volumeMount: z.boolean().optional(),
  updateResources: z.boolean().optional(),
  pauseResume: z.boolean().optional(),
  snapshot: z.boolean().optional(),
});
export type RequiredCapabilities = z.infer<typeof RequiredCapabilitiesSchema>;

export const CreateSandboxSchema = z.object({
  projectId: z.string().min(1),
  /**
   * Which branch the Task's workspace starts on (10 §7.3, 03 §7.2★). Values come from
   * `GET /api/projects/:id/branches`; omitted ⇒ whatever the baseline has checked out.
   *
   * It is validated at the create DOOR against the baseline's LOCAL refs — a branch the
   * project does not have is refused 零副作用 rather than failing half-way through
   * `preparing-workspace`. Making it good is a single local `git checkout` in the fresh
   * copy, which is only possible because the baseline is cloned in FULL (03 §7.2★): a
   * `--depth=1 --single-branch` baseline has exactly one branch ref and every other
   * name dies as `pathspec … did not match`.
   */
  branch: z.string().min(1).max(255).optional(),
  runtime: z.string().min(1),
  image: z.string().optional(),
  provider: z.string().optional(),
  /**
   * 可选任务指令。上限 8000 与 `RunAgentTaskSchema.prompt` 同一口径(10 §7.3
   * 「≤8000 字符」明确写的是 `initialPrompt`),**两处必须同步**。
   *
   * ⚠️ 之前这里是裸 `z.string().optional()` —— 契约文档写着上限、Task 面照做了、
   * 而创建面没有,于是同一段文字走 `POST /api/sandboxes` 无上限、走
   * `POST .../tasks` 8000 截断。它会原样落进 `sandboxes.initial_prompt`,再被
   * `buildStartCommand` 拼进 argv;门口不收,后面每一层都只能替它承担。
   */
  initialPrompt: z.string().max(8000).optional(),
  headless: z.boolean().optional(),
  timeoutMinutes: TimeoutMinutesSchema.optional(),
  /**
   * Capability preconditions; checked against the provider before scheduling (04 §5).
   *
   * `headlessTask` is deliberately NOT requestable here, for the same reason
   * `watchEvents` is not: `headless: true` already IMPLIES it, so the platform derives
   * the requirement instead of making every caller restate it.
   */
  require: RequiredCapabilitiesSchema.optional(),
});
export type CreateSandboxInput = z.infer<typeof CreateSandboxSchema>;

/** Wire mirror of the SPI capability struct (04 §2.5) — all 7 bits, none optional. */
export const SandboxProviderCapabilitiesSchema = z.object({
  spawnTty: z.boolean(),
  volumeMount: z.boolean(),
  updateResources: z.boolean(),
  pauseResume: z.boolean(),
  snapshot: z.boolean(),
  watchEvents: z.boolean(),
  headlessTask: z.boolean(),
});

type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type AssertTrue<T extends true> = T;

/**
 * Compile-time parity guard: adding an 8th bit to `SandboxProviderCapabilities` (or
 * renaming one) fails typecheck HERE until the wire schema follows, so `GET /providers`
 * can never quietly under-report what a provider advertises. Exported only so it is a
 * checked declaration rather than dead code — nothing needs to import it.
 */
export type SandboxProviderCapabilitiesWireParity = AssertTrue<
  Exact<z.infer<typeof SandboxProviderCapabilitiesSchema>, SandboxProviderCapabilities>
>;

/**
 * `GET /api/providers` row (04 §5 「能力发现」). Registry-driven: a provider registered
 * out-of-tree appears here automatically, and the frontend shows/hides per-capability
 * controls from `capabilities` instead of hard-coding a provider list.
 */
export const ProviderDtoSchema = z.object({
  name: z.string(),
  capabilities: SandboxProviderCapabilitiesSchema,
  /** True for the provider `create` uses when the request names none. */
  isDefault: z.boolean(),
});
export type ProviderDto = z.infer<typeof ProviderDtoSchema>;

export const ListSandboxesQuerySchema = z.object({
  projectId: z.string().min(1).optional(),
});
export type ListSandboxesQuery = z.infer<typeof ListSandboxesQuerySchema>;

/** DELETE /api/sandboxes/:id body — keepVolume retains the workspace dir (03 §7.7). */
export const DestroySandboxSchema = z.object({
  keepVolume: z.boolean().optional(),
});
export type DestroySandboxInput = z.infer<typeof DestroySandboxSchema>;

export const SandboxDtoSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  runtime: z.string(),
  /**
   * WHICH provider this sandbox actually runs on (`aio` / `boxlite` / a third-party
   * registry key).
   *
   * It is on the DTO because the frontend gates controls on provider CAPABILITIES —
   * e.g. whether the "start a headless Task" entry point is enabled at all depends on
   * `headlessTask`, which is looked up per provider through `GET /api/providers`.
   * Without this field that lookup has no key after a page reload, and the UI can only
   * degrade to "enable it and let the backend answer 409" — i.e. an error path used as
   * a feature check.
   */
  provider: z.string(),
  /**
   * Task display name. The DEFAULT is derived BY THE BACKEND at create time from
   * `initialPrompt` (first non-blank line, first 20 UTF-8 code points, + `…`;
   * no instruction ⇒ `'<Runtime> · <timestamp>'`) — rule authority P21-1 §9.
   *
   * This field is what makes the "no `initialPrompt` echo" decision workable: the
   * only display consumer of the instruction was the default task name, and that
   * now lives here (10 §7.3 / TASK-LAUNCH-DECISIONS T-1).
   */
  name: z.string(),
  status: SandboxStatusSchema,
  headless: z.boolean(),
  timeoutMinutes: TimeoutMinutesSchema.nullable(),
  idleTimeoutSec: z.number().int().positive(),
  /** derived, projected from the terminal gateway; never persisted (28 §4). */
  waitingInput: z.boolean(),
  version: z.number().int().nonnegative(),
  /**
   * Machine-readable cause when `status === 'failed'` — e.g. `IMAGE_CONTRACT_VIOLATION`,
   * `INSTALL_FAILED`, `IMAGE_PULL_FAILED` (04 §4 的错误码闭集).
   *
   * WHY IT EXISTS AT ALL: provisioning is ASYNCHRONOUS — the caller already holds its
   * 202 by the time anything can fail, so there is no HTTP response left to carry the
   * code (04 §4 note). The live signal is WS `sandbox.status_changed.errorCode`, but a
   * WS event missed (page not open, reload, reconnect) is gone forever; this field is
   * how the reason SURVIVES A REFRESH.
   *
   * It is a CODE, never a sentence: 02 §6.1 / P22 §1 own the 人话, keyed on the code.
   * The free-text detail rides in `failureMessage` and is a debugging aid, not copy.
   */
  failureCode: z.string().optional(),
  /** Free-text detail behind `failureCode` (never the user-facing sentence). */
  failureMessage: z.string().optional(),
  // ★ DELIBERATELY ABSENT: `initialPrompt` (S5 裁决 D-14, TASK-LAUNCH-DECISIONS T-1).
  //   The backend DOES persist it (`sandboxes.initial_prompt`, 13 §2.1.1) — the
  //   decision is only about echoing it back. The decisive reason is the MCP面:
  //   `list_sandboxes` / `get_sandbox` share THIS dto with REST, so echoing would let
  //   one coaxed upstream agent read every historical task instruction (repo paths,
  //   internal system names, business context) in a single call. Adding a field later
  //   is easier than removing one.
});
export type SandboxDto = z.infer<typeof SandboxDtoSchema>;

/**
 * `POST /api/sandboxes/:id/exec` body (10 §7.3 `ExecRequest`).
 *
 * ⚠️ ONE FIELD, AND THAT IS THE WHOLE CONTRACT. 10 §7.3 spells it
 * `interface ExecRequest { command: string; }` — no `timeoutMs`, no `cwd`, no `env`.
 * The deadline is a PLATFORM constant (see `EXEC_TIMEOUT_MS` in
 * `sandbox-application.service.ts`), not a caller-supplied number: this endpoint is a
 * synchronous request/response, so a caller-chosen budget would only decide how long
 * an HTTP connection is held open — and `run_agent_task` already exists for anything
 * that legitimately runs for minutes or hours.
 *
 * ⚠️ INTERACTIVE WORK DOES NOT COME HERE (27 §2): a TTY session is WS `/terminal`.
 * A command that waits for input on this path simply burns the deadline and returns
 * `TIMEOUT`.
 */
export const ExecInSandboxSchema = z.object({
  /** Run through `sh -c`, so shell syntax (pipes, redirects, `&&`) works as written. */
  command: z.string().min(1).max(8000),
});
export type ExecInSandboxInput = z.infer<typeof ExecInSandboxSchema>;

/**
 * `ExecResult` (10 §7.3) — what the one-shot exec produced.
 *
 * ⚠️ `stderr` IS STRUCTURALLY ALWAYS EMPTY TODAY, AND THAT IS NOT A BUG TO PAPER OVER.
 * `ProcessStream` is a single DEMULTIPLEXED byte stream (04 §2.4), so `toExecFn` cannot
 * reconstruct the split — everything the command wrote arrives on `stdout`
 * (`exec-fn.ts` says so at the point where the merge happens). The field is on the wire
 * because the contract names it and because a provider that CAN separate the two would
 * fill it; callers that need the split redirect inside the command (`2>&1`, `2>/dev/null`).
 * Dropping the field would be a lie in the other direction — it would tell callers the
 * platform has no notion of stderr at all.
 */
export const ExecResultSchema = z.object({
  stdout: z.string(),
  stderr: z.string(),
  /** A process killed by a signal has no ordinary exit code; it surfaces as `-1` (SP-09). */
  exitCode: z.number().int(),
});
export type ExecResult = z.infer<typeof ExecResultSchema>;
