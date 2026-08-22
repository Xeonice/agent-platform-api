import type { SandboxExecFn } from './runtime-adapter.contract';

/**
 * Cross-context port (01 §5, sibling of `SANDBOX_PTY_PORT`): the `terminal` context
 * needs to ASK a live sandbox things — "is the platform tmux session still there?" —
 * and needs to know which runtime it hosts in order to ask that runtime's adapter
 * for an attach command. Both are sandbox-context facts; terminal gets them through
 * this port instead of reaching into the sandbox aggregate.
 *
 * The exec handed back is the `toExecFn(provider, handle)` derivation (04 §2.3), so
 * it is only usable once the instance is running.
 */
export const SANDBOX_EXEC_PORT = Symbol('SandboxExecPort');

/** Where the platform mounts the per-task workspace inside every sandbox (03 §7.1). */
export const SANDBOX_WORKSPACE_MOUNT = '/workspace';

export interface SandboxRuntimeBinding {
  sandboxId: string;
  /** Registry key of the runtime this sandbox hosts (`codex` / `claude-code` / …). */
  runtimeId: string;
  /** Working directory inside the sandbox. */
  workdir: string;
}

export interface SandboxExecPort {
  execFor(sandboxId: string): Promise<SandboxExecFn>;
  bindingOf(sandboxId: string): Promise<SandboxRuntimeBinding>;
}
