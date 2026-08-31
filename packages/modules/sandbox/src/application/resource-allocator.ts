import { Inject, Injectable, Logger } from '@nestjs/common';
import { CLOCK, ID_GENERATOR, UNIT_OF_WORK } from '@platform/shared-kernel';
import type {
  Clock,
  IdGenerator,
  NodeId,
  SandboxId,
  Tx,
  UnitOfWork,
} from '@platform/shared-kernel';
import { SandboxProviderError, SandboxProviderErrorCode } from '@platform/contracts';
import type { ResourceQuota } from '@platform/contracts';
import { ResourceAllocation } from '../domain/entities/resource-allocation.entity';
import { RESOURCE_ALLOCATION_REPOSITORY } from '../domain/repositories/resource-allocation.repository';
import type { ResourceAllocationRepository } from '../domain/repositories/resource-allocation.repository';
import { HOST_CAPACITY_PROBE } from '../domain/ports/host-capacity.port';
import type { HostCapacityProbe } from '../domain/ports/host-capacity.port';
import { SchedulerQueue } from './scheduler-queue';
import {
  DEFAULT_SCHEDULING_POLICY,
  snapshotOf,
  trySchedule,
} from '../domain/services/resource-pool.domain-service';
import type {
  ResourcePoolSnapshot,
  SchedulingPolicy,
  SchedulingVerdict,
} from '../domain/services/resource-pool.domain-service';

/** 03 §1「空项目取配置下限，默认 512MB」。 */
const DEFAULT_DISK_FLOOR_MB = 512;

/**
 * 03 §3 的**互斥登记** —— 「资源池『读-改-写』（校验剩余容量 → 登记占用）必须在临界区
 * 内完成：`async-mutex` 或 Promise 链式队列，**只把「配额登记/释放」这一小段串行化**」。
 *
 * ─── 为什么这段代码存在 ───────────────────────────────────────────────────────
 * 在它之前，`SandboxProviderErrorCode.RESOURCE_EXHAUSTED` 在全仓**一个 throw 点都没有**：
 * 只有枚举定义、HTTP 映射表、automation 那个 adapter 的 catch，和两个自己造错误的 spec。
 * 于是决策表行 3（03 §8.2「调度决策返回 RESOURCE_EXHAUSTED ⇒ 排队重试」）连同它下面
 * 那一整套 `queueRetry` / `listPendingRetries` / `retry_at` / `(status, retry_at)` 索引 /
 * 「已排队 n/5」全是**死代码**。真实的资源不足走的是另一条路：后台 provision 失败 →
 * sandbox `failed` → `applyOutcome('failed')` → `consecutive_failures++` ⇒ 机器一忙，
 * 一条只是**排队等资源**的规则连撞三次就 `degraded`、十次就被**自动禁用**。
 *
 * ─── 三条不能动的性质 ─────────────────────────────────────────────────────────
 * ① **登记发生在 `create` 同步返回之前。** 这是整件事的关键：`create` 的后半段是
 *   `void provision.runSafely(...)`，容量失败若留在后台，就根本不在 `createSandbox` 的
 *   调用栈上，`AutomationTaskLauncherAdapter` 的 catch 一次都接不到。
 * ② **它只串行化「登记/释放」这一小段。** 慢 IO（拉镜像 190s、起容器、装 CLI 753s）在
 *   临界区**外**跑（03 §3）。把 provision 一起搬进来会让创建 API 卡几分钟。
 * ③ **判定与登记在同一个临界区、同一个事务里。** 分开两步就是把 TOCTOU 从「预检 vs 复制」
 *   挪到「判定 vs 登记」，一个字都没修好。
 *
 * ⚠️ **临界区不在这个类里，在 {@link SchedulerQueue}。** 03 §3 要的是一个**显式的
 * FIFO 队列**（「所有创建/销毁请求先进 `SchedulerQueue`，保证公平性与可预测性」）+
 * 队列深度可观测；上一轮这里直接持有一个 `async-mutex`，行为对但那两件事一件都没有。
 * 现在互斥与排队都由队列提供，本类只负责「判定什么、写什么」。
 */
@Injectable()
export class ResourceAllocator {
  private readonly logger = new Logger('ResourceAllocator');

  constructor(
    @Inject(RESOURCE_ALLOCATION_REPOSITORY)
    private readonly allocations: ResourceAllocationRepository,
    @Inject(HOST_CAPACITY_PROBE) private readonly host: HostCapacityProbe,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
    /** 03 §3 的显式 FIFO —— 互斥、排队与队列深度都归它。 */
    private readonly queue: SchedulerQueue,
  ) {}

