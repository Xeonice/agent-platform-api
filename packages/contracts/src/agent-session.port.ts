import type { SandboxExecFn } from './runtime-adapter.contract';

/**
 * Cross-context port for the REVERSE direction terminal ⇄ sandbox (23 §10.4, the
 * only sanctioned one): the sandbox provision workflow has to start an agent
 * session in the `starting` 段 (03 §4.3 ⑤) but MUST NOT hold a pty itself. It calls
 * this facade; the terminal context owns the session.
 *
 * WHY IT MOVED HERE AT ALL (裁决 D-15 / T-2): "the agent starts working the moment
 * the task starts" is a product promise (P20 §0, 02 §5.2), but it used to be bound
 * to the FIRST terminal `openSession`. That meant ① create-then-close-the-browser
 * ⇒ the instruction never runs, and ② MCP `create_sandbox` has no terminal at all
 * ⇒ it can NEVER run. Both disappear once provision triggers it.
 */
export const AGENT_SESSION_BOOTSTRAP = Symbol('AgentSessionBootstrap');

/**
 * The tmux session the platform owns inside every sandbox. It is held by the
 * sandbox's OWN tmux server — the platform keeps no connection to it, which is
 * exactly why restarting the backend does not interrupt a running agent (the
 * decisive reason tmux was raised from SHOULD to MUST, 04 §7 ★).
 */
export const PLATFORM_AGENT_TMUX_SESSION = 'platform-agent';

export interface BootstrapAgentSessionInput {
  sandboxId: string;
  runtimeId: string;
  /** The stored `initialPrompt`; empty/absent ⇒ a plain attach session is started. */
  initialPrompt?: string;
  /** Working directory inside the sandbox (the workspace mount). */
  workdir: string;
  /** Derived from `spawn({tty:false})` — hence only valid after `provider.start()`. */
  exec: SandboxExecFn;
}

export interface BootstrapAgentSessionResult {
  /** True when the session was started from `buildStartCommand` (prompt carried). */
  promptConsumed: boolean;
  /** True when a session already existed and was left alone (re-entrant provision). */
  reusedExisting: boolean;
}

export interface AgentSessionBootstrap {
  bootstrapAgentSession(input: BootstrapAgentSessionInput): Promise<BootstrapAgentSessionResult>;
}

/**
 * `IMAGE_CONTRACT_VIOLATION` (04 §4) — an image that PASSED registration-time
 * `validate()` but is disproved by a live probe inside the sandbox. Today the one
 * and only trigger is `command -v tmux` missing right before the agent session is
 * started (04 §7 ★ / 03 §4.3 ⑤).
 *
 * WHY NOT REUSE `MANIFEST_INVALID`: that is the STATIC, registration-time verdict of
 * `ImageSpecProvider.validate()`. "registration should have caught this and did not"
 * and "the registration verdict has gone stale" lead to different next actions when
 * someone is debugging, and merging them into one code erases that distinction.
 *
 * `retryable:false` on purpose: retrying will not put tmux into the image; the
 * correct action is to change the image.
 */
export const IMAGE_CONTRACT_VIOLATION = 'IMAGE_CONTRACT_VIOLATION';

export class ImageContractViolationError extends Error {
  readonly code = IMAGE_CONTRACT_VIOLATION;
  readonly retryable = false;
  constructor(message: string) {
    super(message);
    this.name = 'ImageContractViolationError';
  }
}
