import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import type { Clock } from '@platform/shared-kernel';
import type { AuditRecordInput, AuditRecorder } from '@platform/contracts';
import { SchedulerQueue } from '../../src/application/scheduler-queue';

/**
 * `SchedulerQueue`（03 §3「所有创建/销毁请求先进 `SchedulerQueue`（FIFO），保证公平性与
 * 可预测性」）。
 *
 * ── 这个文件在防什么 ──────────────────────────────────────────────────────────
 * 上一轮这里是 `ResourceAllocator` 内部一个裸的 `async-mutex`。行为对，但 03 §3 要的两件
 * 事一件都没有：没有可以指名道姓的队列对象，**也没有队列深度可观测**。而「可观测」如果
 * 只是一个没有任何出口的内部计数器，那和没有是一回事 —— 所以下面既测「深度算得对」，
 * 也测「它真的从审计流出去了」。
 */
const saved: Record<string, string | undefined> = {};
const KEYS = ['SCHEDULER_QUEUE_WARN_DEPTH'];

beforeEach(() => {
  for (const k of KEYS) saved[k] = process.env[k];
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.restoreAllMocks();
});

function makeQueue() {
  let now = new Date('2026-08-31T00:00:00.000Z');
  const clock: Clock = { now: () => now };
  const advance = (ms: number): void => {
    now = new Date(now.getTime() + ms);
  };
  const records: AuditRecordInput[] = [];
  const audit: AuditRecorder = { record: (r) => void records.push(r) };
  return { queue: new SchedulerQueue(clock, audit), records, advance };
}

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('FIFO：先进先出，而且一次只放行一个', () => {
  it('★★ 完成顺序 = 提交顺序，**与各自耗时无关**', async () => {
    const { queue } = makeQueue();
    const done: string[] = [];
    // 时长刻意递减：并行执行下完成顺序会是 d,c,b,a；串行 FIFO 下必须是 a,b,c,d。
    const jobs = [
      { id: 'a', ms: 40 },
      { id: 'b', ms: 30 },
      { id: 'c', ms: 20 },
      { id: 'd', ms: 10 },
    ];
    await Promise.all(
      jobs.map((j) =>
        queue.submit('create', `sbx-${j.id}`, async () => {
          await tick(j.ms);
          done.push(j.id);
        }),
      ),
    );
    expect(done).toEqual(['a', 'b', 'c', 'd']);
  });

  it('★ 临界区里同一时刻**至多一个** —— 用一个「同时在跑几个」的计数器证明', async () => {
    const { queue } = makeQueue();
    let concurrent = 0;
    let maxConcurrent = 0;
    await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        queue.submit('create', `sbx-${String(i)}`, async () => {
          concurrent += 1;
          maxConcurrent = Math.max(maxConcurrent, concurrent);
          await tick(5);
          concurrent -= 1;
        }),
      ),
    );
    expect(maxConcurrent).toBe(1);
  });

  it('★ `work` 抛异常不会把队列卡死，也不会漏掉出队', async () => {
    const { queue } = makeQueue();
    await expect(
      queue.submit('create', 'sbx-boom', () => Promise.reject(new Error('boom'))),
    ).rejects.toThrow('boom');
    // 锁没释放的话这一句会永远挂住（vitest 超时），深度也会永远停在 1。
    await expect(queue.submit('create', 'sbx-ok', () => Promise.resolve(7))).resolves.toBe(7);
    expect(queue.snapshot()).toMatchObject({ waiting: 0, running: 0, depth: 0 });
  });
});

