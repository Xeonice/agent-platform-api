import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { asSandboxId } from '@platform/shared-kernel';
import type { NodeId } from '@platform/shared-kernel';
import type { CreateSandboxInput } from '@platform/contracts';
import { ResourceAllocation } from '../../src/domain/entities/resource-allocation.entity';
import { SandboxReconciledAsOrphan } from '../../src/domain/events/sandbox-events';
import { harness as makeHarness, waitForStatus } from './_harness';

/**
 * 13 §4「配额对账（重启后 DB vs 实际容器）」/ 03 §6「配额登记表持久化（重启后恢复资源池
 * 视图）」。
 *
 * ── 它防的是一个只减不增的漏 ───────────────────────────────────────────────────
 * 账本是持久的、进程不是。被 kill 的那一刻留在库里的活跃登记，对应的容器可能早就不在。
 * 没有对账，资源池视图在每一次非正常退出后都会**永久**少一块 —— 攒够就是一台谁也建不出
 * Task 的机器，而日志里一句话都没有。
 */

const base: CreateSandboxInput = { projectId: 'prj-1', runtime: 'claude-code' };
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of [
    'SCHEDULER_SAFETY_MARGIN',
    'WORKSPACE_MIN_FREE_BYTES',
    'QUOTA_RECONCILE_STALE_MS',
    'QUOTA_RECONCILE_BATCH',
  ])
    saved[k] = process.env[k];
  process.env.SCHEDULER_SAFETY_MARGIN = '0';
  process.env.WORKSPACE_MIN_FREE_BYTES = '0';
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('QuotaReconciler（13 §4 三路对比）', () => {
  it('DB 活跃 + 实例还在 ⇒ `confirmed`，配额**不**释放', async () => {
    const h = makeHarness();
    const dto = await h.service.create(base);
    await waitForStatus(h.service, dto.id, 'running');

    const report = await h.quotaReconciler.reconcile();
    expect(report).toMatchObject({ scanned: 1, confirmed: 1, orphaned: 0 });
    const [row] = await h.allocations.listAll();
    expect(row.isActive).toBe(true);
    expect(row.reconciliationStatus).toBe('confirmed');
  });

  it('★ DB 活跃 + 实例查无 ⇒ `orphaned` + 释放（配额回池）', async () => {
    const h = makeHarness();
    const dto = await h.service.create(base);
    await waitForStatus(h.service, dto.id, 'running');
    h.provider.inspectResult = { lifecycleState: 'instance_missing' };

    const report = await h.quotaReconciler.reconcile();
    expect(report).toMatchObject({ scanned: 1, orphaned: 1 });
    const [row] = await h.allocations.listAll();
    expect(row.isActive).toBe(false);
    expect(row.reconciliationStatus).toBe('orphaned');
  });

  it('★ `exited` / `dead` **不是**「查无」—— 停掉的沙箱仍然占着盘，配额不许放', async () => {
    const h = makeHarness();
    const dto = await h.service.create(base);
    await waitForStatus(h.service, dto.id, 'running');
    h.provider.inspectResult = { lifecycleState: 'instance_exited' };

    const report = await h.quotaReconciler.reconcile();
    expect(report.orphaned).toBe(0);
    expect((await h.allocations.listAll())[0].isActive).toBe(true);
  });

  it('★★ `inspect` **抛异常**（daemon 抖动）⇒ 一条都不动，不是全部判孤儿', async () => {
    const h = makeHarness();
    const dto = await h.service.create(base);
    await waitForStatus(h.service, dto.id, 'running');
    h.provider.inspectResult = new Error('Cannot connect to the Docker daemon');

    const report = await h.quotaReconciler.reconcile();
    // 把「问不出来」读成「查无」，会在一次 daemon 抖动里把全部活跃登记放掉 ——
    // 而它们对应的沙箱都还活着。宁可漏收，不可误放。
    expect(report).toMatchObject({ scanned: 1, confirmed: 0, orphaned: 0 });
    expect((await h.allocations.listAll())[0].isActive).toBe(true);
  });

  it('★ 还没建出实例（没有 provider handle）⇒ 不判孤儿', async () => {
    // provider.create 挂住不返回 ⇒ 沙箱停在 `creating`，登记已在、handle 还没有。
    const h = makeHarness();
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((r) => (release = r));
    const original = h.provider.create.bind(h.provider);
    h.provider.create = async (ctx) => {
      await blocked;
      return original(ctx);
    };
    const dto = await h.service.create(base);
    await waitForStatus(h.service, dto.id, 'creating');

    const report = await h.quotaReconciler.reconcile();
    expect(report).toMatchObject({ scanned: 1, confirmed: 0, orphaned: 0 });
    expect((await h.allocations.listAll())[0].isActive).toBe(true);
    release?.();
    await waitForStatus(h.service, dto.id, 'running');
  });

  it('★ 沙箱已终态但登记还活着（释放那一步崩在中间）⇒ 账本补上', async () => {
    const h = makeHarness({ installError: new Error('npm exploded') });
    const dto = await h.service.create(base);
    await waitForStatus(h.service, dto.id, 'failed');

    // 模拟「释放没跑成」：把同一条登记硬扳回活跃，再让对账去收。
    const [row] = await h.allocations.listAll();
    h.allocations.store.set(
      row.id,
      ResourceAllocation.rehydrate({
        id: row.id,
        sandboxId: asSandboxId(row.sandboxId),
        nodeId: row.nodeId as NodeId,
        coresReserved: row.coresReserved,
        ramMbReserved: row.ramMbReserved,
        diskMbReserved: row.diskMbReserved,
        allocatedAt: row.allocatedAt,
        releasedAt: null,
        reconciliationStatus: 'pending',
      }),
    );
    expect((await h.allocations.listAll())[0].isActive).toBe(true);

    const report = await h.quotaReconciler.reconcile();
    expect(report.orphaned).toBe(1);
    expect((await h.allocations.listAll())[0].isActive).toBe(false);
  });
});

