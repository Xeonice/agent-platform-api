import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { CLOCK, EVENT_BUS } from '@platform/shared-kernel';
import type { Clock, EventBus, NodeId } from '@platform/shared-kernel';
import { SANDBOX_PROVIDER_REGISTRY } from '@platform/contracts';
import type { ProviderRegistry, SandboxHandle } from '@platform/contracts';
import { SANDBOX_REPOSITORY } from '../domain/repositories/sandbox.repository';
import type { SandboxRepository } from '../domain/repositories/sandbox.repository';
import { RESOURCE_ALLOCATION_REPOSITORY } from '../domain/repositories/resource-allocation.repository';
import type { ResourceAllocationRepository } from '../domain/repositories/resource-allocation.repository';
import type { ResourceAllocation } from '../domain/entities/resource-allocation.entity';
import type { Sandbox } from '../domain/entities/sandbox.entity';
import { SandboxReconciledAsOrphan } from '../domain/events/sandbox-events';
import { ResourceAllocator } from './resource-allocator';

/** Sandbox 状态里「这条记录不会再占任何资源了」的那几个。 */
const TERMINAL: ReadonlySet<string> = new Set(['destroyed', 'failed']);

/** 13 §4「运行期每 5min 增量对账」。 */
export const INCREMENTAL_INTERVAL_MS = 5 * 60_000;

/**
 * 一条活跃登记多久没被核对过，才算「长时间未更新」（13 §4 原话）。
 *
 * ⚠️ **它必须**远大于**扫描周期，否则「增量」就是每 5 分钟一次全量** —— 而 13 §4 挑
 * 增量的理由恰恰是「避免高频全量扫 provider API」。30min ⇒ 每一轮大约只碰 1/6 的登记，
 * 每条登记仍然半小时被核对一次。
 */
const DEFAULT_STALE_MS = 30 * 60_000;

/** 单轮增量最多核对多少条 —— 200 条登记的机器不该在一个 tick 里打 200 次 provider。 */
const DEFAULT_BATCH = 20;

export interface QuotaReconcileReport {
  scanned: number;
  confirmed: number;
  orphaned: number;
}

/**
 * 03 §6「配额登记表持久化（重启后恢复资源池视图：扫描存活容器 + 落库配额对账）」
 * 与 13 §4 的三路对比。
 *
 * ── 两条路径，一段判据 ────────────────────────────────────────────────────────
 * - **开机全量**（`onApplicationBootstrap`）：账本是持久的、进程不是。被 kill 的那一刻
 *   留在库里的活跃登记，对应的容器可能早就不在了。没有这一步，资源池视图在每一次非
 *   正常退出后都会**永久**少一块 —— 而且是**只减不增**的那种，攒够十次就是一台谁也建
 *   不出 Task 的机器，日志里一句话都没有。
 * - **运行期每 5min 增量**（13 §4）：只挑**长时间未更新**的活跃记录，不是每 5 分钟重扫
 *   一遍全部。它补的是开机那次覆盖不到的东西 —— 一台连开三周不重启的机器上，容器可能
 *   在第二周被人手动 `docker rm` 掉，而账本会一直记着它。
 *
 * ⚠️ **两条路径共用同一个 {@link verdictFor}**，三条纪律因此对增量同样成立，不许在新
 * 路径上放宽：
 *   ① **只有 `instance_missing` 才算「容器查无」。** `instance_exited` / `instance_dead`
 *     仍占着盘（工作区还在、rootfs 还在），判它们孤儿等于宣布停掉的沙箱不占资源 ——
 *     而 `start` 明天还能把它拉回来。
 *   ② **`inspect` 抛异常 ≠ 容器不在。** provider 不可达（docker daemon 没起、boxlite 锁
 *     被占）时每一条 inspect 都会抛，读成「查无」会在一次抖动里把**全部**活跃登记判成
 *     孤儿、连带把一批还活着的沙箱的配额放掉。这一格的处置是**不动** + 一条 warn
 *     （与 `RuntimeReconciler`「宁可漏收，不可误删」同一条纪律）。
 *   ③ **不改 `sandboxes.status`。** 13 §4 那一格原写「status→failed」，但把沙箱判死属于
 *     `SandboxHealthMonitor` / 生命周期那条链路；两处都写会在同一个事实上产生两个写者，
 *     而这一个还是在启动期、没有任何事件覆盖的那个。**判死不做，但事实要说**：
 *     `SandboxReconciledAsOrphan` 与释放登记同一个事务发出去（17 §76 的消费方是审计）。
 *
 * ⚠️ **「多久没核对过」记在内存里，不落库。** 13 §2.1.3 的九列里没有 `last_checked_at`，
 * 而为一个纯运行期的调度信息加一列 + 一次迁移，换来的只是「跨重启记得上次核对时刻」——
 * 而重启本来就会触发一次**全量**对账，那份记忆到那时正好一文不值。没有记录的登记按
 * `allocatedAt` 算，于是刚建出来、还在 provision 的沙箱不会被立刻探测。
 *
 * ⚠️ 「容器存在 + DB 无记录」那一格**不在这里** —— 那是 `RuntimeReconciler` 的方向
 * （它按标签扫 provider）。
 */
