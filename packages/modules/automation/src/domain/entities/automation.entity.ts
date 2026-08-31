import { AggregateRoot } from '@platform/shared-kernel';
import type { AutomationId, ProjectId } from '@platform/shared-kernel';
import { AutomationInvariantError } from '../errors/automation-errors';
import { Schedule } from '../value-objects/schedule.vo';
import type { ScheduleConfig, ScheduleKind } from '../value-objects/schedule.vo';
import { FailurePolicy, TimeoutPolicy, assertRetentionDays } from '../value-objects/policies.vo';
import type { RetentionDays } from '../value-objects/policies.vo';
import { WebhookTarget } from '../value-objects/webhook-target.vo';
import type { TriggerOn } from '../value-objects/webhook-target.vo';
import {
  AutomationDegraded,
  AutomationDisabled,
  AutomationReenabled,
} from '../events/automation-events';

/** 13 §2.7.1 CHECK。`queue` / `concurrent` 是 v1.2。 */
export type ConcurrencyMode = 'skip' | 'queue' | 'concurrent';

/** `recordOutcome` 接受的五种结果。`resource-exhausted` 不在其中——它是过程态。 */
export type AutomationOutcome = 'success' | 'failed' | 'timeout' | 'skipped' | 'missed';

export const PROMPT_MAX_LENGTH = 8000;

export interface AutomationProps {
  id: AutomationId;
  projectId: ProjectId;
  name: string;
  description: string | null;
  runtimeId: string;
  prompt: string;
  schedule: Schedule;
  enabled: boolean;
  degraded: boolean;
  concurrency: ConcurrencyMode;
  timeout: TimeoutPolicy;
  retentionDays: RetentionDays;
  webhook: WebhookTarget | null;
  failureCount: number;
  lastTriggeredAt: Date | null;
  nextTriggerAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * 聚合根 `Automation`（23 §11.1）。
 *
 * | 编号 | 不变量 | 落点 |
 * |---|---|---|
 * | I-AUT-1 | `failureCount` 只由 failed/timeout 累加，success 清零；skipped/missed 不改 | `recordOutcome` |
 * | I-AUT-2 | ≥3 ⇒ degraded；≥10 ⇒ enabled=false（degraded 保持 true） | `recordOutcome` |
 * | I-AUT-3 | degraded 时 `nextTriggerAt` 按每日一次算，**原 schedule 不改写** | `computeNextTrigger` |
 * | I-AUT-4 | `enable()` 同时清零 failureCount 与 degraded | `enable` |
 * | I-AUT-5 | timeout ∈ {30,60,120,240}；prompt ≤ 8000 | `TimeoutPolicy` / `assertPrompt` |
 * | I-AUT-6 | webhook 为空不发；非空必须 http/https + SSRF 谓词 | `WebhookTarget` + infra |
 * | I-AUT-7 | 每项目 ≤20 | **不在这里** —— 跨聚合，application + DB（23 §4.6 第三类） |
 * | I-AUT-8 | 触发时先推进 `nextTriggerAt` 再执行 | `advanceTrigger` + scheduler |
 * | I-AUT-9 | `timezone` 是 IANA 非空、**不可被隐式改写** | `Schedule` + `update` |
 *
 * ★ **I-AUT-9 的「不可隐式改写」落在 `update()` 的签名上**，不是落在一句注释上：
 * `patch.timezone` 缺席 ⇒ 沿用 `this.schedule.timezone`。要改时区必须显式传。
 */
export class Automation extends AggregateRoot<AutomationId> {
  readonly projectId: ProjectId;
  private _name: string;
  private _description: string | null;
  private _runtimeId: string;
  private _prompt: string;
  private _schedule: Schedule;
  private _enabled: boolean;
  private _degraded: boolean;
  private _concurrency: ConcurrencyMode;
  private _timeout: TimeoutPolicy;
  private _retentionDays: RetentionDays;
  private _webhook: WebhookTarget | null;
  private _failureCount: number;
  private _lastTriggeredAt: Date | null;
  private _nextTriggerAt: Date | null;
  readonly createdAt: Date;
  private _updatedAt: Date;

  private constructor(props: AutomationProps) {
    super(props.id);
    this.projectId = props.projectId;
    this._name = props.name;
    this._description = props.description;
    this._runtimeId = props.runtimeId;
    this._prompt = props.prompt;
    this._schedule = props.schedule;
    this._enabled = props.enabled;
    this._degraded = props.degraded;
    this._concurrency = props.concurrency;
    this._timeout = props.timeout;
    this._retentionDays = props.retentionDays;
    this._webhook = props.webhook;
    this._failureCount = props.failureCount;
    this._lastTriggeredAt = props.lastTriggeredAt;
    this._nextTriggerAt = props.nextTriggerAt;
    this.createdAt = props.createdAt;
    this._updatedAt = props.updatedAt;
  }

  static rehydrate(props: AutomationProps): Automation {
    return new Automation(props);
  }