/** 30min 的默认 staleness 窗口 —— 用例把时钟拨过它来制造「长时间未更新」。 */
const STALE_MS = 30 * 60_000;

/** 造 n 个 running 的沙箱（各带一条活跃登记）。 */
async function runningSandboxes(h: ReturnType<typeof makeHarness>, n: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const dto = await h.service.create(base);
    await waitForStatus(h.service, dto.id, 'running');
    ids.push(dto.id);
  }
  return ids;
}

describe('★★ 运行期增量对账（13 §4「只挑长时间未更新的活跃记录」）', () => {
  it('★★ 刚建出来的登记**不在**增量范围里 —— 否则「增量」就是每 5 分钟一次全量', async () => {
    const h = makeHarness();
    await runningSandboxes(h, 3);

    const report = await h.quotaReconciler.reconcileIncremental();

    // 没有「上次核对」记录时按 `allocatedAt` 算，所以新登记天然不到期 ——
    // 这也顺带保证了还在 provision 的沙箱不会被立刻探测。
    expect(report.scanned).toBe(0);
    expect(h.provider.calls.filter((c) => c === 'inspect')).toHaveLength(0);
  });

  it('★ 过了 staleness 窗口才进范围', async () => {
    const h = makeHarness();
    await runningSandboxes(h, 2);

    h.advanceClock(STALE_MS - 1);
    expect((await h.quotaReconciler.reconcileIncremental()).scanned).toBe(0);

    h.advanceClock(2);
    expect((await h.quotaReconciler.reconcileIncremental()).scanned).toBe(2);
  });

  it('★★ 核对过就不再重复挑 —— 直到下一个窗口', async () => {
    const h = makeHarness();
    await runningSandboxes(h, 2);
    h.advanceClock(STALE_MS + 1);
    expect((await h.quotaReconciler.reconcileIncremental()).scanned).toBe(2);

    // 紧接着再扫一轮：一条都不该再被挑走。少了「记下核对时刻」这一步，
    // 每 5 分钟就是一次全量扫 provider —— 正是 13 §4 挑增量要避开的那件事。
    expect((await h.quotaReconciler.reconcileIncremental()).scanned).toBe(0);

    h.advanceClock(STALE_MS + 1);
    expect((await h.quotaReconciler.reconcileIncremental()).scanned).toBe(2);
  });

  it('★★ `unknown`（provider 问不出来）**不记**核对时刻 —— 下一轮还要再看它', async () => {
    const h = makeHarness();
    await runningSandboxes(h, 1);
    h.advanceClock(STALE_MS + 1);
    h.provider.inspectResult = new Error('Cannot connect to the Docker daemon');

    expect((await h.quotaReconciler.reconcileIncremental()).scanned).toBe(1);
    // 记了的话，一个 daemon 挂了半分钟的沙箱要再等 30 分钟才有人去看它。
    expect((await h.quotaReconciler.reconcileIncremental()).scanned).toBe(1);

    h.provider.inspectResult = { lifecycleState: 'instance_running' };
    expect((await h.quotaReconciler.reconcileIncremental()).confirmed).toBe(1);
    expect((await h.quotaReconciler.reconcileIncremental()).scanned).toBe(0);
  });

  it('★★ 单轮有上限，且**最旧的先来**（否则后面的永远轮不到）', async () => {
    process.env.QUOTA_RECONCILE_BATCH = '2';
    const h = makeHarness();
    const [first, second] = await runningSandboxes(h, 2);
    // 让前两个比后两个更旧
    h.advanceClock(10 * 60_000);
    await runningSandboxes(h, 2);
    h.advanceClock(STALE_MS + 1);

    const report = await h.quotaReconciler.reconcileIncremental();
    expect(report.scanned).toBe(2);
    // 被核对的必须是最旧的那两条
    const checked = (await h.allocations.listAll())
      .filter((a) => a.reconciliationStatus === 'confirmed')
      .map((a) => a.sandboxId as string)
      .sort();
    expect(checked).toEqual([first, second].sort());
  });

  it('★ 三条纪律在增量这条路径上同样成立（与开机全量共用同一段判据）', async () => {
    const h = makeHarness();
    await runningSandboxes(h, 1);
    h.advanceClock(STALE_MS + 1);

    // ① exited 不是「查无」
    h.provider.inspectResult = { lifecycleState: 'instance_exited' };
    expect((await h.quotaReconciler.reconcileIncremental()).orphaned).toBe(0);
    expect((await h.allocations.listAll())[0].isActive).toBe(true);

    // ② missing 才是
    h.advanceClock(STALE_MS + 1);
    h.provider.inspectResult = { lifecycleState: 'instance_missing' };
    expect((await h.quotaReconciler.reconcileIncremental()).orphaned).toBe(1);
    expect((await h.allocations.listAll())[0].isActive).toBe(false);
  });

  it('`sweep()` 永不抛，且不重入', async () => {
    const h = makeHarness();
    await runningSandboxes(h, 1);
    h.advanceClock(STALE_MS + 1);

    const [a, b] = await Promise.all([h.quotaReconciler.sweep(), h.quotaReconciler.sweep()]);
    // 一个真跑、一个立刻返回空报告；谁先到不重要，两者之和恰好是一轮。
    expect(a.scanned + b.scanned).toBe(1);
  });
});