@Injectable()
export class QuotaReconciler implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('QuotaReconciler');
  /** allocationId → 上一次拿到确定判据（`alive`/`gone`）的时刻。见类注释。 */
  private readonly lastCheckedAt = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;
  /** 上一轮还没跑完就不开下一轮 —— provider 慢的时候，重入只会把它压得更慢。 */
  private sweeping = false;

  constructor(
    @Inject(RESOURCE_ALLOCATION_REPOSITORY)
    private readonly allocations: ResourceAllocationRepository,
    @Inject(SANDBOX_REPOSITORY) private readonly sandboxes: SandboxRepository,
    @Inject(SANDBOX_PROVIDER_REGISTRY) private readonly registry: ProviderRegistry,
    @Inject(EVENT_BUS) private readonly events: EventBus,
    @Inject(CLOCK) private readonly clock: Clock,
    /** 写登记必须走队列（03 §3）—— 否则会与用户手动销毁撞上 I-RA-1。 */
    private readonly resources: ResourceAllocator,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      const report = await this.reconcile();
      if (report.orphaned > 0) {
        this.logger.warn(
          `quota reconcile: released ${String(report.orphaned)} orphaned allocation(s) of ` +
            `${String(report.scanned)} active`,
        );
      }
    } catch (e) {
      // 对账失败绝不拦启动 —— 一个起不来的平台比一份略旧的账本坏得多。
      this.logger.warn(`quota reconcile skipped: ${(e as Error).message}`);
    }
    if (process.env.DISABLE_QUOTA_RECONCILE === '1') return;
    this.timer = setInterval(() => void this.sweep(), INCREMENTAL_INTERVAL_MS);
    // 不为了对账把事件循环吊着（与 `SandboxHealthMonitor` / `AutomationScheduler` 同款）
    this.timer.unref?.();
  }

  /**
   * ⚠️ **关掉定时器，`unref()` 不能替代它**（与 `AutomationScheduler.onModuleDestroy`
   * 记的是同一个坑）：e2e 是 singleFork，几十个 spec 各起一次 AppModule，不清理就会有
   * 几十个指向**已关闭 DB** 的对账器同时醒来。
   */
  onModuleDestroy(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** 定时器的入口：永不抛、不重入。**幂等，可以直接被测试调用**。 */
  async sweep(): Promise<QuotaReconcileReport> {
    const idle: QuotaReconcileReport = { scanned: 0, confirmed: 0, orphaned: 0 };
    if (this.sweeping) return idle;
    this.sweeping = true;
    try {
      return await this.reconcileIncremental();
    } catch (e) {
      this.logger.warn(`incremental quota reconcile failed: ${(e as Error).message}`);
      return idle;
    } finally {
      this.sweeping = false;
    }
  }

  /** 开机那次：全部活跃登记，一条不落。Public so an operator/test can trigger it. */
  async reconcile(): Promise<QuotaReconcileReport> {
    return this.check(await this.allocations.listActive(nodeId()));
  }

  /**
   * 运行期那次：**只挑长时间未更新的**，且单轮有上限（13 §4「避免高频全量扫 provider API」）。
   *
   * 挑法：`now - (上次核对 ?? allocatedAt) >= staleMs`，**最旧的先来**，取前 `batch` 条。
   * 「最旧的先来」不是装饰 —— 按库序取会让排在后面的登记在一台繁忙的机器上永远轮不到。
   */
  async reconcileIncremental(): Promise<QuotaReconcileReport> {
    const now = this.clock.now().getTime();
    const stale = staleMs();
    const due = (await this.allocations.listActive(nodeId()))
      .map((a) => ({ a, since: this.lastCheckedAt.get(a.id) ?? a.allocatedAt.getTime() }))
      .filter(({ since }) => now - since >= stale)
      .sort((x, y) => x.since - y.since)
      .slice(0, batchSize())
      .map(({ a }) => a);
    return this.check(due);
  }

  private async check(allocations: readonly ResourceAllocation[]): Promise<QuotaReconcileReport> {
    const report: QuotaReconcileReport = { scanned: allocations.length, confirmed: 0, orphaned: 0 };
    for (const allocation of allocations) {
      const sandbox = await this.sandboxes.findById(allocation.sandboxId);
      const verdict = await this.verdictFor(sandbox);
      // ⚠️ **`unknown` 不记时刻。** 记了的话，一个 provider 一直不可达的沙箱会被这条
      // 「已核对」推到 30 分钟之后，于是 daemon 恢复后还要再等半小时才有人去看它。
      if (verdict === 'unknown') continue;
      this.lastCheckedAt.set(allocation.id, this.clock.now().getTime());
      if (verdict === 'alive') {
        if (await this.resources.confirmActive(allocation.sandboxId)) report.confirmed += 1;
        continue;
      }
      const released = await this.resources.releaseAsOrphan(allocation.sandboxId, (tx) => {
        if (sandbox === null) return;
        // 17 §76 的消费方是审计（`AuditProjector`）。与释放**同一个事务**，所以
        // 「账本改了但没人知道」这个中间态不存在。
        this.events.publishInTx(tx, [
          new SandboxReconciledAsOrphan(
            sandbox.id,
            sandbox.projectId,
            sandbox.name,
            sandbox.status,
            'container missing on reconcile',
            this.clock.now(),
          ),
        ]);
      });
      if (released) report.orphaned += 1;
    }
    return report;
  }

  private async verdictFor(sandbox: Sandbox | null): Promise<'alive' | 'gone' | 'unknown'> {
    // 沙箱行本身没了（FK CASCADE 之外的路径，或库被手动清过）⇒ 这条登记再也没有主人。
    if (sandbox === null) return 'gone';
    // 已终态：`destroy`/`compensate` 那一步的释放没跑成（崩在中间）。账本补上。
    if (TERMINAL.has(sandbox.status)) return 'gone';
    const handle = handleOf(sandbox);
    // 还没建出实例（`pending`/`scheduling`/`preparing-workspace`）——**不判孤儿**：
    // 进程重启会把它留在那儿，由生命周期链路收，而不是由账本替它决定生死。
    if (handle === null) return 'unknown';
    if (!this.registry.has(sandbox.provider)) return 'unknown';
    try {
      const status = await this.registry.get(sandbox.provider).inspect(handle);
      // 13 §4 的判据是「容器查无」——**只有 `instance_missing` 是查无**（见类注释纪律 ①）。
      return status.lifecycleState === 'instance_missing' ? 'gone' : 'alive';
    } catch (e) {
      this.logger.warn(
        `could not inspect sandbox ${sandbox.id} while reconciling quota ` +
          `(${(e as Error).message}); leaving its allocation untouched`,
      );
      return 'unknown';
    }
  }
}

function handleOf(sandbox: Sandbox): SandboxHandle | null {
  return sandbox.providerSandboxId
    ? {
        provider: sandbox.provider,
        providerSandboxId: sandbox.providerSandboxId,
        providerState: sandbox.providerState ?? undefined,
      }
    : null;
}

function nodeId(): NodeId {
  return (process.env.SCHEDULER_NODE_ID ?? 'local') as NodeId;
}

function staleMs(): number {
  return positive(process.env.QUOTA_RECONCILE_STALE_MS) ?? DEFAULT_STALE_MS;
}

function batchSize(): number {
  return positive(process.env.QUOTA_RECONCILE_BATCH) ?? DEFAULT_BATCH;
}

function positive(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}
