import type { ResolvedImageSpec } from './sandbox-provider.contract';
import type { SandboxExecFn } from './runtime-adapter.contract';

/**
 * Cross-context port (docs/backend/26 §1 step ③, 03 §4.3 ③): the sandbox provision
 * workflow must run `ensureRuntimeInstalled` — `getInstallPlan` → `isInstalled` →
 * (if needed) `install` — but the `runtime_installations` aggregate belongs to the
 * RUNTIME context (23 D-5). The sandbox side owns the `exec` (it holds the provider
 * handle); the runtime side owns the adapter, the aggregate and its transactions.
 * The port is the seam, so neither imports the other's internals.
 *
 * TRANSACTION RULE the implementation must honour (13 §2.3.2 / 23 §4.3): every write
 * here happens in its OWN short transaction, NEVER in the create transaction T1 —
 * and cannot anyway, because the `installed` verdict requires a probe against a
 * RUNNING instance that does not exist at T1 time.
 */
export const RUNTIME_INSTALL_ORCHESTRATOR = Symbol('RuntimeInstallOrchestrator');

export interface EnsureRuntimeInstalledInput {
  sandboxId: string;
  runtimeId: string;
  /** The image the sandbox actually runs — `getInstallPlan` is keyed on it (★1). */
  image: ResolvedImageSpec;
  /** Derived from `spawn({tty:false})`; only exists after `provider.start()`. */
  exec: SandboxExecFn;
}

export interface RuntimeInstallOrchestrator {
  /**
   * Bring the runtime CLI to "present in this sandbox", recording each state change
   * on the `RuntimeInstallation` aggregate (⇒ WS `runtime.install_progress`).
   * Throws `RuntimeInstallFailedError` on failure; the caller compensates the whole
   * `starting` 段 exactly as any other failure there (24 §1.3).
   */
  ensureInstalled(input: EnsureRuntimeInstalledInput): Promise<void>;
}

/**
 * `INSTALL_FAILED` (04 §4 RuntimeAdapter 同构错误码) as a boundaries-safe class the
 * sandbox context can catch without importing the runtime context.
 *
 * Its MAIN exposure is NOT HTTP: installing happens in the provision workflow, long
 * after the caller received its 202, so there is no synchronous response to carry it
 * (04 §4 note). The real path is `starting → failed` + `failure_reason` + WS
 * `sandbox.status_changed`. The 500 mapping exists so a future synchronous entry
 * point (a "retry install" endpoint) has a rule, and to satisfy 02 §6.2's
 * "every code must map, nothing is ever thrown bare".
 */
export const INSTALL_FAILED = 'INSTALL_FAILED';

export class RuntimeInstallFailedError extends Error {
  readonly code = INSTALL_FAILED;
  readonly retryable = true;
  constructor(message: string) {
    super(message);
    this.name = 'RuntimeInstallFailedError';
  }
}
