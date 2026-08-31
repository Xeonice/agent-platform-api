import { AggregateRoot } from '@platform/shared-kernel';
import type { AutomationId } from '@platform/shared-kernel';
import { AutomationRunStateError } from '../errors/automation-errors';
import { RetryPolicy } from '../value-objects/policies.vo';

/** 13 §2.7.2 CHECK 的 8 值。domain 侧重新声明（不许 import contracts，01 §3）。 */
export type AutomationRunStatus =
  | 'pending'
  | 'running'
  | 'success'
  | 'failed'
  | 'timeout'
  | 'resource-exhausted'
  | 'skipped'
  | 'missed';

export type AutomationRunErrorCode = 'PREVIOUS_RUNNING' | 'AUTH_EXPIRED' | 'RESOURCE_EXHAUSTED';
export type WebhookStatus = 'sent' | 'failed' | 'skipped';

/** I-AUR-4：10MB × 3 分片 = 30MB 上限（03 §8.6 的轮转口径）。 */
export const LOG_BYTES_LIMIT = 31_457_280;

/** 终态集合。`resource-exhausted` **不在里面**——它是过程态（审计 P2-2）。 */
const TERMINAL: ReadonlySet<AutomationRunStatus> = new Set<AutomationRunStatus>([
  'success',
  'failed',
  'timeout',
  'skipped',
  'missed',
]);

export interface AutomationRunProps {
  id: string;
  automationId: AutomationId;
  sandboxId: string | null;
  triggeredAt: Date;
  status: AutomationRunStatus;
  errorCode: AutomationRunErrorCode | null;
  errorMessage: string | null;
  retryCount: number;
  retryAt: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
  durationSec: number | null;
  outputSummary: string | null;
  logPath: string | null;
  logBytes: number | null;
  webhookStatus: WebhookStatus | null;
  /**
   * 「这条 run 的终态已经喂给 `Automation.recordOutcome()` 了吗」。
   *
   * ⚠️ **13 §2.7.2 的列表里没有这一列，而 03 §8.1 明确要求它** —— 两处文档不一致，
   * 本轮按 03 落地并已回填 13（见报告）。没有它，「run 已 finalize 但 recordOutcome
   * 尚未生效时崩溃」这一路会**漏记一次失败计数**，而只按 `next_trigger_at` 扫规则
   * 永远发现不了它（交叉评审 P2-7）。
   */
  outcomeApplied: boolean;
}

/**
 * 独立聚合 `AutomationRun`（23 §11.2，裁决 D-9）。
 *
 * 为什么不做成 `Automation` 的内部实体：运行历史保留 ≥30 天、按规则分页查，做成内部
 * 实体则每次触发都要把全部历史加载进内存才能保存规则 —— 聚合大小随时间无界增长，
 * 是聚合划分最经典的错误。
 *
 * | 编号 | 不变量 | 落点 |
 * |---|---|---|
 * | I-AUR-1 | `pending → running → success/failed/timeout`；skipped/missed/resource-exhausted 是触发时刻直接落定的态 | `markRunning` / `finalize` |
 * | I-AUR-2 | `retryCount ≤ 5`；重试**更新同一行**而非新建 run | `queueRetry` |
 * | I-AUR-3 | 终态 append-only，`webhookStatus` 是唯一允许后置补写的字段 | `assertMutable` / `recordWebhookStatus` |
 * | I-AUR-4 | `logBytes ≤ 30MB` | `attachLog` |
 */
export class AutomationRun extends AggregateRoot<string> {
  readonly automationId: AutomationId;
  private _sandboxId: string | null;
  readonly triggeredAt: Date;
  private _status: AutomationRunStatus;
  private _errorCode: AutomationRunErrorCode | null;
  private _errorMessage: string | null;
  private _retryCount: number;
  private _retryAt: Date | null;
  private _startedAt: Date | null;
  private _completedAt: Date | null;
  private _durationSec: number | null;
  private _outputSummary: string | null;
  private _logPath: string | null;
  private _logBytes: number | null;
  private _webhookStatus: WebhookStatus | null;
  private _outcomeApplied: boolean;

