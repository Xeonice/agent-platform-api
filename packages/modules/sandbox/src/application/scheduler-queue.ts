import { Inject, Injectable, Logger } from '@nestjs/common';
import { Mutex } from 'async-mutex';
import { CLOCK } from '@platform/shared-kernel';
import type { Clock } from '@platform/shared-kernel';
import { AUDIT_RECORDER } from '@platform/contracts';
import type { AuditRecorder } from '@platform/contracts';

/**
 * 进队列的是什么请求。03 §3 原话是「所有**创建/销毁**请求先进 `SchedulerQueue`」；
 * `reconcile` 是第三种 —— 对账路径同样是对资源池的读-改-写（判孤儿 + 释放），
 * 不排进同一条队列的话，它可能与用户手动销毁同时改一行登记，撞上 I-RA-1 的
 * 「释放不可回退」。
 */
export type SchedulerRequestKind = 'create' | 'destroy' | 'reconcile';

/** 队列深度的一次读数（03 §3「公平性与可预测性」的可观测面）。 */
export interface SchedulerQueueSnapshot {
  /** 已入队、还没轮到自己的请求数。 */
  waiting: number;
  /** 临界区里的那一个（单机单进程恒 0 或 1）。 */
  running: number;
  /** `waiting + running` —— 「现在有多少请求卡在调度上」。 */
  depth: number;
  /** 进程存活期间见过的最大 `depth`。低水位时它是唯一还能说明「刚才堵过」的数。 */
  peakDepth: number;
  /** 累计放行数（按 kind 分）。 */
  admitted: Record<SchedulerRequestKind, number>;
  /** 累计**排过队**（入队时前面有人）的请求数。 */
  queued: number;
}

/** 深度超过它就打一条 warn —— 第二个出口，零契约成本。 */
const DEFAULT_WARN_DEPTH = 8;

/**
 * `SchedulerQueue`（03 §3）—— **显式的 FIFO**，创建/销毁/对账三类请求对资源池的
 * 「读-改-写」都从这里过。
 *
 * ── 它替代了什么 ─────────────────────────────────────────────────────────────
 * 上一轮 `ResourceAllocator` 直接持有一个 `async-mutex`。行为上没问题（`async-mutex`
 * 本身就按 `acquire()` 的调用顺序放行，也就是 FIFO），但 03 §3 要的两件事**一件都
 * 拿不到**：没有一个可以指名道姓的队列对象，也**没有队列深度可观测** —— 而
 * 「公平性与可预测性」是一句需要能被看见才成立的话。
 *
 * ⚠️ **队列与临界区在这里是同一个东西，不是两层。** 03 §3 的图把「SchedulerQueue」
 * 与「互斥区」画成前后两格；单机单进程下，一个一次只放行一个的 FIFO **就同时是**
 * 这两格，再套一层 mutex 只会多一次可以死锁的嵌套。文档已按实现回填。
 *
 * ⚠️ **只有「读-改-写资源池」那一小段进队列，慢 IO 不进**（03 §3 第 3 条：拉镜像、
 * 起容器在临界区外并行）。所以 `destroy` 进队列的是**释放配额**那一步，而不是
 * `provider.destroy()` 那几十秒；对账进队列的是**写登记**那一步，而不是
 * `provider.inspect()`。字面意义上的「所有创建/销毁请求先进队列」会把销毁的慢 IO
 * 也串起来，那与同一节第 3 条自相矛盾。
 *
 * ── 可观测落在哪（本轮的选择，03 §3 记明）─────────────────────────────────────
 * **审计流**（`AUDIT_RECORDER` → `audit_events` → `GET /api/system/audit`，13 §2.8.2
 * 的写入口 ②）+ 一条 warn 日志。**不新造 HTTP 端点**，也不改 `GET /api/system/resources`
 * 的响应形状 —— 那会连带动 10 §6 / 27 与两仓 codegen，而这一条信息本轮还没有前端
 * 消费方。
 *
 * ⚠️ **只有真的排过队才记一条**（`depthOnEnqueue > 0`），与 `sandbox.health`
 * 「只在翻转时记，不是每 30s 记一条」是同一条纪律：一个空闲平台上每次创建都记一行
 * 「队列深度 0」，等于把审计面板变成运行日志（P21-5 §10.1 明令不要）。
 *
 * ⚠️ 判据是**深度**不是耗时。耗时要读 `Clock`，而测试里的 `Clock` 是可冻结的假时钟
 * —— 用 `waitedMs > 0` 当判据，会让这条分支在单测里永远走不到（`waitedMs` 仍然照记，
 * 它是 detail，不是判据）。
 */
