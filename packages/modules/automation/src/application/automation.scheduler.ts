import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { Mutex } from 'async-mutex';
import { CLOCK, EVENT_BUS, ID_GENERATOR, UNIT_OF_WORK } from '@platform/shared-kernel';
import type { Clock, EventBus, IdGenerator, UnitOfWork } from '@platform/shared-kernel';
import {
  AUDIT_RECORDER,
  AUTOMATION_TASK_LAUNCHER,
  AutomationResourceExhausted,
  RUNTIME_CREDENTIAL_STATE_READER,
  isCapacityFailureCode,
} from '@platform/contracts';
import type {
  AuditRecorder,
  AutomationTaskLaunchInput,
  AutomationTaskLauncher,
  RuntimeCredentialStateReader,
} from '@platform/contracts';
import { Automation } from '../domain/entities/automation.entity';
import type { AutomationOutcome } from '../domain/entities/automation.entity';
import { AutomationRun } from '../domain/entities/automation-run.entity';
import { AUTOMATION_REPOSITORY } from '../domain/repositories/automation.repository';
import type { AutomationRepository } from '../domain/repositories/automation.repository';
import { AUTOMATION_RUN_REPOSITORY } from '../domain/repositories/automation-run.repository';
import type { AutomationRunRepository } from '../domain/repositories/automation-run.repository';
import { TriggerDecisionService } from '../domain/services/trigger-decision.domain-service';
import { DEFAULT_MISSED_THRESHOLD_MIN, RetryPolicy } from '../domain/value-objects/policies.vo';
import type { TimeoutMinutes } from '../domain/value-objects/policies.vo';
import { AutomationRunFinished, AutomationTriggered } from '../domain/events/automation-events';
import { AutomationNotifier } from './automation.notifier';

/** 03 §8.1：**每分钟**扫一轮。 */
export const SWEEP_INTERVAL_MS = 60_000;

/** 一轮最多补扫多少条 outcome-pending 孤儿 —— 防止一次大规模崩溃把单轮撑爆。 */
const OUTCOME_PENDING_BATCH = 100;

/**
 * 同一条坏 item **连续**失败时，`warn` 的复述间隔（单位：轮）。60 轮 ≈ 1 小时。
 * 取舍写在 {@link AutomationScheduler.noteSkipped} 上。
 */
const SKIP_WARN_REPEAT_SWEEPS = 60;

/** `runOnce` 的三个阶段 —— 每个各自兜底，一个挂了不带走后面的（见 `runStage`）。 */
type SweepStage = 'apply-pending-outcomes' | 'advance-in-flight' | 'fire-due';

/** 阶段**内部**逐条隔离时，被跳过的那一条属于哪个循环（见 `noteSkipped`）。 */
type SkipScope = 'outcome-pending' | 'retry-due' | 'in-flight' | 'fire-due';

/** 一条 item 连续失败的账本项。`lastSweep` 只用来把「已经不失败了」的条目清掉。 */
interface SkipStreak {
  readonly message: string;
  readonly sweeps: number;
  readonly lastSweep: number;
}

/**
 * `AutomationScheduler`（03 §8.1，逐条实现）。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ① **每分钟**扫 `enabled = true AND next_trigger_at <= now`（走
 *    `(enabled, next_trigger_at)` 复合索引）。
 * ② **单实例串行**：整个扫描批次在**一个 `async-mutex` 内**跑完，防止上一轮未结束
 *    时下一轮重入（单机单进程前提；多节点时改 DB 行级锁 + `claimed_by`，11 §4）。
 * ③ **先推进 `next_trigger_at` 后执行**（I-AUT-8）。
 * ④ **outcome-pending 孤儿 run 补扫**（交叉评审 P2-7）。
 * ⑤ **时区只读规则自己的 `automations.timezone`**（I-AUT-9）——这一条在
 *    `Schedule` 值对象里落地，调度器这一层**一次都不碰系统时区**：本文件里没有任何
 *    地方读 `TZ`、`Intl.DateTimeFormat().resolvedOptions().timeZone` 或
 *    `getTimezoneOffset()`；所有「下一次是什么时候」都来自 `automation.computeNextTrigger`。
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ⚠️ **为什么用 `tryAcquire` 语义而不是排队**：`async-mutex` 默认会把第二个调用者
 * **排队**等前一个跑完；对一个每分钟一次的定时器，排队意味着一轮跑了 90 秒之后
 * 立刻再跑一轮，越积越多。这里要的是「上一轮还没完就直接跳过这一轮」——所以先
 * `isLocked()` 再 `runExclusive()`。两句之间没有 `await`，而 `async-mutex` 的锁是在
 * `acquire()` 里**同步**占住的，所以这中间不存在可插入的时机（25 T-AUT-42）。
 */
