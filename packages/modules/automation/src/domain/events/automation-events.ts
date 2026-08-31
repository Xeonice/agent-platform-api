import type { AutomationId, DomainEvent, ProjectId } from '@platform/shared-kernel';

/**
 * automation 领域事件（23 §11.5）。
 *
 * ⚠️ **一条 WS 投影都没有**（23 裁决 D-10）：v1.1 的自动化历史走 REST 拉取，不为低频
 * 事件扩 WS 协议；触发产生的 Task 本身照常发 `sandbox.created` / `sandbox.status_changed`。
 * 它们进 Outbox 是为了审计与 webhook notifier。
 *
 * 每条都带 `name` —— 与 project 事件同一理由（审计 `summary` 里不许出现 UUID，
 * 13 §2.8.2；且审计是历史快照，记的必须是**当时**的名字）。
 */
export class AutomationTriggered implements DomainEvent {
  readonly type = 'AutomationTriggered';
  constructor(
    readonly automationId: AutomationId,
    readonly name: string,
    readonly projectId: ProjectId,
    readonly runId: string,
    readonly occurredAt: Date,
  ) {}
}

export class AutomationRunFinished implements DomainEvent {
  readonly type = 'AutomationRunFinished';
  constructor(
    readonly automationId: AutomationId,
    readonly name: string,
    readonly runId: string,
    readonly status: string,
    readonly occurredAt: Date,
  ) {}
}

/** `consecutiveFailures ≥ 3` ⇒ 降频为每日一次（I-AUT-2）。规则仍启用。 */
export class AutomationDegraded implements DomainEvent {
  readonly type = 'AutomationDegraded';
  constructor(
    readonly automationId: AutomationId,
    readonly name: string,
    readonly failureCount: number,
    readonly occurredAt: Date,
  ) {}
}

/** 降频后再连续失败 7 次（累计 ≥10）⇒ 自动禁用（I-AUT-2）。 */
export class AutomationDisabled implements DomainEvent {
  readonly type = 'AutomationDisabled';
  constructor(
    readonly automationId: AutomationId,
    readonly name: string,
    readonly failureCount: number,
    readonly occurredAt: Date,
  ) {}
}

/** 用户 [重新启用]（I-AUT-4：同时清零 failureCount 与 degraded）。 */
export class AutomationReenabled implements DomainEvent {
  readonly type = 'AutomationReenabled';
  constructor(
    readonly automationId: AutomationId,
    readonly name: string,
    readonly occurredAt: Date,
  ) {}
}