describe('★★ `SandboxReconciledAsOrphan`：终于有了产出方（17 §76 / 23 §5.6）', () => {
  async function orphaned(): Promise<{
    h: ReturnType<typeof makeHarness>;
    sandboxId: string;
  }> {
    const h = makeHarness();
    const [sandboxId] = await runningSandboxes(h, 1);
    h.provider.inspectResult = { lifecycleState: 'instance_missing' };
    await h.quotaReconciler.reconcile();
    return { h, sandboxId };
  }

  it('★★ 判定孤儿时发一条事件，载荷带得动一行人话', async () => {
    const { h, sandboxId } = await orphaned();
    const events = h.publishedEvents.filter((e) => e instanceof SandboxReconciledAsOrphan);
    expect(events).toHaveLength(1);
    const e = events[0] as SandboxReconciledAsOrphan;
    expect(e.sandboxId).toBe(sandboxId);
    expect(e.projectId).toBe('prj-1');
    expect(e.name.length).toBeGreaterThan(0);
    // ★ 记的是**当时**的状态 —— 而这次对账不会改它，那正是这条记录的价值
    expect(e.status).toBe('running');
    expect(e.reason).toContain('container missing');
  });

  it('★★ 事件发了，但 `sandboxes.status` **没被改** —— 判死不属于对账（13 §4 已按实现回填）', async () => {
    const { h, sandboxId } = await orphaned();
    expect((await h.service.get(sandboxId)).status).toBe('running');
    // 也没有多出一次状态流转
    expect(h.repo.store.get(sandboxId)?.transitions.map((t) => t.to)).not.toContain('failed');
  });

  it('★ 实例还在（`alive`）⇒ 一条都不发', async () => {
    const h = makeHarness();
    await runningSandboxes(h, 1);
    await h.quotaReconciler.reconcile();
    expect(h.publishedEvents.filter((e) => e instanceof SandboxReconciledAsOrphan)).toEqual([]);
  });

  it('★ provider 问不出来（`unknown`）⇒ 一条都不发', async () => {
    const h = makeHarness();
    await runningSandboxes(h, 1);
    h.provider.inspectResult = new Error('daemon down');
    await h.quotaReconciler.reconcile();
    expect(h.publishedEvents.filter((e) => e instanceof SandboxReconciledAsOrphan)).toEqual([]);
  });

  it('★★ 释放是 no-op（销毁抢先跑完了）⇒ 不发事件，也不多算一个孤儿', async () => {
    // 竞态的形状：`releaseAsOrphan` 拿到的是一条已经不活跃的登记。直接问 allocator，
    // 因为从对账那一头构造这个竞态需要一个真实的并发窗口。
    const h = makeHarness();
    const [sandboxId] = await runningSandboxes(h, 1);
    await h.service.destroy(sandboxId);

    let published = 0;
    const released = await h.resources.releaseAsOrphan(asSandboxId(sandboxId), () => {
      published += 1;
    });
    expect(released).toBe(false);
    // 事件与释放同一个事务、同一支分支：没释放就没有事实可报。
    expect(published).toBe(0);
  });
});

describe('03 §3：对账的写登记也走同一条 FIFO 队列', () => {
  it('★ 判孤儿走的是 `reconcile` 那一档，不是绕过队列直接写库', async () => {
    const h = makeHarness();
    await runningSandboxes(h, 1);
    const before = h.schedulerQueue.snapshot().admitted.reconcile;
    h.provider.inspectResult = { lifecycleState: 'instance_missing' };
    await h.quotaReconciler.reconcile();
    // 不走队列的话，「用户按了销毁」与「对账判它是孤儿」会同时改同一行登记，
    // 后到的那次撞上 I-RA-1 抛异常 —— 一个只在真实并发下出现的偶发。
    expect(h.schedulerQueue.snapshot().admitted.reconcile).toBeGreaterThan(before);
  });
});
