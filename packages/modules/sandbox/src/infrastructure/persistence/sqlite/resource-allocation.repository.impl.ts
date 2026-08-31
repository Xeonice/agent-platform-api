import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, isNull } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { DATABASE, asSandboxId } from '@platform/shared-kernel';
import type { NodeId, SandboxId, Tx } from '@platform/shared-kernel';
import { ResourceAllocation } from '../../../domain/entities/resource-allocation.entity';
import type { ReconciliationStatus } from '../../../domain/entities/resource-allocation.entity';
import type { ResourceAllocationRepository } from '../../../domain/repositories/resource-allocation.repository';
import {
  resourceAllocations,
  type ResourceAllocationRow,
} from '../schema/resource-allocation.sqlite';

type Db = BetterSQLite3Database<Record<string, never>>;

/** SQLite (better-sqlite3 + Drizzle) implementation of `ResourceAllocationRepository`. */
@Injectable()
export class SqliteResourceAllocationRepository implements ResourceAllocationRepository {
  constructor(@Inject(DATABASE) private readonly db: Db) {}

  async listActive(nodeId: NodeId): Promise<ResourceAllocation[]> {
    return this.db
      .select()
      .from(resourceAllocations)
      .where(and(eq(resourceAllocations.nodeId, nodeId), isNull(resourceAllocations.releasedAt)))
      .orderBy(asc(resourceAllocations.allocatedAt))
      .all()
      .map(toDomain);
  }

  async findActiveBySandbox(sandboxId: SandboxId): Promise<ResourceAllocation | null> {
    const row = this.db
      .select()
      .from(resourceAllocations)
      .where(
        and(eq(resourceAllocations.sandboxId, sandboxId), isNull(resourceAllocations.releasedAt)),
      )
      .get();
    return row ? toDomain(row) : null;
  }

  async listAll(): Promise<ResourceAllocation[]> {
    return this.db
      .select()
      .from(resourceAllocations)
      .orderBy(asc(resourceAllocations.allocatedAt))
      .all()
      .map(toDomain);
  }

  /**
   * ⚠️ `onConflictDoUpdate` 挂在 **PK** 上，不是挂在 `uq_alloc_active` 上。释放是对
   * **同一行**的更新（按 id），而 `uq_alloc_active` 的冲突意味着「这个 sandbox 已经有
   * 一条活跃登记了」—— 那是 I-RA-2 被撞破，必须抛到调用方，不能被一句 upsert 抹平。
   */
  saveSync(_tx: Tx, allocation: ResourceAllocation): void {
    const values = {
      id: allocation.id,
      sandboxId: allocation.sandboxId as string,
      nodeId: allocation.nodeId as string,
      coresReserved: allocation.coresReserved,
      ramMbReserved: allocation.ramMbReserved,
      diskMbReserved: allocation.diskMbReserved,
      allocatedAt: allocation.allocatedAt,
      releasedAt: allocation.releasedAt,
      reconciliationStatus: allocation.reconciliationStatus,
    };
    this.db
      .insert(resourceAllocations)
      .values(values)
      .onConflictDoUpdate({
        target: resourceAllocations.id,
        set: {
          releasedAt: values.releasedAt,
          reconciliationStatus: values.reconciliationStatus,
        },
      })
      .run();
  }
}

function toDomain(row: ResourceAllocationRow): ResourceAllocation {
  return ResourceAllocation.rehydrate({
    id: row.id,
    sandboxId: asSandboxId(row.sandboxId),
    nodeId: row.nodeId as NodeId,
    coresReserved: row.coresReserved,
    ramMbReserved: row.ramMbReserved,
    diskMbReserved: row.diskMbReserved,
    allocatedAt: row.allocatedAt,
    releasedAt: row.releasedAt,
    reconciliationStatus: row.reconciliationStatus as ReconciliationStatus,
  });
}
