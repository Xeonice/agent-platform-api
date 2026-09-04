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
 * | I-AUT-10 | **已到期的触发槽不许无声消失**：一个 `nextTriggerAt <= now` 的槽在被移出扫描面之前，必须在 `automation_runs` 里留下**恰好一行**（triggered / skipped / missed 之一） | `advanceTrigger` + `recomputeFutureTrigger` + scheduler `fireOne` |
 *
 * ★ **I-AUT-9 的「不可隐式改写」落在 `update()` 的签名上**，不是落在一句注释上：
 * `patch.timezone` 缺席 ⇒ 沿用 `this.schedule.timezone`。要改时区必须显式传。
 *
 * ★★ **I-AUT-10 同样落在结构上，不落在「记得写补偿代码」上。** `_nextTriggerAt` 全类
 * 只有五个写口，每一个都在源码里带着 `// slot: …` 标记，各自回答「这个槽去哪了」：
 *
 * | 标记 | 写口 | 那个槽去哪了 |
 * |---|---|---|
 * | `slot: rehydrate` | 构造函数 | 从库里读回来，没动过 |
 * | `slot: create` | `create()` | 规则刚建，还没有槽 |
 * | `slot: advance` | `advanceTrigger()` | **就是触发本身**，必伴随一行 run（I-AUT-8） |
 * | `slot: recompute` | `recomputeFutureTrigger()` | **结构上只动未到期的槽** —— 到期的留在原地 |
 * | `slot: off-scan` | `disable()` / 连续失败自动禁用 | 整条规则退出扫描面，且是显式动作（有审计 / 事件） |
 *
 * ⇒ 「把一个到期槽往后推」在这个类里**没有写口**。新增第六个写口时，
 * `automation-slot-writes.spec.ts` 会红着要求它先回答这个问题。
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
    this._nextTriggerAt = props.nextTriggerAt; // slot: rehydrate
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
    automation._nextTriggerAt = automation.computeNextTrigger(input.now); // slot: create
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
      //
      // ⚠️ 走 `recomputeFutureTrigger` 而不是直接算：一个**已经到期、还没被这一轮
      // `fireDue` 处理**的槽不因为一次编辑而消失（I-AUT-10）。它照样会被处理掉并留下
      // 一行（真触发 / skip / missed），那一次 `advanceTrigger` 用的已经是**新调度**。
      // 「用户是显式在改调度」不足以换走这条：显式的是「以后怎么跑」，而不是「刚才那
      // 一发去哪了」——后者只有历史能回答，而 `update()` 连一条审计都不写。
      this.recomputeFutureTrigger(now);
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
    this._nextTriggerAt = this.computeNextTrigger(now); // slot: advance
    this._updatedAt = now;
  }

  /** 触发那一刻的记账（与 `advanceTrigger` 分开：missed 只推进、不算「触发过」）。 */
  markTriggered(now: Date): void {
    this._lastTriggeredAt = now;
    this._updatedAt = now;
  }

  /**
   * I-AUT-1 / I-AUT-2 / I-AUT-10 / 03 §8.4 的全部内容。
   *
   * ⚠️ **`skipped` 与 `missed` 不改 `failureCount`** —— 不是规则的错（上次还在跑、
   * 凭证过期、平台宕机都不是这条规则写错了）。把它们算进去，一台关了三天的机器
   * 开机就能把所有规则自动禁用一遍。
   *
   * ★ **一次普通失败不动 `nextTriggerAt`**（I-AUT-10）。这里曾经无条件重算一次
   * （`this._nextTriggerAt = this._enabled ? this.computeNextTrigger(now) : null`），
   * 于是「上一发在**本轮**刚落成 failed」会把**本轮那个已经到期的槽**推到 `now` 之后，
   * 紧接着的 `fireDue()`（判据 `next_trigger_at <= now`）就再也取不到它 —— 那一槽既没
   * 触发、也没有 skipped/missed，历史里是一个空洞；而同样局面下上一发若是 success
   * 会正常触发、若还在跑会留下 `skipped/PREVIOUS_RUNNING`：**三条路径三种历史**。
   * 现在与 success 分支同构：只有 degraded / disabled **状态真的翻转**时才动，
   * 且动的方式也不许吃掉到期槽（见 `recomputeFutureTrigger`）。
   *
   * ⚠️ **代价（已知并接受）**：一条连续失败的规则在降到 degraded 之前**仍按原频率跑**。
   * 降频这道闸由 I-AUT-2 / I-AUT-3 明确管着且用户看得见（横幅 + webhook），
   * 在它之外再叠一层「失败就顺手退避一格」是重复的，而且**不可见**。
   */
  recordOutcome(outcome: AutomationOutcome, now: Date): void {
    if (outcome === 'skipped' || outcome === 'missed') return; // I-AUT-1

    if (outcome === 'success') {
      // 降频态下成功一次 ⇒ 恢复原调度（03 §8.4）。`schedule` 从没被改写过，
      // 所以「恢复」就是把 degraded 关掉再重算一次（I-AUT-3）。
      const wasDegraded = this._degraded;
      this._failureCount = 0;
      this._degraded = false;
      if (wasDegraded) this.recomputeFutureTrigger(now);
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
      // 整条规则退出扫描面 —— I-AUT-10 允许的唯一一种「槽消失」：它不是无声的
      // （`AutomationDisabled` 事件 + `automation.disabled` 审计 + 前端的 🔴 状态）。
      this._nextTriggerAt = null; // slot: off-scan
      this.raise(new AutomationDisabled(this.id, this._name, this._failureCount, now));
    } else if (FailurePolicy.shouldDegrade(this._failureCount)) {
      const alreadyDegraded = this._degraded;
      this._degraded = true;
      if (!alreadyDegraded) {
        this.raise(new AutomationDegraded(this.id, this._name, this._failureCount, now));
        // ★ 只有**刚翻转**这一次要重算：频率从原调度变成「每日一次」，未到期的那一个
        // 时刻已经不作数了（I-AUT-3）。第 4、5、6…次失败什么都不用动 —— 它们不改变
        // 任何状态，「顺手重算」正是本方法开头那段注释里说的那个空洞。
        this.recomputeFutureTrigger(now);
      }
    }
    this._updatedAt = now;
  }

  /**
   * I-AUT-4：[重新启用] 必须**同时**清零 `failureCount` 与 `degraded`。
   *
   * `disable()` 已经把槽置空，所以这里是「从 now 起算」而不是「接着原来那个跑」——
   * 不存在被吃掉的槽。走 `recomputeFutureTrigger` 只是为了让写口收敛成一处
   * （顺带：对一条**本来就 enabled** 的规则再点一次 [重新启用]，一个到期未处理的槽
   * 也不会因此蒸发）。
   */
  enable(now: Date): void {
    this._enabled = true;
    this._degraded = false;
    this._failureCount = 0;
    this.recomputeFutureTrigger(now);
    this._updatedAt = now;
    this.raise(new AutomationReenabled(this.id, this._name, now));
  }

  disable(now: Date): void {
    this._enabled = false;
    // 停用的规则不该继续占着调度器的扫描面 —— `(enabled, next_trigger_at)` 索引先按
    // enabled 过滤，但一个留着旧时刻的禁用规则在人眼里就是「它还会跑吗」。
    //
    // I-AUT-10 不管这一条：整条规则退出扫描面是**用户的显式动作**（有
    // `automation.disabled` 审计），与「某一发被悄悄吃掉」不是一回事。
    this._nextTriggerAt = null; // slot: off-scan
    this._updatedAt = now;
  }

  /**
   * 状态翻转（转降频 / 从降频恢复 / 编辑了调度 / 重新启用）之后重算下一次，
   * **但绝不动一个已经到期的槽**（I-AUT-10）。
   *
   * 频率变了，「下一次算在哪」当然要重算；可如果当前这个槽已经 `<= now`，它此刻正躺在
   * 调度器的扫描面上（`listDue` 的判据就是 `enabled AND next_trigger_at <= now`）等着
   * 这一轮 `fireDue()` 处理。把它往后推 = 它既没触发、也不会留下 skipped/missed，
   * 历史里就是一个空洞。留着它 ⇒ 这一轮照常走 missed / skip / 真触发三条出路之一 ⇒
   * 那一次 `advanceTrigger()` 用的已经是**新的**频率。⇒ **重算并没有丢，只是晚一步，
   * 而晚的那一步有记录。**
   *
   * 已禁用的规则同理不重算：`disable()` 刚把它移出扫描面，这里再算一个时刻塞回去，
   * 前端就得回答「它到底还会不会跑」。
   */
  private recomputeFutureTrigger(now: Date): void {
    if (!this._enabled) return;
    if (this._nextTriggerAt !== null && this._nextTriggerAt.getTime() <= now.getTime()) return;
    this._nextTriggerAt = this.computeNextTrigger(now); // slot: recompute
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
