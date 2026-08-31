import { describe, it, expect } from 'vitest';
import { asSandboxId } from '@platform/shared-kernel';
import type { NodeId } from '@platform/shared-kernel';
import { ResourceAllocation } from '../../src/domain/entities/resource-allocation.entity';

const NODE = 'local' as NodeId;
const NOW = new Date('2026-08-31T00:00:00.000Z');

function alloc(quota = { cores: 1, ramMb: 512, diskMb: 512 }): ResourceAllocation {
  return ResourceAllocation.allocate({
    id: 'alloc-1',
    sandboxId: asSandboxId('sbx-1'),
    nodeId: NODE,
    quota,
    now: NOW,
  });
}

/** 23 §5.4 的三条不变量，逐条（I-RA-2 在存储层，见 integration）。 */
describe('ResourceAllocation（23 §5.4 / 13 §2.1.3）', () => {
  it('新登记是活跃的，且 reconciliation 是 `pending` —— 实例这一刻还不存在', () => {
    const a = alloc();
    expect(a.isActive).toBe(true);
    expect(a.releasedAt).toBeNull();
    // ⚠️ 若这里写成 `confirmed`，对账就永远没有东西可确认 —— 而「登记了但实例没建出来」
    // 恰恰是崩溃后最常见的那一格。
    expect(a.reconciliationStatus).toBe('pending');
  });

  it('三个维度都必须为正（13 §2.1.3 CHECK 的领域侧那一半）', () => {
    expect(() => alloc({ cores: 0, ramMb: 512, diskMb: 512 })).toThrow(/positive/);
    expect(() => alloc({ cores: 1, ramMb: 0, diskMb: 512 })).toThrow(/positive/);
    expect(() => alloc({ cores: 1, ramMb: 512, diskMb: 0 })).toThrow(/positive/);
    expect(() => alloc({ cores: -1, ramMb: 512, diskMb: 512 })).toThrow(/positive/);
  });

  it('★ I-RA-1：释放不可回退 —— 第二次释放**抛**，不是静默 no-op', () => {
    const a = alloc();
    a.release(NOW);
    expect(a.isActive).toBe(false);
    expect(a.releasedAt).toEqual(NOW);
    // 静默吞掉第二次，意味着某条路径以为自己还占着资源而其实没有 —— 而池子会把这份
    // 配额当成两次归还里的一次。
    expect(() => a.release(new Date(NOW.getTime() + 1000))).toThrow(/I-RA-1/);
  });

  it('★ I-RA-3：判孤儿与判存活是**两个方法**，不是一个带参数的方法', () => {
    const a = alloc();
    a.confirm();
    expect(a.reconciliationStatus).toBe('confirmed');
    a.markOrphaned();
    expect(a.reconciliationStatus).toBe('orphaned');
    // 只有一个 `markReconciliation(status)` 的话，「谁能判孤儿」在调用图上就 grep 不出来。
    expect('markReconciliation' in a).toBe(false);
  });

  it('`quota` 把三列读回成 provider 认得的那个形状', () => {
    expect(alloc({ cores: 2, ramMb: 4096, diskMb: 12_288 }).quota).toEqual({
      cores: 2,
      ramMb: 4096,
      diskMb: 12_288,
    });
  });

  it('rehydrate 不重跑构造期校验 —— 库里的行已经过了那一关', () => {
    const a = ResourceAllocation.rehydrate({
      id: 'alloc-legacy',
      sandboxId: asSandboxId('sbx-1'),
      nodeId: NODE,
      coresReserved: 1,
      ramMbReserved: 512,
      diskMbReserved: 512,
      allocatedAt: NOW,
      releasedAt: NOW,
      reconciliationStatus: 'orphaned',
    });
    expect(a.isActive).toBe(false);
    expect(a.reconciliationStatus).toBe('orphaned');
  });
});
