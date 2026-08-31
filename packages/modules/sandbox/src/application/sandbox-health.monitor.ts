import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { CLOCK } from '@platform/shared-kernel';
import type { Clock } from '@platform/shared-kernel';
import { AUDIT_RECORDER, SANDBOX_PROVIDER_REGISTRY, toExecFn } from '@platform/contracts';
import type {
  AuditRecorder,
  SandboxHandle,
  SandboxHealthWire,
  ProviderRegistry,
  SandboxProvider,
  SandboxRuntimeStatus,
} from '@platform/contracts';
import { SANDBOX_REPOSITORY } from '../domain/repositories/sandbox.repository';
import type { SandboxRepository } from '../domain/repositories/sandbox.repository';
import type { Sandbox } from '../domain/entities/sandbox.entity';

/** 常态采样周期（03 §7.8「常态（每 30s）—— 零成本层」）。 */
const SAMPLE_INTERVAL_MS = 30_000;

/**
 * 连续几次**确认失败**才翻转（03 §7.8「连续 N 次失败」）。
 *
 * 3 不是随手挑的：aio 的 8080 探活与 boxlite 的 `info()` 都是亚秒级的单点观测，一次
 * 失败可能只是一次调度抖动；而 30s × 3 ≈ 90s 的确认窗口，仍然远快于 docker 自带
 * HEALTHCHECK 认定 unhealthy 所需的 `Retries 8 × Interval 10s = 80s+`（那条时间上的
 * 硬伤见 `aio-health.ts`）。
 */
const FLIP_AFTER_CONSECUTIVE_FAILURES = 3;

/** 数据面确认那一次 exec 的期限；**远小于**采样周期，否则探测自己会堆积。 */
const DATA_PLANE_PROBE_TIMEOUT_MS = 5_000;

/**
 * ⛔ **探测命令：`/bin/true`，仅此一条。**
 *
 * 03 §7.8 开场那条教训：`probeOnPath` 的 `codex --version` **把整个沙箱的 agent 打挂
 * 了** —— 一次意在「检查」的调用摧毁了被检查的对象（实测：那条命令 70ms 后 HTTP 500，
 * 此后该 box 的 agent 永久挂死）。所以探测**不得**使用任何 runtime CLI，只用
 * `/bin/true` 级别的最小命令。
 */
const DATA_PLANE_PROBE_CMD = ['/bin/true'];

/**
 * `SandboxHealthMonitor` —— 03 §7.8「运行期健康检查」的平台侧。
 *
 * ```
 * 常态（每 30s）    ── 零成本层 ──  aio: 8080 探活(+State.Health 辅助)  boxlite: info() + metrics()
 *                                   ↓ 出现异常迹象
 * 异常确认（按需）  ── 数据面层 ──  一次最小 exec（/bin/true）
 *                                   ↓ 连续 3 次失败
 *                      health.state: healthy → unhealthy + 审计 sandbox.health
 * ```
 *
 * ⚠️ **翻转的是 `health.state`，不是 `status`。** `SANDBOX_STATUSES` 那 12 个取值一个
 * 都没动，沙箱仍然是 `running`。理由三条，见 `sandbox.schema.ts` 里 `HealthStateSchema`
 * 的注释（K8s #7856 枚举不可扩展 / phase 会被读成状态机 / 「`unhealthy` ⇏ agent 不可用」
 * 的信号没资格决定生命周期）。
 *
 * ⚠️ **`sandbox.health` 审计只在翻转时记，不是每 30s 记一条**（03 §7.8）——否则一个
 * 长命沙箱一天就是 2880 条噪音，把审计流冲垮。
 *
 * ⚠️ **健康度不落库。** 它是一个**观测**，不是状态机的一部分：进程重启之后没有观测过
 * 就是没有观测过，`SandboxDto.health` 因此缺席，而缺席的语义恰好是「与今天完全一致」。
 * 把一个上次进程留下的判断读出来当作现在的事实，正是 03 §7.8 要消灭的那种撒谎
 * （「状态字段记的是当时成功过，被当成了现在还成立」）。翻转的历史在审计流里。
 */