@Injectable()
export class SchedulerQueue {
  private readonly logger = new Logger('SchedulerQueue');
  /**
   * FIFO 的实现基元。⚠️ **用 `runExclusive` 而不是 `isLocked()` 早退**（与
   * `AutomationScheduler` 相反，那里要的是「上一轮没跑完就跳过这一轮」）：这里每一个
   * 请求都必须**排队等到**自己那次判定 —— 跳过等于「忙的时候不检查就放行」，正是
   * 防超分配要防的那件事。
   */
  private readonly mutex = new Mutex();
  private waiting = 0;
  private running = 0;
  private peak = 0;
  private queuedTotal = 0;
  private readonly admitted: Record<SchedulerRequestKind, number> = {
    create: 0,
    destroy: 0,
    reconcile: 0,
  };

  constructor(
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(AUDIT_RECORDER) private readonly audit: AuditRecorder,
  ) {}

  get depth(): number {
    return this.waiting + this.running;
  }

  snapshot(): SchedulerQueueSnapshot {
    return {
      waiting: this.waiting,
      running: this.running,
      depth: this.depth,
      peakDepth: this.peak,
      admitted: { ...this.admitted },
      queued: this.queuedTotal,
    };
  }

  /**
   * 入队 → 轮到自己 → 跑 `work` → 出队。`work` 里**只放读-改-写资源池那一小段**。
   *
   * `subjectId` 只用于审计定位（哪一条沙箱的请求排了队）。
   */
  async submit<T>(
    kind: SchedulerRequestKind,
    subjectId: string,
    work: () => Promise<T>,
  ): Promise<T> {
    const depthOnEnqueue = this.depth;
    const enqueuedAt = this.clock.now().getTime();
    this.waiting += 1;
    this.peak = Math.max(this.peak, this.depth);
    if (this.depth >= warnDepth()) {
      // 第二个出口。⚠️ 它是 `warn` 而不是 `log`：一个持续堆积的调度队列意味着用户正在
      // 等，而这件事在今天没有任何 UI 说得出来。
      this.logger.warn(
        `scheduler queue depth is ${String(this.depth)} (waiting=${String(this.waiting)}) — ` +
          'admission requests are piling up; check the resource pool watermark',
      );
    }
    try {
      return await this.mutex.runExclusive(async () => {
        this.waiting -= 1;
        this.running += 1;
        try {
          return await work();
        } finally {
          this.running -= 1;
          this.admitted[kind] += 1;
          if (depthOnEnqueue > 0) {
            this.queuedTotal += 1;
            this.recordQueued(kind, subjectId, depthOnEnqueue, enqueuedAt);
          }
        }
      });
    } catch (e) {
      // `runExclusive` 之前抛不可能发生（上面几行没有 await），但如果将来有人在中间
      // 加了一步 await，计数必须不漏 —— 一个只增不减的 `waiting` 会让深度这个数字
      // 从此永远是错的，而且没有任何东西会红。
      if (this.waiting < 0) this.waiting = 0;
      throw e;
    }
  }

  private recordQueued(
    kind: SchedulerRequestKind,
    subjectId: string,
    depthOnEnqueue: number,
    enqueuedAt: number,
  ): void {
    const waitedMs = Math.max(0, this.clock.now().getTime() - enqueuedAt);
    this.audit.record({
      category: 'sandbox',
      type: 'sandbox.scheduler.queued',
      severity: 'info',
      subjectType: 'sandbox',
      subjectId,
      actor: 'scheduler',
      summary: `调度队列：${kind} 请求排在第 ${String(depthOnEnqueue + 1)} 位`,
      detail: {
        kind,
        depthOnEnqueue,
        peakDepth: this.peak,
      },
      durationMs: waitedMs,
      outcome: 'ok',
    });
  }
}

function warnDepth(): number {
  const raw = process.env.SCHEDULER_QUEUE_WARN_DEPTH;
  if (raw === undefined) return DEFAULT_WARN_DEPTH;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_WARN_DEPTH;
}