  /** 单机恒 `'local'`（13 §2.1.3）；多节点时由部署填。 */
  get nodeId(): NodeId {
    return (process.env.SCHEDULER_NODE_ID ?? 'local') as NodeId;
  }

  /** 03 §1 的下限旋钮 —— 空项目（以及小到没意义的基线）登记多少。 */
  get diskFloorMb(): number {
    return positiveNumber(process.env.SANDBOX_DISK_FLOOR_MB, DEFAULT_DISK_FLOOR_MB);
  }

  get policy(): SchedulingPolicy {
    return {
      safetyMargin: ratio(
        process.env.SCHEDULER_SAFETY_MARGIN,
        DEFAULT_SCHEDULING_POLICY.safetyMargin,
      ),
      cpuOvercommitRatio: positiveNumber(
        process.env.SCHEDULER_CPU_OVERCOMMIT,
        DEFAULT_SCHEDULING_POLICY.cpuOvercommitRatio,
      ),
      // 与工作区复制前那道预检**同一个环境变量**：一台机器上「盘算不算满」只该有一个答案
      // （见 `trySchedule` ② 的注释）。
      minFreeDiskBytes: nonNegativeNumber(
        process.env.WORKSPACE_MIN_FREE_BYTES,
        DEFAULT_SCHEDULING_POLICY.minFreeDiskBytes,
      ),
    };
  }

  /**
   * **互斥区**：校验剩余容量 → 登记占用。容量不够 ⇒ 抛 `RESOURCE_EXHAUSTED`（04 §4 的
   * 那张表把它映射成 HTTP），**什么都没写**。
   *
   * `alsoInTx` 与登记**同一个事务**落库。sandbox 行必须和它一起写：`resource_allocations
   * .sandbox_id` 有 `FK→sandboxes.id`，先写登记会违反外键；而先写 sandbox 行再单独写登记，
   * 则会在容量不足时留下一堆 `pending`/`failed` 的空壳沙箱 —— 自动化排队等资源的那 5 次
   * 重试会变成 5 条假任务。一个事务同时解决这两件事。
   */
  async reserve(
    input: { sandboxId: SandboxId; quota: ResourceQuota },
    alsoInTx?: (tx: Tx) => void,
  ): Promise<ResourceAllocation> {
    return this.queue.submit('create', input.sandboxId, async () => {
      const verdict = await this.evaluate(input.quota);
      if (!verdict.ok) {
        throw new SandboxProviderError(
          SandboxProviderErrorCode.RESOURCE_EXHAUSTED,
          `cannot admit sandbox ${input.sandboxId}: ${verdict.reason}`,
          undefined,
          // retryable: capacity comes back when something else finishes — this is the
          // one 「等一会儿再来」 refusal on the create path, and 03 §8.2 行 3 is built
          // on exactly that reading.
          true,
        );
      }
      const allocation = ResourceAllocation.allocate({
        id: this.ids.next(),
        sandboxId: input.sandboxId,
        nodeId: this.nodeId,
        quota: input.quota,
        now: this.clock.now(),
      });
      this.uow.run((tx) => {
        alsoInTx?.(tx);
        this.allocations.saveSync(tx, allocation);
      });
      return allocation;
    });
  }

  /**
   * 释放（销毁 / provision 失败回滚，03 §640）。**永不抛** —— 释放跑在补偿路径上，
   * 让补偿本身失败只会把一个已经出错的沙箱卡在中间态，而配额留着不放的后果由启动对账
   * 兜底（13 §4）。没有活跃登记 ⇒ 静默 no-op（重复调用是补偿路径的常态）。
   */
  async release(sandboxId: SandboxId): Promise<void> {
    await this.queue.submit('destroy', sandboxId, async () => {
      try {
        const active = await this.allocations.findActiveBySandbox(sandboxId);
        if (active === null) return;
        active.release(this.clock.now());
        this.uow.run((tx) => {
          this.allocations.saveSync(tx, active);
        });
      } catch (e) {
        this.logger.error(
          `failed to release the resource allocation of sandbox ${sandboxId}: ` +
            `${(e as Error).message}. Startup reconciliation (13 §4) will pick it up.`,
        );
      }
    });
  }

