import type { ProcessStream } from './sandbox-provider.contract';

/**
 * Cross-context port (docs/backend/06 §3, 01 §5): the `terminal` context opens a
 * PTY on a sandbox WITHOUT reaching into the `sandbox` context's internals. The
 * `sandbox` context provides the implementation (it resolves the provider +
 * handle and calls `provider.spawn({ tty:true })`); `terminal` depends only on
 * this interface. Living in `contracts` keeps both sides boundaries-clean.
 */
export interface OpenPtyOptions {
  cols: number;
  rows: number;
  /** re-attach to an existing session ref (06 §6). */
  reuse?: string;
  /**
   * What the pty should run. Since S5 the terminal gateway ALWAYS attaches the
   * platform-owned tmux session started by provision (`tmux attach -t
   * platform-agent`, 26 §8) — it no longer decides "is this the first session?"
   * and no longer calls `buildStartCommand`. Absent ⇒ the sandbox's default shell.
   */
  cmd?: string[];
}

export interface SandboxPtyPort {
  openPty(sandboxId: string, opts: OpenPtyOptions): Promise<ProcessStream>;
}

export const SANDBOX_PTY_PORT = Symbol('SandboxPtyPort');