  private constructor(props: AutomationRunProps) {
    super(props.id);
    this.automationId = props.automationId;
    this._sandboxId = props.sandboxId;
    this.triggeredAt = props.triggeredAt;
    this._status = props.status;
    this._errorCode = props.errorCode;
    this._errorMessage = props.errorMessage;
    this._retryCount = props.retryCount;
    this._retryAt = props.retryAt;
    this._startedAt = props.startedAt;
    this._completedAt = props.completedAt;
    this._durationSec = props.durationSec;
    this._outputSummary = props.outputSummary;
    this._logPath = props.logPath;
    this._logBytes = props.logBytes;
    this._webhookStatus = props.webhookStatus;
    this._outcomeApplied = props.outcomeApplied;
  }

  static rehydrate(props: AutomationRunProps): AutomationRun {
    return new AutomationRun(props);
  }

  /** 决策表行 4：真要跑了，先落一条 `pending`。 */
  static pending(id: string, automationId: AutomationId, now: Date): AutomationRun {
    return new AutomationRun(base(id, automationId, now, 'pending'));
  }

  /**
   * 决策表行 1 / 行 2：**触发时刻直接落定**的终态（I-AUR-1），没有 sandbox。
   *
   * ⚠️ `outcomeApplied` 直接置 `true`：skipped 本就不改 `failureCount`（I-AUT-1），
   * 让补扫去处理一条注定 no-op 的记录只是白扫。
   */
  static skipped(
    id: string,
    automationId: AutomationId,
    reason: AutomationRunErrorCode,
    message: string,
    now: Date,
  ): AutomationRun {
    const run = new AutomationRun(base(id, automationId, now, 'skipped'));
    run._errorCode = reason;
    run._errorMessage = message;
    run._completedAt = now;
    run._durationSec = 0;
    run._outcomeApplied = true;
    return run;
  }

  /** 宕机错过：记 `missed`、**不补跑**（03 §8.2）。同上，`outcomeApplied` 直接为真。 */
  static missed(id: string, automationId: AutomationId, message: string, now: Date): AutomationRun {
    const run = new AutomationRun(base(id, automationId, now, 'missed'));
    run._errorMessage = message;
    run._completedAt = now;
    run._durationSec = 0;
    run._outcomeApplied = true;
    return run;
  }

  get sandboxId(): string | null {
    return this._sandboxId;
  }
  get status(): AutomationRunStatus {
    return this._status;
  }
  get errorCode(): AutomationRunErrorCode | null {
    return this._errorCode;
  }
  get errorMessage(): string | null {
    return this._errorMessage;
  }
  get retryCount(): number {
    return this._retryCount;
  }
  get retryAt(): Date | null {
    return this._retryAt;
  }
  get startedAt(): Date | null {
    return this._startedAt;
  }
  get completedAt(): Date | null {
    return this._completedAt;
  }
  get durationSec(): number | null {
    return this._durationSec;
  }
  get outputSummary(): string | null {
    return this._outputSummary;
  }
  get logPath(): string | null {
    return this._logPath;
  }
  get logBytes(): number | null {
    return this._logBytes;
  }
  get webhookStatus(): WebhookStatus | null {
    return this._webhookStatus;
  }
  get outcomeApplied(): boolean {
    return this._outcomeApplied;
  }
  get isTerminal(): boolean {
    return TERMINAL.has(this._status);
  }

  /** I-AUR-1：只有 `pending` / `resource-exhausted` 能进 `running`。 */
  markRunning(sandboxId: string, now: Date): void {
    this.assertMutable('start');
    if (this._status !== 'pending' && this._status !== 'resource-exhausted') {
      throw new AutomationRunStateError(
        `run ${this.id}: ${this._status} → running is not a legal transition (I-AUR-1)`,
      );
    }
    this._sandboxId = sandboxId;
    this._status = 'running';
    this._startedAt = now;
    this._retryAt = null;
  }

