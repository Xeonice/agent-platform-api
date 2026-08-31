import { resolve } from 'node:path';
import { beforeEach, describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { asProjectId, asSandboxId } from '@platform/shared-kernel';
import type { NodeId } from '@platform/shared-kernel';
import { Sandbox } from '../../src/domain/entities/sandbox.entity';
import { ResourceAllocation } from '../../src/domain/entities/resource-allocation.entity';
import { SqliteSandboxRepository } from '../../src/infrastructure/persistence/sqlite/sandbox.repository.impl';
import { SqliteResourceAllocationRepository } from '../../src/infrastructure/persistence/sqlite/resource-allocation.repository.impl';
import { SqliteUnitOfWork } from '../../../../../apps/api/src/platform/persistence/unit-of-work.impl';

/**
 * 真 sqlite + 真迁移 —— 13 §2.1.3 `resource_allocations` 的存储层约束。
 *
 * ⚠️ **这一层不是「再测一遍领域不变量」。** I-RA-2（同一 sandbox 至多一条活跃登记）在
 * 领域里**故意不判**：一个聚合实例看不见别的行。13 §2.1.3 把它下沉成 `uq_alloc_active`
 * 这条**部分**唯一索引，并称之为「并发创建时最后一道防超分配的闸」。那条索引存不存在、
 * `WHERE released_at IS NULL` 有没有丢，只有在真库上问得出来 —— 内存替身里假装有一条
 * 唯一索引，只会让「真索引其实没建出来」永远发现不了。
 */
const NOW = new Date('2026-08-31T00:00:00.000Z');
const NODE = 'local' as NodeId;

function makeHarness() {
  const sqlite = new Database(':memory:');
  // 外键在 better-sqlite3 里默认关闭；这里显式打开，`FK→sandboxes.id` 才真的成立。
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite) as BetterSQLite3Database<Record<string, never>>;
  migrate(db, { migrationsFolder: resolve(process.cwd(), 'drizzle') });
  const repo = new SqliteResourceAllocationRepository(db);
  const sandboxes = new SqliteSandboxRepository(db);
  const uow = new SqliteUnitOfWork(sqlite);
  const seedSandbox = (id: string): void => {
    uow.run((tx) =>
      sandboxes.saveSync(
        tx,
        Sandbox.create({
          id: asSandboxId(id),
          projectId: asProjectId('prj-1'),
          runtime: 'codex',
          provider: 'boxlite',
          headless: true,
          timeoutMinutes: 60,
          idleTimeoutSec: 1800,
          now: NOW,
        }),
      ),
    );
  };
  return { sqlite, db, repo, uow, seedSandbox };
}

function allocation(id: string, sandboxId: string, quota = { cores: 1, ramMb: 512, diskMb: 512 }) {
  return ResourceAllocation.allocate({
    id,
    sandboxId: asSandboxId(sandboxId),
    nodeId: NODE,
    quota,
    now: NOW,
  });
}