  static create(input: {
    id: AutomationId;
    projectId: ProjectId;
    name: string;
    description?: string;
    runtimeId: string;
    prompt: string;
    scheduleKind: ScheduleKind;
    scheduleConfig: ScheduleConfig;
    /** IANA 快照（I-AUT-9）。**创建时定，之后只有用户显式改才变。** */
    timezone: string;
    timeoutMinutes: number;
    artifactRetentionDays: number;
    webhookUrl?: string;
    triggerOn?: TriggerOn;
    now: Date;
  }): Automation {
    assertName(input.name);
    assertPrompt(input.prompt);
    const schedule = Schedule.create(input.scheduleKind, input.scheduleConfig, input.timezone);
    const automation = new Automation({
      id: input.id,
      projectId: input.projectId,
      name: input.name.trim(),
      description: input.description ?? null,
      runtimeId: input.runtimeId,
      prompt: input.prompt,
      schedule,
      enabled: true,
      degraded: false,
      // MVP 唯一值（13 §2.7.1 CHECK 的三值里，后两个是 v1.2）
      concurrency: 'skip',
      timeout: TimeoutPolicy.of(input.timeoutMinutes),
      retentionDays: assertRetentionDays(input.artifactRetentionDays),
      webhook:
        input.webhookUrl === undefined
          ? null
          : WebhookTarget.create(input.webhookUrl, input.triggerOn ?? 'failure'),
      failureCount: 0,
      lastTriggeredAt: null,
      nextTriggerAt: null,
      createdAt: input.now,
      updatedAt: input.now,
    });
    automation._nextTriggerAt = automation.computeNextTrigger(input.now);
    return automation;
  }

  get name(): string {
    return this._name;
  }
  get description(): string | null {
    return this._description;
  }
  get runtimeId(): string {
    return this._runtimeId;
  }
  get prompt(): string {
    return this._prompt;
  }
  get schedule(): Schedule {
    return this._schedule;
  }
  get enabled(): boolean {
    return this._enabled;
  }
  get degraded(): boolean {
    return this._degraded;
  }
  get concurrency(): ConcurrencyMode {
    return this._concurrency;
  }
  get timeoutMinutes(): number {
    return this._timeout.minutes;
  }
  get retentionDays(): RetentionDays {
    return this._retentionDays;
  }
  get webhook(): WebhookTarget | null {
    return this._webhook;
  }
  get failureCount(): number {
    return this._failureCount;
  }
  get lastTriggeredAt(): Date | null {
    return this._lastTriggeredAt;
  }
  get nextTriggerAt(): Date | null {
    return this._nextTriggerAt;
  }
  get updatedAt(): Date {
    return this._updatedAt;
  }

  /**
   * 编辑规则。**`timezone` 缺席 = 原样保留**（I-AUT-9 / T-AUT-7）。
   *
   * ⚠️ 这是本聚合最容易写错的一个方法。「顺手把当前浏览器时区再传一遍」是前端最自然
   * 的写法，而它会让一条「每天凌晨 3 点」的规则在用户换台机器之后挪走 8 小时 —— 03 §8.1
   * 原话：**最难排查的一类 bug**。所以时区在这里既不从入参兜底、也不从系统读，
   * 只有 `patch.timezone !== undefined` 才动。
   */
  update(
    patch: {
      name?: string;
      description?: string;
      runtimeId?: string;
      prompt?: string;
      scheduleKind?: ScheduleKind;
      scheduleConfig?: ScheduleConfig;
      timezone?: string;
      timeoutMinutes?: number;
      artifactRetentionDays?: number;
      webhookUrl?: string;
      triggerOn?: TriggerOn;
    },
    now: Date,
  ): void {
    if (patch.name !== undefined) {
      assertName(patch.name);
      this._name = patch.name.trim();
    }
    if (patch.description !== undefined) this._description = patch.description;
    if (patch.runtimeId !== undefined) this._runtimeId = patch.runtimeId;
    if (patch.prompt !== undefined) {
      assertPrompt(patch.prompt);
      this._prompt = patch.prompt;
    }
    if (patch.timeoutMinutes !== undefined) this._timeout = TimeoutPolicy.of(patch.timeoutMinutes);
    if (patch.artifactRetentionDays !== undefined) {
      this._retentionDays = assertRetentionDays(patch.artifactRetentionDays);
    }
    if (patch.webhookUrl !== undefined) {
      this._webhook =
        patch.webhookUrl === ''
          ? null
          : WebhookTarget.create(
              patch.webhookUrl,
              patch.triggerOn ?? this._webhook?.triggerOn ?? 'failure',
            );
    } else if (patch.triggerOn !== undefined && this._webhook !== null) {
      this._webhook = WebhookTarget.create(this._webhook.url, patch.triggerOn);
    }

    const scheduleTouched =
      patch.scheduleKind !== undefined ||
      patch.scheduleConfig !== undefined ||
      patch.timezone !== undefined;
    if (scheduleTouched) {
      this._schedule = Schedule.create(
        patch.scheduleKind ?? this._schedule.kind,
        patch.scheduleConfig ?? this._schedule.config,
        // ★ I-AUT-9：缺席就是原样保留。这一行是 T-AUT-7 的断言对象。
        patch.timezone ?? this._schedule.timezone,
      );
      // 只有真的动了调度才重算下一次；改 prompt 不该让触发时刻漂移（T-AUT-7）。
      this._nextTriggerAt = this.computeNextTrigger(now);
    }
    this._updatedAt = now;
  }

