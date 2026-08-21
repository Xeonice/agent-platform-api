/**
 * RuntimeSettings aggregate (docs/backend/23 §7.1, 13 §2.3.1). One row per runtime.
 * Invariants:
 *   - I-RTS-1: `activeAuthMethod ∈ {'account','api-key'}`
 *   - I-RTS-2: switching to a mode with NO credential is rejected in the application
 *     layer (409) BEFORE this aggregate is mutated — a cross-aggregate check.
 *   - I-RTS-3: first credential config auto-creates the row at that mode.
 */
export type RuntimeAuthMode = 'account' | 'api-key';

export interface RuntimeSettingsProps {
  runtimeId: string;
  activeAuthMethod: RuntimeAuthMode;
  updatedAt: Date;
}

export class RuntimeSettings {
  readonly runtimeId: string;
  private _activeAuthMethod: RuntimeAuthMode;
  private _updatedAt: Date;

  private constructor(p: RuntimeSettingsProps) {
    this.runtimeId = p.runtimeId;
    this._activeAuthMethod = p.activeAuthMethod;
    this._updatedAt = p.updatedAt;
  }

  static create(runtimeId: string, mode: RuntimeAuthMode, now: Date): RuntimeSettings {
    if (!runtimeId) throw new Error('RuntimeSettings requires a runtimeId');
    return new RuntimeSettings({ runtimeId, activeAuthMethod: mode, updatedAt: now });
  }

  static rehydrate(p: RuntimeSettingsProps): RuntimeSettings {
    return new RuntimeSettings(p);
  }

  get activeAuthMethod(): RuntimeAuthMode {
    return this._activeAuthMethod;
  }
  get updatedAt(): Date {
    return this._updatedAt;
  }

  /** Switch the effective mode (I-RTS-2 credential existence is checked upstream). */
  switchTo(mode: RuntimeAuthMode, now: Date): void {
    this._activeAuthMethod = mode;
    this._updatedAt = now;
  }
}
