import { AggregateRoot } from '@platform/shared-kernel';
import type { NodeId, SandboxId } from '@platform/shared-kernel';
import type { ResourceQuota } from '../value-objects/resource-quota.vo';
import { SandboxInvariantViolationError } from '../errors/invariant-violation.error';

/** 13 §2.1.3 `reconciliation_status` 的三值闭集。 */
export type ReconciliationStatus = 'confirmed' | 'pending' | 'orphaned';

export interface ResourceAllocationProps {
  id: string;
  sandboxId: SandboxId;
  nodeId: NodeId;
  coresReserved: number;
  ramMbReserved: number;
  diskMbReserved: number;
  allocatedAt: Date;
  releasedAt: Date | null;
  reconciliationStatus: ReconciliationStatus;
}

/**
 * 独立聚合 `ResourceAllocation`（23 §5.4 裁决 D-3，13 §2.1.3）—— **配额账本的一行**。
 *
 * 它不塞进 `Sandbox` 的三条理由（§4.1 三判据）：① 释放后仍长期留档供对账；② 它承载的
 * 不变量是**跨 sandbox 的**（资源池总量 = 全部未释放登记之和）；③ 对账按
 * `(nodeId, releasedAt)` 跨 sandbox 查询。
 *
 * | 编号 | 不变量 | 落点 |
 * |---|---|---|
 * | I-RA-1 | `releasedAt` 一旦置值不可回退 | {@link release} |
 * | I-RA-2 | 同一 sandbox 同时至多一条活跃登记 | **存储层**：`uq_alloc_active` 部分唯一索引 |
 * | I-RA-3 | `orphaned` 只能由对账路径写入 | {@link markOrphaned} 与 {@link confirm} 分成两个方法 |
 *
 * ⚠️ **I-RA-2 刻意不在这里判。** 一个聚合实例看不见「同一 sandbox 还有没有别的活跃
 * 登记」——那是跨聚合的事实，只有库知道。13 §2.1.3 把它下沉成部分唯一索引正是为此：
 * 在应用层加一句 `if (await findActive(...)) throw` 会读起来像一道防线，而它挡不住
 * 真正的并发（两个请求同时查、同时都没查到、然后都写）。真正的闸是索引 + 临界区。
 *
 * ⚠️ **I-RA-3 落在「有两个方法」上，不是落在一句注释上。** 若只有一个
 * `markReconciliation(status)`，任何调用点都能传 `'orphaned'`；分成
 * `confirm()` / `markOrphaned()` 之后，「谁能判孤儿」这件事在调用图上是可 grep 的。
 */
export class ResourceAllocation extends AggregateRoot<string> {
  readonly sandboxId: SandboxId;
  readonly nodeId: NodeId;
  readonly coresReserved: number;
  readonly ramMbReserved: number;
  readonly diskMbReserved: number;
  readonly allocatedAt: Date;
  private _releasedAt: Date | null;
  private _reconciliationStatus: ReconciliationStatus;

  private constructor(props: ResourceAllocationProps) {
    super(props.id);
    this.sandboxId = props.sandboxId;
    this.nodeId = props.nodeId;
    this.coresReserved = props.coresReserved;
    this.ramMbReserved = props.ramMbReserved;
    this.diskMbReserved = props.diskMbReserved;
    this.allocatedAt = props.allocatedAt;
    this._releasedAt = props.releasedAt;
    this._reconciliationStatus = props.reconciliationStatus;
  }

  /**
   * 新登记一笔占用。三个 `> 0` 是 13 §2.1.3 的 CHECK 在领域侧的那一半 —— DB 也有，
   * 两处都要（23 §4.6 第三类：能在构造期挡住的，不要留给 DB 在半个事务之后炸）。
   */
  static allocate(input: {
    id: string;
    sandboxId: SandboxId;
    nodeId: NodeId;
    quota: ResourceQuota;
    now: Date;
  }): ResourceAllocation {
    const { cores, ramMb, diskMb } = input.quota;
    if (!(cores > 0) || !(ramMb > 0) || !(diskMb > 0)) {
      throw new SandboxInvariantViolationError(
        'I-RA-0',
        `resource allocation for sandbox ${input.sandboxId} must reserve a positive amount of ` +
          `every dimension (got cores=${String(cores)}, ramMb=${String(ramMb)}, ` +
          `diskMb=${String(diskMb)}) — 13 §2.1.3 CHECK`,
      );
    }
    return new ResourceAllocation({
      id: input.id,
      sandboxId: input.sandboxId,
      nodeId: input.nodeId,
      coresReserved: cores,
      ramMbReserved: ramMb,
      diskMbReserved: diskMb,
      allocatedAt: input.now,
      releasedAt: null,
      // 'pending' 而不是 'confirmed'：这一刻实例还不存在（登记发生在 provision **之前**，
      // 那正是消除 TOCTOU 的全部意义）。只有对账真的看见容器才能说 confirmed。
      reconciliationStatus: 'pending',
    });
  }

  /** Rehydrate from a row — no invariant re-checks (the row already passed them). */
  static rehydrate(props: ResourceAllocationProps): ResourceAllocation {
    return new ResourceAllocation(props);
  }

  get releasedAt(): Date | null {
    return this._releasedAt;
  }

  get isActive(): boolean {
    return this._releasedAt === null;
  }

  get reconciliationStatus(): ReconciliationStatus {
    return this._reconciliationStatus;
  }

  get quota(): ResourceQuota {
    return {
      cores: this.coresReserved,
      ramMb: this.ramMbReserved,
      diskMb: this.diskMbReserved,
    };
  }

  /**
   * I-RA-1：释放不可撤销。**第二次调用抛，不是 no-op** —— 一个静默的第二次释放意味着
   * 某条路径以为自己还占着资源而其实没有，而池子会把那份配额当成两次归还里的一次。
   */
  release(at: Date): void {
    if (this._releasedAt !== null) {
      throw new SandboxInvariantViolationError(
        'I-RA-1',
        `resource allocation ${this.id} was already released at ` +
          `${this._releasedAt.toISOString()} — I-RA-1 forbids re-releasing it`,
      );
    }
    this._releasedAt = at;
  }

  /** 对账看见了活着的实例。 */
  confirm(): void {
    this._reconciliationStatus = 'confirmed';
  }

  /**
   * I-RA-3 的落点：**只有对账路径调得到这个名字**。库里活跃、实例查无 ⇒ 孤儿。
   * 释放由调用方另行执行（13 §4 那一格要求「orphaned + released_at=now()」两件事，
   * 但它们是两个不同的事实，合成一个方法就没法表达「已判孤儿、还没来得及释放」）。
   */
  markOrphaned(): void {
    this._reconciliationStatus = 'orphaned';
  }
}