  /**
   * I-AUT-8 的聚合那一半：**先推进 `nextTriggerAt`，再由调用方去执行**。
   *
   * 「先推进」保证任何执行异常（进程被 kill、provider 抛异常、DB 写失败）都不会导致
   * 同一时刻被反复触发；代价是极端情况下漏一发，而那正是这条不变量选定的取舍。
   */
  advanceTrigger(now: Date): void {
    this._nextTriggerAt = this.computeNextTrigger(now);
    this._updatedAt = now;
  }

  /** 触发那一刻的记账（与 `advanceTrigger` 分开：missed 只推进、不算「触发过」）。 */
  markTriggered(now: Date): void {
    this._lastTriggeredAt = now;
    this._updatedAt = now;
  }

  /**
   * I-AUT-1 / I-AUT-2 / 03 §8.4 的全部内容。
   *
   * ⚠️ **`skipped` 与 `missed` 不改 `failureCount`** —— 不是规则的错（上次还在跑、
   * 凭证过期、平台宕机都不是这条规则写错了）。把它们算进去，一台关了三天的机器
   * 开机就能把所有规则自动禁用一遍。
   */
  recordOutcome(outcome: AutomationOutcome, now: Date): void {
    if (outcome === 'skipped' || outcome === 'missed') return; // I-AUT-1

    if (outcome === 'success') {
      // 降频态下成功一次 ⇒ 恢复原调度（03 §8.4）。`schedule` 从没被改写过，
      // 所以「恢复」就是把 degraded 关掉再重算一次（I-AUT-3）。
      const wasDegraded = this._degraded;
      this._failureCount = 0;
      this._degraded = false;
      if (wasDegraded) this._nextTriggerAt = this.computeNextTrigger(now);
      this._updatedAt = now;
      return;
    }

    // failed / timeout —— `timeout` 与 `failed` 同权（T-AUT-25 / P20 §9.9）
    this._failureCount += 1;
    if (FailurePolicy.shouldDisable(this._failureCount)) {
      // ⚠️ 禁用时 `degraded` **保持 true**（I-AUT-2 括号里那半句）：规则确实还处在
      // 降频态，只是连降频都救不回来了。清掉它会让 [重新启用] 之后的第一次触发
      // 按原频率跑，而用户并没有说「原频率没问题」。
      this._enabled = false;
      this._degraded = true;
      this.raise(new AutomationDisabled(this.id, this._name, this._failureCount, now));
    } else if (FailurePolicy.shouldDegrade(this._failureCount)) {
      const alreadyDegraded = this._degraded;
      this._degraded = true;
      if (!alreadyDegraded) {
        this.raise(new AutomationDegraded(this.id, this._name, this._failureCount, now));
      }
    }
    // 降频/禁用会改变「下一次算在哪」，所以在这里重算一次（I-AUT-3）。
    this._nextTriggerAt = this._enabled ? this.computeNextTrigger(now) : null;
    this._updatedAt = now;
  }

  /** I-AUT-4：[重新启用] 必须**同时**清零 `failureCount` 与 `degraded`。 */
  enable(now: Date): void {
    this._enabled = true;
    this._degraded = false;
    this._failureCount = 0;
    this._nextTriggerAt = this.computeNextTrigger(now);
    this._updatedAt = now;
    this.raise(new AutomationReenabled(this.id, this._name, now));
  }

  disable(now: Date): void {
    this._enabled = false;
    // 停用的规则不该继续占着调度器的扫描面 —— `(enabled, next_trigger_at)` 索引先按
    // enabled 过滤，但一个留着旧时刻的禁用规则在人眼里就是「它还会跑吗」。
    this._nextTriggerAt = null;
    this._updatedAt = now;
  }

  /**
   * I-AUT-3：降频态按「每日一次」算，**`schedule` 不被改写**。
   *
   * 注意它读的是 `this._degraded` 而不是入参 —— 降频是聚合的状态，不是调用方的选择。
   */
  computeNextTrigger(after: Date): Date {
    return this._degraded
      ? this._schedule.nextDailyOccurrence(after)
      : this._schedule.nextOccurrence(after);
  }
}

function assertName(name: string): void {
  const trimmed = name.trim();
  if (trimmed === '' || trimmed.length > 60) {
    throw new AutomationInvariantError(
      `automation name must be 1–60 characters, got ${String(name.length)}`,
    );
  }
}

function assertPrompt(prompt: string): void {
  if (prompt.trim() === '') {
    throw new AutomationInvariantError('prompt is required');
  }
  if (prompt.length > PROMPT_MAX_LENGTH) {
    throw new AutomationInvariantError(
      `prompt must be ≤ ${String(PROMPT_MAX_LENGTH)} characters (I-AUT-5), got ${String(prompt.length)}`,
    );
  }
}
