import { RuntimeAuthModeChanged } from '../events/runtime-events';

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
  /**
   * 本次工作单元里攒下的 `RuntimeAuthModeChanged`（与 `RuntimeInstallation` 同一套
   * 局部实现：runtime 上下文的实体不继承 `AggregateRoot`）。
   */
  private readonly _events: RuntimeAuthModeChanged[] = [];

  private constructor(p: RuntimeSettingsProps) {
    this.runtimeId = p.runtimeId;
    this._activeAuthMethod = p.activeAuthMethod;
    this._updatedAt = p.updatedAt;
  }

  /**
   * 建行，**不发事件**。
   *
   * ⚠️ 无条件在这里 raise 是个陷阱：另一个调用点是 credential 上下文首次存凭证时顺手
   * 建行（`RuntimeSettingsReaderWriter.saveSync`，R-1 ②），它跑在**别人的事务**里、
   * 从不 `pullEvents()` —— 那条路径会把事件静默吞掉，而被吞掉的事件比压根没有的事件
   * 更难查。显式切换那条路径请用 `configureFirst()`。
   */
  static create(runtimeId: string, mode: RuntimeAuthMode, now: Date): RuntimeSettings {
    if (!runtimeId) throw new Error('RuntimeSettings requires a runtimeId');
    return new RuntimeSettings({ runtimeId, activeAuthMethod: mode, updatedAt: now });
  }

  /**
   * 首次配置**经由 `PUT /api/runtimes/:rt/auth-mode`** —— 带事件的 `create`
   * （24 §214「首配时一并产生」）。`from` 为 `null`：此前没有这一行，没有来处可写。
   */
  static configureFirst(runtimeId: string, mode: RuntimeAuthMode, now: Date): RuntimeSettings {
    const settings = RuntimeSettings.create(runtimeId, mode, now);
    settings._events.push(new RuntimeAuthModeChanged(runtimeId, null, mode, now));
    return settings;
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

  /**
   * Switch the effective mode (I-RTS-2 credential existence is checked upstream).
   *
   * ⚠️ **切到已经生效的那一档不发事件。** 那一次 PUT 什么都没改变，落一条
   * `account → account` 的审计行只会让「这一天到底换过几次」变得更难数。
   */
  switchTo(mode: RuntimeAuthMode, now: Date): void {
    const from = this._activeAuthMethod;
    this._activeAuthMethod = mode;
    this._updatedAt = now;
    if (from !== mode) {
      this._events.push(new RuntimeAuthModeChanged(this.runtimeId, from, mode, now));
    }
  }

  /** Drain the mode-change events for the caller's transaction. */
  pullEvents(): RuntimeAuthModeChanged[] {
    return this._events.splice(0);
  }
}
