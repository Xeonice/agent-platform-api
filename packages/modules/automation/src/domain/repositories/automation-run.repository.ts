import type { AutomationId, Tx } from '@platform/shared-kernel';
import type { AutomationRun } from '../entities/automation-run.entity';

/**
 * ⚠️ **游标，不是 offset 页码**（2026-08-31 改）。
 *
 * 运行历史是**头部追加**的流：翻到第 2 页时若新落了 7 条 run，offset 分页会让第 2 页
 * 重复第 1 页尾部的 7 条 —— **而且看起来完全正常**。`useAuditStream` 的文件头把这条列为
 * 七条纪律之首，并且**点名说的就是这里**：「此前 `automationKeys.runs` 用的是 offset
 * 页码，那套照抄过来会静默错位」。审计流是本仓第一个游标无限列表，本接口与它同形。
 *
 * 游标用 run 的 `id`（uuid v7，**本身时间有序**），排序键仍是
 * `(triggered_at DESC, id DESC)` —— 同一毫秒内多条时靠 id 决胜，保证全序、不漏不重。
 */
export interface RunCursor {
  /** 取**严格早于**这条 run 的那一页；缺席 = 第一页。 */
  before?: string;
  limit: number;
}

export interface RunSlice {
  items: AutomationRun[];
  /** ⚠️ 不回 `total`：append-only 流上的总数每一刻都在变，回它只会让 UI 显示一个过期的数。 */
  hasMore: boolean;
}

/** `AutomationRunRepository`（23 §11.6）。 */
export interface AutomationRunRepository {
  findById(id: string): Promise<AutomationRun | null>;
  /** `PREVIOUS_RUNNING` 判定与「重试到第几次」都读它 —— 按 `triggered_at DESC` 取第一条。 */
  findLatest(automationId: AutomationId): Promise<AutomationRun | null>;
  listByAutomation(automationId: AutomationId, cursor: RunCursor): Promise<RunSlice>;
  /** 调度器捞待重试项：`status='resource-exhausted' AND retry_at <= now`（`(status, retry_at)` 索引）。 */
  listPendingRetries(now: Date): Promise<AutomationRun[]>;
  /**
   * **在飞**的 run：`status IN ('pending','running')`，跨全部规则。
   *
   * ⚠️ **不能用「每条规则取最新一条 run」代替**（这一版本来是那么写的，是个真 bug）：
   * 一条 10:00 触发、还在跑的 run A，会在 11:00 那一轮被一条 `skipped/PREVIOUS_RUNNING`
   * 的 run B **盖住** —— `findLatest` 之后拿到的是终态的 B，于是 A 再也没人推进，
   * 永远停在 `running`，规则也就永远跳过。
   */
  listActive(): Promise<AutomationRun[]>;
  /**
   * outcome-pending 孤儿补扫（03 §8.1 / 交叉评审 P2-7）：
   * `status IN (success, failed, timeout) AND outcome_applied = false`。
   */
  listOutcomePending(limit: number): Promise<AutomationRun[]>;
  saveSync(tx: Tx, run: AutomationRun): void;
}

export const AUTOMATION_RUN_REPOSITORY = Symbol('AutomationRunRepository');
