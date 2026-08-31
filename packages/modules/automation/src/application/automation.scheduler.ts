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
   */
  async runOnce(): Promise<number> {
    if (this.mutex.isLocked()) return 0;
    return this.mutex.runExclusive(async () => {
      let touched = 0;
      try {
        touched += await this.applyPendingOutcomes();
        touched += await this.advanceInFlight();
        touched += await this.fireDue();
      } catch (e) {
        // 一轮扫挂了不该带走定时器：下一分钟还会来。
        this.logger.error(`automation sweep failed: ${(e as Error).message}`);
      }
      return touched;
    });
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
      const automation = await this.rules.findById(run.automationId);
      if (automation === null) continue;
      touched += (await this.tryStartSandbox(automation, run)) ? 1 : 0;
    }

    // ② provisioning / ready / running
    for (const run of await this.inFlightRuns()) {
      if (run.sandboxId === null) continue;
      const phase = await this.launcher.phaseOf(run.sandboxId);
      switch (phase.kind) {
        case 'provisioning':
        case 'running':
          break;
        case 'ready': {
          const automation = await this.rules.findById(run.automationId);
          if (automation === null) break;
          await this.startTaskOn(automation, run);
          touched += 1;
          break;
        }
        case 'finished': {
          const automation = await this.rules.findById(run.automationId);
          if (automation === null) break;
          // ★ 决策表行 3 的**另一半**（03 §8.2）：沙箱是建出来了，但它死在「没资源」上
          // （典型：工作区复制时磁盘写满 ⇒ `DISK_INSUFFICIENT`）。这**不是**规则失败，
          // 与创建那一刻被互斥区拒完全同源，所以走同一段记账 —— 排队重试、不计失败。
          //
          // ⚠️ 判据是**码**不是文案。`errorMessage` 是给人看的自由文本，靠它做分支就是
          // 把一条领域判定挂在一句随时会被改写的句子上。
          if (phase.status === 'failed' && isCapacityFailureCode(phase.errorCode)) {
            this.queueOrGiveUp(automation, run);
            touched += 1;
            break;
          }
          if (run.status === 'pending') run.markRunning(run.sandboxId, this.clock.now());
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
          touched += 1;
          break;
        }
        case 'gone': {
          const automation = await this.rules.findById(run.automationId);
          if (automation === null) break;
          if (run.status === 'pending') run.markRunning(run.sandboxId, this.clock.now());
          run.finalize('failed', this.clock.now(), {
            errorMessage: 'the sandbox backing this run no longer exists',
          });
          this.applyOutcome(automation, run, 'failed');
          this.notify(this.notifier.afterRunFinished(automation, run));
          touched += 1;
          break;
        }
      }
    }
    return touched;
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
        this.logger.warn(`automation ${automation.id} failed to fire: ${(e as Error).message}`);
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
