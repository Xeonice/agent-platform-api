import type { NodeId, SandboxId, Tx } from '@platform/shared-kernel';
import type { ResourceAllocation } from '../entities/resource-allocation.entity';

/**
 * `ResourceAllocationRepository` PORT（23 §5.7 逐方法对齐）。读 async、事务内写同步
 * （`saveSync(tx, …): void` —— `void` 让类型系统禁止在临界区里 `await`）。
 */
export interface ResourceAllocationRepository {
  /** 全部未释放的登记（`released_at IS NULL`），走 `(node_id, released_at)` 索引。 */
  listActive(nodeId: NodeId): Promise<ResourceAllocation[]>;
  /** 一条 sandbox 当前的活跃登记；没有 ⇒ `null`（I-RA-2 保证至多一条）。 */
  findActiveBySandbox(sandboxId: SandboxId): Promise<ResourceAllocation | null>;
  /** 全部登记（含已释放）—— 对账与测试用。 */
  listAll(): Promise<ResourceAllocation[]>;
  /**
   * 插入 / 更新一条登记。
   *
   * ⚠️ **`uq_alloc_active` 冲突要原样抛出去，不许在实现里吞成 no-op。** 那条部分唯一
   * 索引是 I-RA-2 的最后一道闸；把它吞掉等于宣布「重复登记是正常的」，而重复登记正是
   * 超分配的形状。
   */
  saveSync(tx: Tx, allocation: ResourceAllocation): void;
}

export const RESOURCE_ALLOCATION_REPOSITORY = Symbol('ResourceAllocationRepository');