describe('SqliteResourceAllocationRepository（13 §2.1.3）', () => {
  let h: ReturnType<typeof makeHarness>;
  beforeEach(() => {
    h = makeHarness();
    h.seedSandbox('sbx-1');
    h.seedSandbox('sbx-2');
  });

  it('往返：九列一个不落', async () => {
    const a = allocation('alloc-1', 'sbx-1', { cores: 0.5, ramMb: 2048, diskMb: 12_288 });
    h.uow.run((tx) => h.repo.saveSync(tx, a));

    const [loaded] = await h.repo.listAll();
    expect(loaded.id).toBe('alloc-1');
    expect(loaded.sandboxId).toBe('sbx-1');
    expect(loaded.nodeId).toBe('local');
    // `cores_reserved` 是 real —— 若谁把它写成 integer，0.5 会被截成 0，而 CHECK > 0
    // 会在半个事务之后才炸。
    expect(loaded.quota).toEqual({ cores: 0.5, ramMb: 2048, diskMb: 12_288 });
    expect(loaded.allocatedAt).toEqual(NOW);
    expect(loaded.releasedAt).toBeNull();
    expect(loaded.reconciliationStatus).toBe('pending');
  });

  it('★★ `uq_alloc_active`：同一 sandbox 第二条**活跃**登记被库拒（I-RA-2 的最后一道闸）', () => {
    h.uow.run((tx) => h.repo.saveSync(tx, allocation('alloc-1', 'sbx-1')));
    expect(() => h.uow.run((tx) => h.repo.saveSync(tx, allocation('alloc-2', 'sbx-1')))).toThrow(
      /UNIQUE constraint failed/,
    );
  });

  it('★★ 但它是**部分**索引：释放之后同一个 sandbox 可以再登记一次', async () => {
    const first = allocation('alloc-1', 'sbx-1');
    h.uow.run((tx) => h.repo.saveSync(tx, first));
    first.release(NOW);
    h.uow.run((tx) => h.repo.saveSync(tx, first));

    // ⚠️ 这一条是 `WHERE released_at IS NULL` 那半句的守卫。丢掉 `where`，索引就退化成
    // 「一个 sandbox 一辈子只能有一条登记」——「销毁后重建」直接写不进去，而只建不销毁
    // 的测试一条都不会红。
    expect(() =>
      h.uow.run((tx) => h.repo.saveSync(tx, allocation('alloc-2', 'sbx-1'))),
    ).not.toThrow();
    expect(await h.repo.listAll()).toHaveLength(2);
    expect(await h.repo.listActive(NODE)).toHaveLength(1);
  });

  it('不同 sandbox 各自一条活跃登记，互不干扰', async () => {
    h.uow.run((tx) => h.repo.saveSync(tx, allocation('alloc-1', 'sbx-1')));
    h.uow.run((tx) => h.repo.saveSync(tx, allocation('alloc-2', 'sbx-2')));
    expect(await h.repo.listActive(NODE)).toHaveLength(2);
  });

  it('`listActive` 只回未释放的，且按 node 过滤', async () => {
    const a = allocation('alloc-1', 'sbx-1');
    const b = allocation('alloc-2', 'sbx-2');
    h.uow.run((tx) => {
      h.repo.saveSync(tx, a);
      h.repo.saveSync(tx, b);
    });
    b.release(NOW);
    h.uow.run((tx) => h.repo.saveSync(tx, b));

    expect((await h.repo.listActive(NODE)).map((r) => r.id)).toEqual(['alloc-1']);
    expect(await h.repo.listActive('other-node' as NodeId)).toEqual([]);
    expect(await h.repo.findActiveBySandbox(asSandboxId('sbx-2'))).toBeNull();
    expect((await h.repo.findActiveBySandbox(asSandboxId('sbx-1')))?.id).toBe('alloc-1');
  });

  it('★ 三维 `> 0` 的 CHECK 真的在库里（领域侧那一半挡不住直接写库的路径）', () => {
    const bad = ResourceAllocation.rehydrate({
      id: 'alloc-bad',
      sandboxId: asSandboxId('sbx-1'),
      nodeId: NODE,
      coresReserved: 1,
      ramMbReserved: 512,
      diskMbReserved: 0,
      allocatedAt: NOW,
      releasedAt: null,
      reconciliationStatus: 'pending',
    });
    expect(() => h.uow.run((tx) => h.repo.saveSync(tx, bad))).toThrow(/CHECK constraint failed/);
  });

  it('★ `reconciliation_status` 的三值 CHECK 在库里', () => {
    const bad = ResourceAllocation.rehydrate({
      id: 'alloc-bad',
      sandboxId: asSandboxId('sbx-1'),
      nodeId: NODE,
      coresReserved: 1,
      ramMbReserved: 512,
      diskMbReserved: 512,
      allocatedAt: NOW,
      releasedAt: null,
      // 领域里这是个联合类型，但迁移过的老库/手工 SQL 写得进来 —— CHECK 是那道闸。
      reconciliationStatus: 'whatever' as 'pending',
    });
    expect(() => h.uow.run((tx) => h.repo.saveSync(tx, bad))).toThrow(/CHECK constraint failed/);
  });

  it('★ `FK→sandboxes.id`：挂在一个不存在的 sandbox 上写不进去', () => {
    expect(() => h.uow.run((tx) => h.repo.saveSync(tx, allocation('a', 'sbx-nope')))).toThrow(
      /FOREIGN KEY constraint failed/,
    );
  });

  it('★ `ON DELETE CASCADE`：sandbox 行被删，它的登记跟着走', async () => {
    h.uow.run((tx) => h.repo.saveSync(tx, allocation('alloc-1', 'sbx-1')));
    h.sqlite.prepare('DELETE FROM sandboxes WHERE id = ?').run('sbx-1');
    expect(await h.repo.listAll()).toHaveLength(0);
  });

  it('释放是对**同一行**的更新（按 PK upsert），不是插一条新行', async () => {
    const a = allocation('alloc-1', 'sbx-1');
    h.uow.run((tx) => h.repo.saveSync(tx, a));
    a.release(new Date(NOW.getTime() + 60_000));
    a.markOrphaned();
    h.uow.run((tx) => h.repo.saveSync(tx, a));

    const rows = await h.repo.listAll();
    expect(rows).toHaveLength(1);
    expect(rows[0].releasedAt).toEqual(new Date(NOW.getTime() + 60_000));
    expect(rows[0].reconciliationStatus).toBe('orphaned');
  });
});
