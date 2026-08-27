import type { DomainEvent } from '@platform/shared-kernel';
import type { RuntimeInstallState } from '../entities/runtime-installation.entity';
import type { RuntimeAuthMode } from '../entities/runtime-settings.entity';

/**
 * Every `RuntimeInstallation` state move raises one of these (23 §7.5, ✅ Outbox).
 * It is the SOURCE of WS `runtime.install_progress` (23 §12) — the domain event is
 * the source, the WS frame is the projection, and they are not 1:1 by design.
 */
export class RuntimeInstallationStateChanged implements DomainEvent {
  readonly type = 'RuntimeInstallationStateChanged';
  constructor(
    readonly sandboxId: string,
    readonly runtimeId: string,
    readonly status: RuntimeInstallState,
    readonly versionDetected: string | undefined,
    readonly error: string | undefined,
    readonly occurredAt: Date,
  ) {}
}

/**
 * `PUT /api/runtimes/:rt/auth-mode` 切换了**生效的凭证方式**（23 §7.5 / 24 §214，✅ Outbox）。
 *
 * ⚠️ **这是「改完之后系统行为变了、却没人知道是谁改的」的典型。** 这一行决定**此后每一个
 * 沙箱**注入哪份凭证（05 §4.1），而它在实现里此前**一个事件都不发** —— 文档 23 §12 /
 * 24 §214 都写着它存在。于是排障时「昨天起还全是 401，谁动过 auth-mode？」只能靠
 * `runtime_settings.updated_at` 猜出一个时刻，猜不出从哪一档换到哪一档。
 */
export class RuntimeAuthModeChanged implements DomainEvent {
  readonly type = 'RuntimeAuthModeChanged';
  constructor(
    readonly runtimeId: string,
    /**
     * 换之前那一档；`null` = **首次配置**（此前没有 `runtime_settings` 行）。
     *
     * ⚠️ `null` 与「换到同一档」不是一回事，所以它不能省成一个布尔：审计行要写得出
     * `account → api-key`，而首配那一行就该读作「设置为 api-key」，没有来处可写。
     */
    readonly from: RuntimeAuthMode | null,
    readonly to: RuntimeAuthMode,
    readonly occurredAt: Date,
  ) {}
}
