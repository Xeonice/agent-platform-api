import type { AutomationId, ProjectId, Tx } from '@platform/shared-kernel';
import type { Automation } from '../entities/automation.entity';

/** `AutomationRepository`（23 §11.6 逐条对齐）。 */
export interface AutomationRepository {
  findById(id: AutomationId): Promise<Automation | null>;
  listByProject(projectId: ProjectId): Promise<Automation[]>;
  /** I-AUT-7 的 application 那一半的取数。 */
  countByProject(projectId: ProjectId): Promise<number>;
  /**
   * 调度器每分钟的唯一取数：`enabled = true AND next_trigger_at <= now`
   * （走 `(enabled, next_trigger_at)` 复合索引，13 §2.7.1）。
   */
  listDue(now: Date): Promise<Automation[]>;
  /**
   * 全量规则（含已禁用）。
   *
   * 调度器推进「在飞的 run」时要用：一条规则可能刚被 `disable()` 掉，而它上一发
   * Task 还在跑 —— 那一发的结果照样要落库、照样要计入历史。只用 `listDue` 会让
   * 那条 run 永远停在 `running`。规则总数是「几十条」量级（每项目 ≤20，I-AUT-7），
   * 全取不构成负担。
   */
  listAllForSweep(): Promise<Automation[]>;
  saveSync(tx: Tx, automation: Automation): void;
  deleteSync(tx: Tx, id: AutomationId): void;
}

export const AUTOMATION_REPOSITORY = Symbol('AutomationRepository');