  /**
   * 决策表行 3：资源不足 ⇒ **更新同一行**（I-AUR-2），历史上显示「已排队 n/5」。
   *
   * ⛔ **绝不新建一条 run**。新建会让一次「等了两小时终于跑起来」的触发在历史里变成
   * 六条记录，其中五条是失败 —— 而 `consecutive_failures` 的口径又只认终态，
   * 于是列表看着像连续失败、计数器却是 0，两边谁也解释不了对方。
   */
  queueRetry(now: Date): void {
    this.assertMutable('retry');
    if (!RetryPolicy.canRetry(this._retryCount)) {
      throw new AutomationRunStateError(
        `run ${this.id}: retry budget exhausted (${String(this._retryCount)}/${String(RetryPolicy.MAX_ATTEMPTS)}, I-AUR-2)`,
      );
    }
    this._retryCount += 1;
    this._status = 'resource-exhausted';
    this._retryAt = RetryPolicy.nextAttemptAt(now);
  }

  /** 终态落定。`success` / `failed` / `timeout` 三选一（I-AUR-1）。 */
  finalize(
    status: 'success' | 'failed' | 'timeout',
    now: Date,
    detail: {
      errorCode?: AutomationRunErrorCode;
      errorMessage?: string;
      outputSummary?: string;
    } = {},
  ): void {
    this.assertMutable('finalize');
    this._status = status;
    this._completedAt = now;
    const from = this._startedAt ?? this.triggeredAt;
    this._durationSec = Math.max(0, Math.round((now.getTime() - from.getTime()) / 1000));
    this._retryAt = null;
    if (detail.errorCode !== undefined) this._errorCode = detail.errorCode;
    if (detail.errorMessage !== undefined) this._errorMessage = detail.errorMessage;
    if (detail.outputSummary !== undefined) this._outputSummary = detail.outputSummary;
  }

  /** 03 §8.6：日志指针与体积。I-AUR-4 在这里成立或根本不成立。 */
  attachLog(logPath: string, logBytes: number): void {
    if (logBytes > LOG_BYTES_LIMIT) {
      throw new AutomationRunStateError(
        `run ${this.id}: logBytes ${String(logBytes)} exceeds the ${String(LOG_BYTES_LIMIT)} rotation ceiling (I-AUR-4)`,
      );
    }
    this._logPath = logPath;
    this._logBytes = logBytes;
  }

  /**
   * I-AUR-3 的**唯一**例外：终态记录里只有这一个字段允许后置补写。
   *
   * 投递发生在 run 落定之后（10s 超时 + 两次退避重试，最坏 ~40s），而 run 的状态
   * 那时早已是历史事实。这也是为什么它不走 `assertMutable`。
   */
  recordWebhookStatus(status: WebhookStatus): void {
    this._webhookStatus = status;
  }

  /** 补扫已把这条终态喂给 `recordOutcome()`（幂等，03 §8.1）。 */
  markOutcomeApplied(): void {
    this._outcomeApplied = true;
  }

  /** I-AUR-3：终态记录 append-only，除 `webhookStatus` 外不可改。 */
  private assertMutable(action: string): void {
    if (this.isTerminal) {
      throw new AutomationRunStateError(
        `cannot ${action} run ${this.id}: it is already terminal (${this._status}) and ` +
          `append-only — webhookStatus is the only field allowed to be written afterwards (I-AUR-3)`,
      );
    }
  }
}

function base(
  id: string,
  automationId: AutomationId,
  now: Date,
  status: AutomationRunStatus,
): AutomationRunProps {
  return {
    id,
    automationId,
    sandboxId: null,
    triggeredAt: now,
    status,
    errorCode: null,
    errorMessage: null,
    retryCount: 0,
    retryAt: null,
    startedAt: null,
    completedAt: null,
    durationSec: null,
    outputSummary: null,
    logPath: null,
    logBytes: null,
    webhookStatus: null,
    outcomeApplied: false,
  };
}