@Injectable()
export class AutomationScheduler implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('AutomationScheduler');
  private readonly mutex = new Mutex();
  private timer: NodeJS.Timeout | null = null;
  /** 单调递增的轮次号。**只用来数轮，不用来读时间** —— 与 `clock` 无关，测试里可确定复现。 */
  private sweepSeq = 0;
  /** `scope:id` → 连续失败账本。只保留**这一轮还在失败**的条目（`forgetHealedSkips`）。 */
  private readonly skipStreaks = new Map<string, SkipStreak>();

  constructor(
    @Inject(AUTOMATION_REPOSITORY) private readonly rules: AutomationRepository,
    @Inject(AUTOMATION_RUN_REPOSITORY) private readonly runs: AutomationRunRepository,
    @Inject(AUTOMATION_TASK_LAUNCHER) private readonly launcher: AutomationTaskLauncher,
    @Inject(RUNTIME_CREDENTIAL_STATE_READER)
    private readonly credentials: RuntimeCredentialStateReader,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(EVENT_BUS) private readonly events: EventBus,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
    @Inject(AUDIT_RECORDER) private readonly audit: AuditRecorder,
    private readonly notifier: AutomationNotifier,
  ) {}

  onApplicationBootstrap(): void {
    if (process.env.DISABLE_AUTOMATION_SCHEDULER === '1') return;
    this.timer = setInterval(() => void this.runOnce(), SWEEP_INTERVAL_MS);
    // 不为了调度器把事件循环吊着（与 `VolumeReaper` / `CredentialRefreshScanner` 同款）
    this.timer.unref?.();
  }

  /**
   * ⚠️ **关掉定时器，`unref()` 不能替代它。** `unref()` 只保证「它不会拖住进程退出」，
   * 不保证「app.close() 之后它不再跑」—— 而 e2e 是 singleFork：35 个 spec 各起一次
   * AppModule，若不清理，跑到第 5 分钟时会有几十个指向**已关闭 DB** 的调度器同时醒来。
   * 它们会被 `runOnce` 的 try/catch 兜住，但那是一屏与本次失败无关的红色日志。
   */
  onModuleDestroy(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * 一轮扫描。**幂等，可以直接被测试调用**。
   *
   * 返回这一轮真正「动了」的条数（触发 + 推进 + 补扫），供日志与测试断言。
   * 上一轮还在跑 ⇒ **立即返回 0**（T-AUT-42），不排队。
   *
   * ─────────────────────────────────────────────────────────────────────────
   * ⭐ **三个阶段各自兜底，阶段内还要逐条兜底。**
   *
   * 这里曾经只有**一个总 try/catch**，于是三个阶段的异常粒度是不对称的：`fireDue` 自己
   * 做对了（per-rule try/catch，一条规则挂了不影响其余），前两个没有 —— 任何一条坏 run、
   * 任何一次跨模块调用失败（`launcher.phaseOf` 撞上 provider 不可达）都会把**它后面的
   * 阶段一起带走**，这一分钟所有规则都不跑，外部只看到一行 `automation sweep failed`。
   *
   * ⚠️ 最要命的是**顺序**：排在第一个的 `applyPendingOutcomes` 处理的恰恰是「上一轮崩溃
   * 留下的残局」—— 最容易坏的数据放在了最脆弱的位置。坏到每轮都抛的话（真实先例：
   * `automations.timezone` 是一个解不出来的 IANA 名，`findById` 里的 `toDomain` 每次都炸，
   * 而 `hydrateAll` 的逐行隔离**只护住 list 取数、护不住 `findById`**），调度器会每分钟
   * 都挂在第一步，**所有规则永久停摆**。
   *
   * ⇒ 修法是把仓储层早就立好的那条纪律（`hydrateAll`：坏行逐条跳过 + 逐条带 id log）
   * 推到应用层，与 `fireDue` 对称。**两层**：
   *   · `runStage`   —— 阶段级：取数本身抛（`.map(toDomain)` 在循环之外）时兜住；
   *   · `noteSkipped` —— 条目级：一条坏数据跳过它自己，同一轮里后面的照常跑。
   *
   * ⚠️ **被跳过的那条不计入 `touched`。** `touched` 的语义是「这一轮真的动了多少东西」，
   * 上层拿它判断有没有活干；把失败算进去就是拿「没干成」冒充「干了」。`fireDue` 一直是
   * 这么算的（`fired += 1` 在 `await fireOne()` **之后**），另外两个照它对齐 —— 结构上让
   * `+= 1` 待在 try 的末尾，抛了就到不了，而不是靠人记得别加。
   * ─────────────────────────────────────────────────────────────────────────
   */
  async runOnce(): Promise<number> {
    if (this.mutex.isLocked()) return 0;
    return this.mutex.runExclusive(async () => {
      this.sweepSeq += 1;
      let touched = 0;
      touched += await this.runStage('apply-pending-outcomes', () => this.applyPendingOutcomes());
      touched += await this.runStage('advance-in-flight', () => this.advanceInFlight());
      touched += await this.runStage('fire-due', () => this.fireDue());
      this.forgetHealedSkips();
      return touched;
    });
  }

  /**
   * 跑一个阶段，**它挂了不许带走后面的阶段**：下一分钟还会来，但这一分钟的规则得照常触发。
   *
   * ⚠️ 它与 `noteSkipped` 管的不是同一件事。逐条隔离管「一条数据坏了」；这一层管**取数
   * 本身**抛 —— `listActive()` / `listOutcomePending()` / `listPendingRetries()` 走的都是
   * 裸 `.map(toDomain)`（`automation_runs` 侧还没有 `hydrateAll` 那样的逐行隔离），一行坏
   * 的 run 会让整批取数抛在**循环之外**，条目级 try/catch 根本没机会执行。那一刻仍然要
   * 保证 `fireDue()` 跑得起来：**规则不触发是这条链路上最贵的失败**。
   */
  private async runStage(stage: SweepStage, body: () => Promise<number>): Promise<number> {
    try {
      return await body();
    } catch (e) {
      // ⚠️ 保留 `automation sweep failed` 这个子串：既有的日志检索按它匹配。
      this.logger.error(`automation sweep failed at stage '${stage}': ${reason(e)}`);
      return 0;
    }
  }

  /**
   * 一条 item 被跳过时留下的**痕迹**。四个循环共用一份 —— 两套日志形态没有理由。
   *
   * ⛔ **不许吞成静默。** 这是 `hydrateAll` 那条注释的原话：坏行不静默吞掉、每条单独 log
   * 一次、带上 id，否则「这条规则怎么不跑了」又变成一个查不出来的问题。
   *
   * ⚠️ **但也不许刷屏。** 一条坏到每轮都抛的数据一分钟来一次：
   *   · 每轮都 `warn` ⇒ 一天 1440 行同一句话，真正的新问题淹在里面；
   *   · 只在第一次 `warn` ⇒ 进程刚起时闪一行，之后永远安静 —— 半夜才开始翻日志的人什么
   *     都看不到，等于回到了「查不出来」。
   * ⇒ 取的是中间：**首次 warn + 每 60 轮（≈1h）复述一次 + 中间降到 debug**。warn 这一档
   *   永远有心跳、量是每小时一行；把 debug 打开就有完整的逐轮记录。失败原因**变了**立刻
   *   重新 warn —— 换了个错法是新信息，不该被上一次的冷却期盖住。
   */
  private noteSkipped(scope: SkipScope, id: string, e: unknown): void {
    const message = reason(e);
    const key = `${scope}:${id}`;
    const previous = this.skipStreaks.get(key);
    const sweeps = previous !== undefined && previous.message === message ? previous.sweeps + 1 : 1;
    this.skipStreaks.set(key, { message, sweeps, lastSweep: this.sweepSeq });
    const line = `automation sweep skipped ${scope} ${id}: ${message}`;
    if (sweeps === 1) {
      this.logger.warn(line);
    } else if (sweeps % SKIP_WARN_REPEAT_SWEEPS === 0) {
      this.logger.warn(`${line}（已连续 ${String(sweeps)} 轮跳过它）`);
    } else {
      this.logger.debug(line);
    }
  }

  /**
   * 这一轮没再失败的条目丢掉。两个理由，缺一不可：
   *   ① 账本不许**只增不减** —— 与 `SandboxHealthMonitor.forget()` 同款纪律，否则它就是
   *      一条随进程寿命增长的泄漏；清完之后大小被这一轮的批量上限夹住。
   *   ② 中间恢复过一轮的，下次失败要**重新算作第一次**：那是一次新的失败，不是同一次的
   *      延续，值一条 warn。
   */
  private forgetHealedSkips(): void {
    for (const [key, streak] of this.skipStreaks) {
      if (streak.lastSweep !== this.sweepSeq) this.skipStreaks.delete(key);
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // ④ outcome-pending 孤儿补扫（03 §8.1）
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * run 已 `finalize`（终态写入）但 `Automation.recordOutcome()` 尚未生效时崩溃 ——
   * 只按 `next_trigger_at` 扫规则**发现不了**它，会漏记一次失败计数。
   *
   * ⚠️ **幂等**靠 `outcome_applied`：补调之后置 true，下一轮就扫不到了。它与正常路径
   * 走的是同一段代码（`applyOutcome`），所以「补扫」和「当场记」不会给出两个不同的
   * 失败计数 —— 那种分叉正是这类补偿逻辑最常见的失败方式。
   */
  private async applyPendingOutcomes(): Promise<number> {
    const orphans = await this.runs.listOutcomePending(OUTCOME_PENDING_BATCH);
    let applied = 0;
    for (const run of orphans) {
      try {
        const automation = await this.rules.findById(run.automationId);
        if (automation === null) {
          // 规则已被删（run 也会随 CASCADE 走，这里是竞态窗口里的残影）——标掉即可。
          run.markOutcomeApplied();
          this.uow.run((tx) => {
            this.runs.saveSync(tx, run);
          });
          continue;
        }
        this.applyOutcome(automation, run, run.status as AutomationOutcome);
        applied += 1;
      } catch (e) {
        // ⚠️ 跳过它 = **留到下一轮**，不丢账：`outcome_applied` 保持 false，下一轮照样扫得
        // 到，而补扫本来就是幂等的补偿路径。这里最常见的抛法是 `findById` 水化那条规则时
        // 炸（坏 `timezone` / 坏 `schedule_config`）—— 那条规则自己也活不了，但它没有理由
        // 顺手带走同一轮里其余的孤儿 run 和**后面两个阶段**。
        this.noteSkipped('outcome-pending', run.id, e);
      }
    }
    if (applied > 0) {
      this.logger.warn(`recovered ${String(applied)} outcome-pending automation run(s)`);
    }
    return applied;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 在飞的 run：provisioning → ready → running → finished
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * 推进所有**非终态**的 run。
   *
   * ⚠️ 这一段的存在理由：`headless:true` 的沙箱不会自己起 agent 会话（T-4 的定案），
   * 而起 Task 又要求沙箱已经 `running`，中间是分钟级的等待。把它做成「每轮看一眼相位」
   * 而不是「创建时 await 到底」，好处是整条链路的状态全在库里 —— 进程在 provision
   * 中途重启，下一轮照样接着走。
   *
   * 顺带处理决策表行 3 的**重试到点**（`status='resource-exhausted' AND retry_at <= now`）。
   */
  private async advanceInFlight(): Promise<number> {
    const now = this.clock.now();
    let touched = 0;

    // ① 资源重试到点的（同一行 run，I-AUR-2）
    for (const run of await this.runs.listPendingRetries(now)) {
      try {
        const automation = await this.rules.findById(run.automationId);
        if (automation === null) continue;
        touched += (await this.tryStartSandbox(automation, run)) ? 1 : 0;
      } catch (e) {
        this.noteSkipped('retry-due', run.id, e);
      }
    }

    // ② provisioning / ready / running
    for (const run of await this.inFlightRuns()) {
      try {
        touched += await this.advanceOne(run);
      } catch (e) {
        this.noteSkipped('in-flight', run.id, e);
      }
    }
    return touched;
  }

  /**
   * 推进**一条**在飞 run。⭐ 隔离粒度就到这一层：**一条 run 一个 try/catch**，不再往里细分。
   *
   * ⚠️ 为什么不按子步骤各兜各的（`phaseOf` → `startTaskOn` → `summarize` → `applyOutcome`
   * 是好几步）：那样会造出**半途而废**的状态，而半途而废比整条跳过更糟 —— 典型是「沙箱起
   * 来了、run 上没记」。这里每条 run 的形状都是「读状态 → 判断 → **一次**事务写」，两种
   * 断点都不需要补偿代码：
   *   · 写之前抛 ⇒ 库里什么都没变，下一轮从同一个起点重来（相位是 provider 那边的事实，
   *     重问一次得到的还是它）；
   *   · 写之后抛 ⇒ 那一步已经落库，下一轮从新状态接着走。
   *
   * ⛔ 唯一不在事务里的副作用是 `createSandbox`（外部资源），它在**另一个**循环里，且早就
   * 被 `tryStartSandbox` 自己的 try/catch 包着 —— 不归这一层管。
   *
   * `notifier.summarize()` 也不必单独兜：它自己吞掉读日志的失败并回 `undefined`（摘要读不
   * 到不该让一条 run 落不了终态）。
   */
  private async advanceOne(run: AutomationRun): Promise<number> {
    const sandboxId = run.sandboxId;
    // 拿 `null` 去问 provider 相位是一次必然失败的调用；这条 run 还在等沙箱，
    // 它的下一步是**创建**而不是**推进**。
    if (sandboxId === null) return 0;
    const phase = await this.launcher.phaseOf(sandboxId);
    switch (phase.kind) {
      case 'provisioning':
      case 'running':
        return 0;
      case 'ready': {
        const automation = await this.rules.findById(run.automationId);
        if (automation === null) return 0;
        await this.startTaskOn(automation, run);
        return 1;
      }
      case 'finished': {
        const automation = await this.rules.findById(run.automationId);
        if (automation === null) return 0;
        // ★ 决策表行 3 的**另一半**（03 §8.2）：沙箱是建出来了，但它死在「没资源」上
        // （典型：工作区复制时磁盘写满 ⇒ `DISK_INSUFFICIENT`）。这**不是**规则失败，
        // 与创建那一刻被互斥区拒完全同源，所以走同一段记账 —— 排队重试、不计失败。
        //
        // ⚠️ 判据是**码**不是文案。`errorMessage` 是给人看的自由文本，靠它做分支就是
        // 把一条领域判定挂在一句随时会被改写的句子上。
        if (phase.status === 'failed' && isCapacityFailureCode(phase.errorCode)) {
          this.queueOrGiveUp(automation, run);
          return 1;
        }
        if (run.status === 'pending') run.markRunning(sandboxId, this.clock.now());
        const finishedAt = this.clock.now();
        if (phase.logPath !== undefined) {
          run.attachLog(phase.logPath, Math.min(phase.logBytes ?? 0, LOG_CEILING));
        }
        run.finalize(phase.status, finishedAt, {
          ...(phase.errorMessage !== undefined ? { errorMessage: phase.errorMessage } : {}),
          outputSummary: await this.notifier.summarize(run.logPath),
        });
        this.applyOutcome(automation, run, phase.status);
        this.notify(this.notifier.afterRunFinished(automation, run));
        return 1;
      }
      case 'gone': {
        const automation = await this.rules.findById(run.automationId);
        if (automation === null) return 0;
        if (run.status === 'pending') run.markRunning(sandboxId, this.clock.now());
        run.finalize('failed', this.clock.now(), {
          errorMessage: 'the sandbox backing this run no longer exists',
        });
        this.applyOutcome(automation, run, 'failed');
        this.notify(this.notifier.afterRunFinished(automation, run));
        return 1;
      }
    }
  }

  /**
   * 在飞 = `pending`（等沙箱）或 `running`（Task 在跑）。
   *
   * ⚠️ **必须按状态直接查，不能「每条规则取最新一条 run」。** 后者是这一版写过的一个
   * 真 bug：10:00 触发、还在跑的 run A，会在 11:00 那一轮被一条
   * `skipped/PREVIOUS_RUNNING` 的 run B 盖住 —— `findLatest` 拿到终态的 B，于是 A 再也
   * 没人推进，永远停在 `running`；而 `PREVIOUS_RUNNING` 的判据又正是「上一条非终态」，
   * 这条规则从此**永远跳过**。一个静默死锁，靠日志看不出来。
   *
   * `resource-exhausted` 不在这里 —— 它由 `listPendingRetries` 按 `retry_at` 单独捞。
   */
  private inFlightRuns(): Promise<AutomationRun[]> {
    return this.runs.listActive();
  }

  // ───────────────────────────────────────────────────────────────────────────
  // ①③ 到期规则：先推进、后执行
  // ───────────────────────────────────────────────────────────────────────────

  private async fireDue(): Promise<number> {
    const now = this.clock.now();
    const due = await this.rules.listDue(now);
    let fired = 0;
    for (const automation of due) {
      try {
        await this.fireOne(automation, now);
        fired += 1;
      } catch (e) {
        // 一条规则出问题不该带走整批 —— 它的 `next_trigger_at` 已经推进过了
        // （I-AUT-8），所以下一轮不会把它反复触发。
        //
        // ⚠️ 这条 catch 是本文件里**最早写对的那一个**，另外三个循环是照它补齐的；日志出口
        // 也一并收编进 `noteSkipped`（同一件事没有理由有两套形态、两套刷屏策略）。
        this.noteSkipped('fire-due', automation.id, e);
      }
    }
    return fired;
  }

  private async fireOne(automation: Automation, now: Date): Promise<void> {
    const previousRun = await this.runs.findLatest(automation.id);
    const previousTaskActive = await this.isPreviousStillGoing(previousRun);

    const decision = TriggerDecisionService.decide({
      automation,
      previousRun,
      previousTaskActive,
      credentialState: await this.credentials.stateOf(automation.runtimeId),
      // 03 §8.2 行 3 的**真实产出方**（S? 本切片）。此前这里恒传 `'ok'`，理由是
      // 「`resource_allocations` 未建、互斥登记未落地，没有真实产出方」—— 那条注释
      // 曾经是对的，现在不是了：`SandboxApplicationService.hasCapacityFor` 走的就是
      // 创建门那份 quota + 资源池账本。
      //
      // ⚠️ **它只是「先问一句」，不是闸。** 真正拦住超分配的是创建那一刻的互斥登记；
      // 这一问的价值在于：容量不够时**一行 sandbox 都不建**就把这一发记成「排队重试」，
      // 而不是建出来、失败、再记一次失败（I-AUT-1：资源不足不是规则的错）。
      schedulingDecision: await this.launcher.capacityFor(launchInput(automation)),
      now,
      missedThresholdMin: missedThresholdMin(),
    });

    // ★★★ I-AUT-8：**先推进 `next_trigger_at`，再执行。** ★★★
    //
    // 这一行必须在下面任何一次 `launcher.*` 调用**之前**落库。顺序反过来的后果不是
    // 「慢一点」：`createSandbox` 抛异常、进程在那一刻被 kill、甚至只是 DB 写超时，
    // 都会让这条规则的 `next_trigger_at` 停在过去，于是**每一轮扫描都会再触发一次**
    // —— 一分钟一发，直到有人发现。
    automation.advanceTrigger(now);
    this.uow.run((tx) => {
      this.rules.saveSync(tx, automation);
    });

    switch (decision.kind) {
      case 'missed': {
        // 记 `missed`、**不补跑**、`next_trigger_at` 已经推进到下一个未来时刻。
        const run = AutomationRun.missed(
          this.ids.next(),
          automation.id,
          `missed: next_trigger_at was more than ${String(missedThresholdMin())} minutes overdue`,
          now,
        );
        this.persistRun(run);
        this.logger.warn(`automation ${automation.id} missed a slot (downtime); not catching up`);
        return;
      }
      case 'skip': {
        const run = AutomationRun.skipped(
          this.ids.next(),
          automation.id,
          decision.reason,
          decision.reason === 'PREVIOUS_RUNNING'
            ? 'the previous run has not reached a terminal state yet'
            : `runtime '${automation.runtimeId}' has no usable credential`,
          now,
        );
        this.persistRun(run);
        // 03 §8.2 行 2：凭证过期要**发 webhook**（横幅由前端拉 REST 得到）。
        if (decision.reason === 'AUTH_EXPIRED') {
          this.notify(this.notifier.afterAuthExpired(automation, run));
        }
        return;
      }
      case 'retry': {
        // 行 3：资源不足 ⇒ 落一条 run 并**直接排队**（`resource-exhausted` + `retry_at`），
        // ⛔ **不调 `createSandbox`**。调了就是明知会被互斥区拒还要去撞一次，而那次撞击
        // 会在任务列表里留下痕迹（审计一条 provision 失败），历史上也说不清「已排队 n/5」
        // 里的 n 是怎么来的。`listPendingRetries` 会在 `retry_at` 到点时接手。
        const run = this.openRun(automation, now);
        run.queueRetry(now);
        this.persistRun(run);
        return;
      }
      case 'fail': {
        // 行 3 的尽头：5 次仍无资源 ⇒ 终态 `failed`。**这一次才计入失败计数**
        // （03 §8.4：failed 累加）—— 两小时窗口里一直没有资源，已经不是「稍等一下」了。
        const run = this.openRun(automation, now);
        run.finalize('failed', this.clock.now(), {
          errorCode: 'RESOURCE_EXHAUSTED',
          errorMessage: `no capacity after ${String(RetryPolicy.MAX_ATTEMPTS)} queued retries`,
        });
        this.applyOutcome(automation, run, 'failed');
        this.notify(this.notifier.afterRunFinished(automation, run));
        return;
      }
      case 'trigger': {
        const run = this.openRun(automation, now);
        await this.tryStartSandbox(automation, run);
        return;
      }
    }
  }

  /**
   * 落一条新的 `pending` run + 推进 `last_triggered_at` + 发 `AutomationTriggered`。
   *
   * 行 3（retry / fail）与行 4（trigger）**共用**它：三条都算「这一发触发了」，历史里
   * 都该有一条记录，区别只在这条记录接下来变成什么。抽出来是因为它们此前写在同一个
   * `case` 里，而把 retry/fail 分出去时最容易漏掉的就是这半段（少发一条
   * `AutomationTriggered`，前端的「刚刚触发」提示就对着一条不存在的 run）。
   */
  private openRun(automation: Automation, now: Date): AutomationRun {
    const run = AutomationRun.pending(this.ids.next(), automation.id, now);
    automation.markTriggered(now);
    this.uow.run((tx) => {
      this.rules.saveSync(tx, automation);
      this.runs.saveSync(tx, run);
      this.events.publishInTx(tx, [
        new AutomationTriggered(automation.id, automation.name, automation.projectId, run.id, now),
      ]);
    });
    return run;
  }

  /**
   * 决策表行 1 的判据（03 §8.2）：**上次触发的 Task 仍在非终态吗**。
   *
   * ⚠️ 三种情况要分清：
   *   · run 已终态                       ⇒ false（最常见）
   *   · run 非终态但**还没有 sandbox**    ⇒ true —— 这一发确实还在进行中（刚触发、
   *     沙箱都还没建起来），此时再起一发就是并发，而 MVP 的并发档是 `skip`
   *   · run 非终态且有 sandbox            ⇒ 问相位；`gone`/`finished` 都不算「还在跑」
   *
   * 中间那条曾经是最容易写漏的：把「没有 sandboxId」当成 false，会让一条每小时的规则
   * 在沙箱冷启动的那 4 分钟里被再触发一次。
   */
  private async isPreviousStillGoing(previousRun: AutomationRun | null): Promise<boolean> {
    if (previousRun === null || previousRun.isTerminal) return false;
    if (previousRun.sandboxId === null) return true;
    const phase = await this.launcher.phaseOf(previousRun.sandboxId);
    return phase.kind !== 'gone' && phase.kind !== 'finished';
  }

  /**
   * 决策表行 4 第一步 + 行 3 的 catch。
   *
   * 资源不足 ⇒ **更新同一行 run** 的 `retry_count`/`retry_at`（I-AUR-2），5 次仍失败
   * 转终态 `failed`（`error_code='RESOURCE_EXHAUSTED'`）。
   */
  private async tryStartSandbox(automation: Automation, run: AutomationRun): Promise<boolean> {
    const input = launchInput(automation);
    try {
      const { sandboxId } = await this.launcher.createSandbox(input);
      run.markRunning(sandboxId, this.clock.now());
      // markRunning 把它推到 `running`，但 Task 还没 POST —— 相位机在下一轮把它接走。
      this.persistRun(run);
      return true;
    } catch (e) {
      if (!(e instanceof AutomationResourceExhausted)) {
        run.finalize('failed', this.clock.now(), { errorMessage: (e as Error).message });
        this.applyOutcome(automation, run, 'failed');
        this.notify(this.notifier.afterRunFinished(automation, run));
        return true;
      }
      this.queueOrGiveUp(automation, run);
      return true;
    }
  }

  /**
   * 决策表行 3 的**记账**那一半，两条路径共用（这是它抽出来的全部理由）：
   *
   *   · **同步路径** —— `createSandbox` 那一刻互斥登记拒了（`AutomationResourceExhausted`）；
   *   · **后台路径** —— 沙箱已经建出来了，但 provision 阶段撞上容量（工作区复制时磁盘
   *     写满 ⇒ `DISK_INSUFFICIENT`），由相位机带着 `errorCode` 回来。
   *
   * ⚠️ **后台那一条此前一律走「记一次失败」**，于是 `consecutive_failures++`：机器一忙、
   * 盘一紧，连撞三次就 `degraded`、十次就**自动禁用** —— 而 I-AUT-1 明说资源不足不是规则
   * 的错。修一半等于没修，两条都必须落在这里。
   *
   * 只有 5 次都排完仍无资源才转终态 `failed`（那一次才计入失败计数，03 §8.4）。
   */
  private queueOrGiveUp(automation: Automation, run: AutomationRun): void {
    if (!RetryPolicy.canRetry(run.retryCount)) {
      run.finalize('failed', this.clock.now(), {
        errorCode: 'RESOURCE_EXHAUSTED',
        errorMessage:
          `no capacity after ${String(RetryPolicy.MAX_ATTEMPTS)} queued retries ` +
          `(${String(RetryPolicy.INTERVAL_MS / 60_000)}min apart)`,
      });
      this.applyOutcome(automation, run, 'failed');
      this.notify(this.notifier.afterRunFinished(automation, run));
      return;
    }
    run.queueRetry(this.clock.now());
    this.persistRun(run);
  }

  private async startTaskOn(automation: Automation, run: AutomationRun): Promise<void> {
    if (run.sandboxId === null) return;
    try {
      await this.launcher.startTask(run.sandboxId, launchInput(automation));
    } catch (e) {
      run.finalize('failed', this.clock.now(), { errorMessage: (e as Error).message });
      this.applyOutcome(automation, run, 'failed');
      this.notify(this.notifier.afterRunFinished(automation, run));
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 共用写路径
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * 终态 run → `Automation.recordOutcome()` → 两者**同一个事务**落库。
   *
   * ★ 「同一个事务」是 `outcome_applied` 这一列存在的意义所在：run 的终态与规则的
   * 失败计数在这里一起提交，中间崩溃则两者一起回滚；只有**这个事务提交了、后面某步
   * 崩了**的窗口才需要补扫，而那正是补扫幂等能覆盖的。
   */
  private applyOutcome(
    automation: Automation,
    run: AutomationRun,
    outcome: AutomationOutcome,
  ): void {
    const now = this.clock.now();
    automation.recordOutcome(outcome, now);
    run.markOutcomeApplied();
    const events = [
      ...automation.pullEvents(),
      new AutomationRunFinished(automation.id, automation.name, run.id, run.status, now),
    ];
    this.uow.run((tx) => {
      this.runs.saveSync(tx, run);
      this.rules.saveSync(tx, automation);
      this.events.publishInTx(tx, events);
    });
    if (!automation.enabled) {
      this.audit.record({
        category: 'project',
        type: 'automation.disabled',
        actor: 'scheduler',
        subjectType: 'automation',
        subjectId: automation.id,
        summary: `自动化规则「${automation.name}」连续失败 ${String(automation.failureCount)} 次，已自动禁用`,
        detail: { projectId: automation.projectId, failureCount: automation.failureCount },
        outcome: 'failed',
      });
    }
    this.notify(this.notifier.afterStateChange(automation));
  }

  /**
   * webhook 是**旁路**（03 §8.5「投递失败绝不影响 run 本身的状态」），所以不 await ——
   * 一次投递最坏 40 秒（10s 超时 + 5s/25s 退避），把它挂在扫描循环上等于让一条通知
   * 拖住整轮调度。
   *
   * ⚠️ **必须 `.catch()`，不能裸 `void`**：`void aRejectingPromise` 是一个
   * unhandled rejection，Node 22 的默认行为是**让进程退出**。整个平台因为一个 webhook
   * 对端返回了畸形响应而挂掉，是这一行能造成的最贵的事故。`AutomationNotifier` 自己
   * 也逐处兜了，这里是纵深防御的第二道。
   */
  private notify(p: Promise<void>): void {
    p.catch((e: unknown) => {
      this.logger.warn(`automation notification failed: ${String(e)}`);
    });
  }

  private persistRun(run: AutomationRun): void {
    this.uow.run((tx) => {
      this.runs.saveSync(tx, run);
    });
  }
}

/** I-AUR-4 的上限，用于把 provider 报上来的体积夹住（超限会被聚合拒绝）。 */
const LOG_CEILING = 31_457_280;

/**
 * 与 `hydrateAll` 同款的取文案方式：**非 Error 也要能读**。
 * `(e as Error).message` 遇到 `throw 'boom'`（JS 里合法）会把一行日志写成 `undefined`
 * —— 而这几处日志的全部价值就是「说清楚它为什么被跳过」。
 */
function reason(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function launchInput(automation: Automation): AutomationTaskLaunchInput {
  return {
    projectId: automation.projectId,
    runtimeId: automation.runtimeId,
    prompt: automation.prompt,
    timeoutMinutes: automation.timeoutMinutes as TimeoutMinutes,
    automationId: automation.id,
  };
}

/** 03 §8.2：默认 5min，可调（部署里偶尔要放宽，比如冷启动很慢的机器）。 */
function missedThresholdMin(): number {
  const raw = Number(process.env.AUTOMATION_MISSED_THRESHOLD_MIN);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MISSED_THRESHOLD_MIN;
}