@Injectable()
export class SandboxHealthMonitor implements OnApplicationBootstrap {
  private readonly logger = new Logger('SandboxHealthMonitor');
  private readonly current = new Map<string, SandboxHealthWire>();
  /** 平台的抗抖动计数（跨采样）。provider 报的那个是它自己的，两者同形不同源。 */
  private readonly failureStreak = new Map<string, number>();
  /** 上一次采样的 `execErrorsTotal` —— 有意义的是**增长**，不是绝对值。 */
  private readonly lastExecErrors = new Map<string, number>();
  private running = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    @Inject(SANDBOX_REPOSITORY) private readonly repo: SandboxRepository,
    @Inject(SANDBOX_PROVIDER_REGISTRY) private readonly registry: ProviderRegistry,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(AUDIT_RECORDER) private readonly audit: AuditRecorder,
  ) {}

  onApplicationBootstrap(): void {
    if (process.env.DISABLE_SANDBOX_HEALTH_MONITOR === '1') return;
    this.timer = setInterval(() => void this.runOnce(), SAMPLE_INTERVAL_MS);
    this.timer.unref?.();
  }

  /** `SandboxDto.health` 的取数。没观测过 ⇒ `undefined`（缺席 ≠ unhealthy）。 */
  healthOf(sandboxId: string): SandboxHealthWire | undefined {
    return this.current.get(sandboxId);
  }

  /** 一轮采样。幂等，可直接被测试调用。 */
  async runOnce(): Promise<void> {
    if (this.running) return; // 单实例串行：上一轮没跑完时不重入
    this.running = true;
    try {
      const all = await this.repo.findAll();
      // 只探**活着**的：`starting` 还没到能 exec 的地方，终态没有什么可探的（03 §7.8
      // 的场景是「DB 里写着 running、数据面已经挂了」）。
      const live = all.filter((s) => s.status === 'running' || s.status === 'idle');
      const liveIds = new Set(live.map((s) => s.id as string));
      for (const sandbox of live) await this.sample(sandbox);
      // 沙箱没了就把它的观测一起丢掉，别让 map 变成一条只增不减的泄漏
      for (const id of [...this.current.keys()]) if (!liveIds.has(id)) this.forget(id);
      for (const id of [...this.failureStreak.keys()]) if (!liveIds.has(id)) this.forget(id);
    } catch (e) {
      this.logger.warn(`health sweep failed: ${(e as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  private forget(id: string): void {
    this.current.delete(id);
    this.failureStreak.delete(id);
    this.lastExecErrors.delete(id);
  }

  private async sample(sandbox: Sandbox): Promise<void> {
    const id = sandbox.id as string;
    const handle = handleOf(sandbox);
    if (handle === null) return; // 还没有实例，没什么可探的
    let provider: SandboxProvider;
    try {
      provider = this.registry.get(sandbox.provider);
    } catch {
      return; // provider 没注册（第三方被卸了）—— 不是沙箱的健康问题
    }

    // ── 零成本层 ────────────────────────────────────────────────────────────
    let status: SandboxRuntimeStatus | null = null;
    let zeroCostFailure = false;
    let reason = '';
    try {
      status = await provider.inspect(handle);
    } catch (e) {
      // ⚠️ **必须 catch。** 03 §7.8 实现纪律 2：一次探测异常冒泡出去就成了别人的失败。
      zeroCostFailure = true;
      reason = `inspect failed: ${(e as Error).message}`;
    }

    if (status !== null) {
      const signs = this.anomalySigns(id, status);
      zeroCostFailure = signs.length > 0;
      reason = signs.join('; ');
    }

    if (!zeroCostFailure) {
      /**
       * ⚠️ **「没有异常迹象」不等于 `healthy`。**
       *
       * 实测（2026-08-31，真 boxlite 微 VM + `agent-infra/sandbox:latest`）：
       * `info().healthStatus.state === 'None'` —— 这张镜像**根本没配 health check**，
       * 于是零成本层能拿到的正面证据只有「VM 在跑」+「execErrorsTotal 没涨」。拿它写
       * `healthy` 就是在替沙箱担保一件没人问过的事，而 03 §7.8 自己定的语义是
       * 「`healthy` ⇒ agent 可用（**充分条件**）」。
       *
       * ⇒ provider 明确报 `healthy` 才是 `healthy`；否则是 `unknown`（「没问出来」）。
       * 真正挣来 `healthy` 的另一条路是**数据面确认成功**（见下面那一段）——那是这条
       * 链路上唯一能证明「agent 真的能用」的证据。
       */
      const claimed = status?.health?.state === 'healthy';
      // ⚠️ **抗抖动计数在这里清，不在 `record()` 里。** 放进 `record()` 会连同「确认
      // 失败但还没到 N 次」那个中间态一起清掉 —— 而那个中间态的 state 也是 `unknown`
      // （一次失败还不构成「不健康」这个断言），于是计数永远回不到 3，翻转永远不发生。
      this.failureStreak.delete(id);
      this.record(id, sandbox, {
        state: claimed ? 'healthy' : 'unknown',
        lastCheckedAt: this.clock.now().toISOString(),
        message:
          status?.health?.message ??
          'no anomaly signs, but the provider reported no positive health signal',
        consecutiveFailures: 0,
      });
      return;
    }

    // ── 数据面层（按需，一次最小 exec）──────────────────────────────────────
    const confirmed = await this.confirmDataPlane(provider, handle);
    if (confirmed === true) {
      // 零成本层报了异常迹象，但数据面**真的能用** —— 这正是 aio HEALTHCHECK 那种
      // 「比平台的关心面更严格」的信号该有的下场：迹象归迹象，不翻转。
      this.failureStreak.delete(id);
      this.record(id, sandbox, {
        state: 'healthy',
        lastCheckedAt: this.clock.now().toISOString(),
        message: `anomaly sign cleared by data-plane probe (${reason})`,
        consecutiveFailures: 0,
      });
      return;
    }

    const streak = (this.failureStreak.get(id) ?? 0) + 1;
    this.failureStreak.set(id, streak);
    const detail =
      confirmed === undefined
        ? `data-plane probe inconclusive (${reason})`
        : `data-plane probe failed (${reason})`;
    this.record(id, sandbox, {
      // ⚠️ **连续 N 次之前不翻。** 中间态是 `unknown`，不是 `unhealthy`：一次失败
      // 还不构成「不健康」这个断言，少报是降级、多报是撒谎。
      state: streak >= FLIP_AFTER_CONSECUTIVE_FAILURES ? 'unhealthy' : 'unknown',
      lastCheckedAt: this.clock.now().toISOString(),
      message: detail,
      consecutiveFailures: streak,
    });
  }

  /**
   * 零成本层的**异常迹象**（03 §7.8）：
   *  · `info().state.running === false` / provider 报 `unhealthy`
   *  · `lifecycleState` 已经不是 `instance_running`
   *  · `execErrorsTotal` **相对上次采样有增长**（⚠️ 是增长，不是绝对值 —— 绝对值天然
   *    非零，拿它当判据会把一个开机以来出过一次错的健康沙箱判死）
   *  · aio 的 `State.Health` **由 healthy 翻转**（只取翻转，不取绝对值 —— 默认路径下
   *    绝对值天然为 unhealthy，见 `aio-health.ts`），由 provider 折进 `health.message`
   */
  private anomalySigns(id: string, status: SandboxRuntimeStatus): string[] {
    const signs: string[] = [];
    if (status.lifecycleState !== 'instance_running') {
      signs.push(`lifecycleState=${status.lifecycleState}`);
    }
    if (status.health?.state === 'unhealthy') {
      signs.push(status.health.message ?? 'provider reports unhealthy');
    }
    const execErrors = readExecErrors(status);
    if (execErrors !== undefined) {
      const previous = this.lastExecErrors.get(id);
      if (previous !== undefined && execErrors > previous) {
        signs.push(`execErrorsTotal grew ${String(previous)} → ${String(execErrors)}`);
      }
      this.lastExecErrors.set(id, execErrors);
    }
    return signs;
  }

  /**
   * 数据面确认：一次 `/bin/true`。
   *
   * ⚠️ **`exitCode === undefined` 绝不当成功**（03 §7.8 实现纪律 1）。实测中出现过一批
   * `undefined`，健康判定必须显式要求 `=== 0`。
   * ⚠️ **命令不存在会「抛异常」而非返回非零**（实测：`executable '/nope' not found in
   * $PATH`），所以整段 catch —— 否则一次探测异常会冒泡成别人的失败（纪律 2）。
   *
   * 返回：`true` 能用 / `false` 确认不能用 / `undefined` 没问出来。
   */
  private async confirmDataPlane(
    provider: SandboxProvider,
    handle: SandboxHandle,
  ): Promise<boolean | undefined> {
    try {
      const exec = toExecFn(provider, handle);
      const result = await exec(DATA_PLANE_PROBE_CMD, {
        timeoutMs: DATA_PLANE_PROBE_TIMEOUT_MS,
      });
      // ⚠️ **显式要求 `=== 0`。** 「没有退出码」的流在 `toExecFn` 里已经被归一成 `-1`
      // （SP-09），写成 `!== 0` 或 `?? 0` 都会把它读成成功 —— 而实测中真的出现过一批
      // 没有退出码的 exec（03 §7.8 实现纪律 1）。
      return result.exitCode === 0;
    } catch {
      return undefined;
    }
  }

  /**
   * 记录这一次观测；**只有翻转才写审计**（03 §7.8：否则一天 2880 条噪音）。
   *
   * 「翻转」= `state` 与上一次记录的不同。第一次观测到 `healthy` 也不记 —— 那是常态，
   * 而审计要回答的是「**什么时候开始**不健康的」。
   */
  private record(id: string, sandbox: Sandbox, health: SandboxHealthWire): void {
    const previous = this.current.get(id);
    this.current.set(id, health);
    // ⚠️ **第一次观测不记审计，除非它就是 `unhealthy`。** 审计要回答的是「什么时候
    // **开始**不健康的」；每个沙箱开机都写一行「健康度：unknown」就是 03 §7.8 明令
    // 要避免的那种噪音（一天 2880 条会把审计流冲垮）。
    if (previous === undefined && health.state !== 'unhealthy') return;
    if (previous?.state === health.state) return;
    this.audit.record({
      category: 'sandbox',
      type: 'sandbox.health',
      severity: health.state === 'unhealthy' ? 'error' : 'info',
      subjectType: 'sandbox',
      subjectId: id,
      // 03 §7.8 的 actor 清单里就有这个值（`TRIGGERED_BY`）
      actor: 'health-check',
      summary:
        previous === undefined
          ? `健康度：${health.state}（${sandbox.name}）`
          : `健康度翻转 ${previous.state} → ${health.state}（${sandbox.name}）`,
      detail: {
        state: health.state,
        previousState: previous?.state,
        consecutiveFailures: health.consecutiveFailures,
        criterion: health.message,
        // ⚠️ status **没有**变，这一行就是为了让读审计的人不去找一个不存在的状态流转
        status: sandbox.status,
      },
      outcome: health.state === 'unhealthy' ? 'failed' : 'ok',
    });
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

/** boxlite 把它折在 `raw` 里（见 `boxlite-sandbox.provider.ts` 的 `inspect`）。 */
function readExecErrors(status: SandboxRuntimeStatus): number | undefined {
  const raw = status.raw as { execErrorsTotal?: unknown } | undefined;
  return typeof raw?.execErrorsTotal === 'number' ? raw.execErrorsTotal : undefined;
}