  /**
   * 对账路径：**判孤儿 + 释放，一个事务**（13 §4 那一格要求的两件事）。
   *
   * ⚠️ **它也走队列**，与用户手动销毁排同一条线。不排的话，「用户按了销毁」与「对账
   * 判它是孤儿」可能同时改同一行登记 —— 后到的那次撞上 I-RA-1「释放不可回退」抛异常，
   * 而那是一个只在真实并发下出现、日志里只留一行栈的偶发。
   *
   * ⚠️ **登记已经不活跃了就静默 no-op 并返回 `false`**，不是错误：那意味着销毁抢先跑完
   * 了，账本已经是对的。返回值让调用方知道「这次真的判了一个孤儿」——`alsoInTx` 里的
   * 领域事件也只在那一支里发，否则一次竞态会凭空多出一条「对账判定孤儿」的审计。
   *
   * I-RA-3（`orphaned` 只能由对账路径写入）在方法名上成立：全仓只有 `QuotaReconciler`
   * 调得到它。
   */
  async releaseAsOrphan(sandboxId: SandboxId, alsoInTx?: (tx: Tx) => void): Promise<boolean> {
    return this.queue.submit('reconcile', sandboxId, async () => {
      const active = await this.allocations.findActiveBySandbox(sandboxId);
      if (active === null) return false;
      active.markOrphaned();
      active.release(this.clock.now());
      this.uow.run((tx) => {
        this.allocations.saveSync(tx, active);
        alsoInTx?.(tx);
      });
      return true;
    });
  }

  /** 对账路径：实例还在 ⇒ 标 `confirmed`。已经不活跃了就 no-op（同上）。 */
  async confirmActive(sandboxId: SandboxId): Promise<boolean> {
    return this.queue.submit('reconcile', sandboxId, async () => {
      const active = await this.allocations.findActiveBySandbox(sandboxId);
      if (active === null) return false;
      active.confirm();
      this.uow.run((tx) => {
        this.allocations.saveSync(tx, active);
      });
      return true;
    });
  }

  /**
   * **只读**的容量判定 —— 决策表行 3 的产出方（03 §8.2）。
   *
   * ⚠️ **它不登记，因此它不是闸。** 唯一的闸是 {@link reserve}：这里回答 `ok` 之后到真正
   * 创建之间，别人完全可能把最后一格用掉。它存在是为了让 automation 在**还没创建任何东西**
   * 的时候就能把这一发记成「排队重试」而不是「失败一次」——判错的代价是多走一次 create
   * 然后被 `reserve` 拒（结果一样），而不是超分配。
   */
  async probe(quota: ResourceQuota): Promise<SchedulingVerdict> {
    // ⚠️ **它不进队列**，尽管上一轮它是持锁的。两个理由：① 它是纯读，没有可被打断的
    // 读-改-写；② 队列深度这个数字的意思是「有多少**创建/销毁**请求卡在调度上」，
    // 把自动化每分钟一次的只读探测算进去，那个数字就开始撒谎 —— 而它存在的全部理由
    // 就是被人读。代价是探测可能读到一个正在被改的池子，而那正是它「不是闸」的含义。
    return this.evaluate(quota);
  }

  /** 这条 sandbox 当前登记了多少 —— provision 拿它去建实例，账本与实参因此不会分叉。 */
  async reservedQuotaOf(sandboxId: SandboxId): Promise<ResourceQuota | null> {
    const active = await this.allocations.findActiveBySandbox(sandboxId);
    return active?.quota ?? null;
  }

  /** 当前资源池视图（治理展示 / 对账 / 测试）。 */
  async snapshot(): Promise<ResourcePoolSnapshot> {
    const [active, host] = await Promise.all([
      this.allocations.listActive(this.nodeId),
      this.host.capacity(),
    ]);
    return snapshotOf(
      active.map((a) => a.quota),
      host,
      this.policy,
    );
  }

  /**
   * 读-判定的那一半。**调用方必须已经持有 mutex** —— 它单独存在只是为了让 `reserve`
   * 与 `probe` 共用同一段判据（两份会分头漂移，而漂移的方向一定是「probe 说行、reserve
   * 说不行」这种查不出来的样子）。
   */
  private async evaluate(quota: ResourceQuota): Promise<SchedulingVerdict> {
    const [active, host] = await Promise.all([
      this.allocations.listActive(this.nodeId),
      this.host.capacity(),
    ]);
    const policy = this.policy;
    const pool = snapshotOf(
      active.map((a) => a.quota),
      host,
      policy,
    );
    return trySchedule(quota, pool, host.diskAvailableBytes, policy);
  }
}

function positiveNumber(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function nonNegativeNumber(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** 安全余量是个比例：`[0,1)`。1 会让池子恒为 0，负数会让它凭空变大。 */
function ratio(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && n < 1 ? n : fallback;
}