describe('队列深度：算得对，而且看得见', () => {
  it('★ 排队期间 `depth` 真的涨起来，跑完回到 0', async () => {
    const { queue } = makeQueue();
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const first = queue.submit('create', 'sbx-1', async () => {
      await held;
    });
    // 让 first 真的进到临界区里
    await tick(1);
    expect(queue.snapshot()).toMatchObject({ waiting: 0, running: 1, depth: 1 });

    const rest = [1, 2, 3].map((n) =>
      queue.submit('create', `sbx-${String(n + 1)}`, () => Promise.resolve()),
    );
    await tick(1);
    expect(queue.snapshot()).toMatchObject({ waiting: 3, running: 1, depth: 4 });

    release();
    await Promise.all([first, ...rest]);
    const after = queue.snapshot();
    expect(after).toMatchObject({ waiting: 0, running: 0, depth: 0 });
    // ★ 低水位时 `peakDepth` 是唯一还能说明「刚才堵过」的数 —— 它不许跟着清零。
    expect(after.peakDepth).toBe(4);
  });

  it('按 kind 分别计数 —— 创建与销毁走的是同一条队列（03 §3:86）', async () => {
    const { queue } = makeQueue();
    await queue.submit('create', 'sbx-1', () => Promise.resolve());
    await queue.submit('destroy', 'sbx-1', () => Promise.resolve());
    await queue.submit('reconcile', 'sbx-1', () => Promise.resolve());
    expect(queue.snapshot().admitted).toEqual({ create: 1, destroy: 1, reconcile: 1 });
  });
});

describe('★★ 可观测的出口：审计流（13 §2.8.2 写入口 ②）', () => {
  it('★ 空队列上的请求**不记**审计 —— 与 `sandbox.health` 只在翻转时记同一条纪律', async () => {
    const { queue, records } = makeQueue();
    await queue.submit('create', 'sbx-1', () => Promise.resolve());
    await queue.submit('create', 'sbx-2', () => Promise.resolve());
    // 一个空闲平台上每次创建都记一行「队列深度 0」，等于把审计面板变成运行日志。
    expect(records).toEqual([]);
  });

  it('★★ 真的排过队才记，且带上入队时的深度', async () => {
    const { queue, records, advance } = makeQueue();
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const first = queue.submit('create', 'sbx-1', () => held);
    await tick(1);
    const second = queue.submit('destroy', 'sbx-2', () => Promise.resolve());
    await tick(1);
    // ⚠️ 必须在 second **已经在等** 之后才拨时钟：`enqueuedAt` 是入队那一刻取的，
    // 在它入队前拨等于什么都没等。
    advance(1500);
    release();
    await Promise.all([first, second]);

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      category: 'sandbox',
      type: 'sandbox.scheduler.queued',
      subjectType: 'sandbox',
      subjectId: 'sbx-2',
      actor: 'scheduler',
      detail: { kind: 'destroy', depthOnEnqueue: 1 },
    });
    // 等了多久是 detail 而不是判据（判据是深度）—— 但它必须是真的
    expect(records[0].durationMs).toBe(1500);
    expect(records[0].summary).toContain('第 2 位');
  });

  it('★ 判据是**深度**不是耗时：时钟冻住（waitedMs=0）时照样记', async () => {
    // 这一条钉的是实现选择本身。若判据写成 `waitedMs > 0`，在一个冻结时钟的测试里
    // （本仓的 `Clock` 替身默认就是冻结的）这条分支永远走不到 —— 断言存在、却测不到。
    const { queue, records } = makeQueue();
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const first = queue.submit('create', 'sbx-1', () => held);
    await tick(1);
    const second = queue.submit('create', 'sbx-2', () => Promise.resolve());
    await tick(1);
    release();
    await Promise.all([first, second]);

    expect(records).toHaveLength(1);
    expect(records[0].durationMs).toBe(0);
  });
});

describe('第二个出口：深度告警日志', () => {
  it('★ 深度越过阈值打一条 warn（阈值可配）', async () => {
    process.env.SCHEDULER_QUEUE_WARN_DEPTH = '2';
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { queue } = makeQueue();
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const first = queue.submit('create', 'sbx-1', () => held);
    await tick(1);
    const rest = [2, 3].map((n) =>
      queue.submit('create', `sbx-${String(n)}`, () => Promise.resolve()),
    );
    await tick(1);
    release();
    await Promise.all([first, ...rest]);

    const messages = warn.mock.calls.map((c) => String(c[0]));
    expect(messages.some((m) => m.includes('scheduler queue depth'))).toBe(true);
  });

  it('★ 阈值以下不打 —— 一条恒响的告警等于没有告警', async () => {
    process.env.SCHEDULER_QUEUE_WARN_DEPTH = '99';
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { queue } = makeQueue();
    await Promise.all(
      [1, 2, 3].map((n) => queue.submit('create', `sbx-${String(n)}`, () => Promise.resolve())),
    );
    expect(
      warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('queue depth')),
    ).toEqual([]);
  });
});
