import { RuntimeInstallationStateChanged } from '../events/runtime-events';

/**
 * The 4-value install state (13 §2.3.2). Declared HERE rather than imported from
 * `@platform/contracts`: 23 §4.5 forbids `domain → contracts`, and the domain must
 * not depend on the wire package. The application layer holds a compile-time parity
 * guard against the contracts enum, so the two literal unions cannot drift silently.
 */
export type RuntimeInstallState = 'not_installed' | 'installing' | 'installed' | 'failed';

/**
 * RuntimeInstallation aggregate (docs/backend/23 §7.2, 13 §2.3.2).
 *
 * 裁决 D-5 — it is an INDEPENDENT small aggregate keyed by a weak `sandboxId`
 * reference, NOT part of `Sandbox`. It runs its own state machine
 * (`not_installed → installing → installed | failed`), and folding it into the
 * sandbox would mean one aggregate running two state machines while every install
 * step contends for the sandbox's optimistic lock. Its progress therefore does NOT
 * appear in `sandboxes.status` — it is projected to WS `runtime.install_progress`
 * instead (23 §12), which is all the frontend needs to answer "stuck where?".
 *
 * Invariants:
 *   - I-RIN-1: `(sandboxId, runtimeId)` is unique (enforced by a unique index too).
 *   - I-RIN-2: `installed` ⇒ `versionDetected` is non-empty. The version comes from a
 *     REAL `--version` probe, never inferred from a path (13 §2.3.2 / 04 §2.1★).
 */
export interface RuntimeInstallationProps {
  id: string;
  sandboxId: string;
  runtimeId: string;
  status: RuntimeInstallState;
  versionDetected: string | null;
  installedAt: Date | null;
  lastCheckedAt: Date;
  error: string | null;
}

export class RuntimeInstallation {
  readonly id: string;
  readonly sandboxId: string;
  readonly runtimeId: string;
  private _status: RuntimeInstallState;
  private _versionDetected: string | null;
  private _installedAt: Date | null;
  private _lastCheckedAt: Date;
  private _error: string | null;
  private readonly _events: RuntimeInstallationStateChanged[] = [];

  private constructor(p: RuntimeInstallationProps) {
    this.id = p.id;
    this.sandboxId = p.sandboxId;
    this.runtimeId = p.runtimeId;
    this._status = p.status;
    this._versionDetected = p.versionDetected;
    this._installedAt = p.installedAt;
    this._lastCheckedAt = p.lastCheckedAt;
    this._error = p.error;
  }

  /**
   * Open the record at its INITIAL status (13 §2.3.2). The initial value is decided
   * by `getInstallPlan(imageSpec)` + a live `isInstalled(exec)` probe — which is
   * precisely why this cannot be written inside the create transaction T1: at T1
   * there is no running instance to probe, so the value is physically undecidable
   * there (not merely "against the rules").
   */
  static open(input: {
    id: string;
    sandboxId: string;
    runtimeId: string;
    status: RuntimeInstallState;
    versionDetected?: string | null;
    now: Date;
  }): RuntimeInstallation {
    const inst = new RuntimeInstallation({
      id: input.id,
      sandboxId: input.sandboxId,
      runtimeId: input.runtimeId,
      status: 'not_installed',
      versionDetected: null,
      installedAt: null,
      lastCheckedAt: input.now,
      error: null,
    });
    inst.moveTo(input.status, input.now, {
      versionDetected: input.versionDetected ?? undefined,
    });
    return inst;
  }

  static rehydrate(p: RuntimeInstallationProps): RuntimeInstallation {
    return new RuntimeInstallation(p);
  }

  get status(): RuntimeInstallState {
    return this._status;
  }
  get versionDetected(): string | null {
    return this._versionDetected;
  }
  get installedAt(): Date | null {
    return this._installedAt;
  }
  get lastCheckedAt(): Date {
    return this._lastCheckedAt;
  }
  get error(): string | null {
    return this._error;
  }

  /** Enter `installing` — a REAL state, not a formality: a cold claude-code install
   *  was measured at 753s (04 §3 ★1), and a minute-scale window with no intermediate
   *  state cannot be explained to a waiting user. */
  markInstalling(now: Date): void {
    this.moveTo('installing', now);
  }

  /** Enter `installed`; `versionDetected` is mandatory here (I-RIN-2). */
  markInstalled(version: string, now: Date): void {
    if (version.trim() === '') {
      throw new Error('I-RIN-2: an installed runtime must carry a detected version');
    }
    this.moveTo('installed', now, { versionDetected: version.trim() });
  }

  markFailed(error: string, now: Date): void {
    this.moveTo('failed', now, { error });
  }

  /**
   * Drain the state-change events for the caller's transaction. Every move produces
   * one; they are the source of WS `runtime.install_progress` (23 §12).
   */
  pullEvents(): RuntimeInstallationStateChanged[] {
    return this._events.splice(0);
  }

  private moveTo(
    next: RuntimeInstallState,
    now: Date,
    extra?: { versionDetected?: string; error?: string },
  ): void {
    this._status = next;
    this._lastCheckedAt = now;
    if (extra?.versionDetected !== undefined) this._versionDetected = extra.versionDetected;
    if (next === 'installed') this._installedAt = now;
    // a successful outcome clears the previous attempt's error, so a retried install
    // does not leave a stale reason attached to an `installed` row.
    this._error = next === 'failed' ? (extra?.error ?? null) : null;
    this._events.push(
      new RuntimeInstallationStateChanged(
        this.sandboxId,
        this.runtimeId,
        next,
        this._versionDetected ?? undefined,
        this._error ?? undefined,
        now,
      ),
    );
  }
}
