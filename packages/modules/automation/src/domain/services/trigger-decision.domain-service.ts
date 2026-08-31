import { DEFAULT_MISSED_THRESHOLD_MIN, RetryPolicy } from '../value-objects/policies.vo';
import { Decisions } from '../value-objects/trigger-decision.vo';
import type { TriggerDecision } from '../value-objects/trigger-decision.vo';
import type { Automation } from '../entities/automation.entity';
import type { AutomationRun } from '../entities/automation-run.entity';

/** 凭证聚合态（05 §4 / 10 §7.1 `CredentialStatus`）。domain 侧重新声明。 */
export type CredentialState = 'none' | 'active' | 'expiring' | 'expired';

/**
 * 资源判定（03 §2/§3 的调度决策）。
 *
 * ⚠️ **今天平台侧还没有同步的资源判定**（`resource_allocations` 表未建，03 §3 的互斥
 * 登记未落地），所以 application 目前恒传 `'ok'`，真正的 `RESOURCE_EXHAUSTED` 由创建
 * Task 那一刻的 provider 错误带回来（`AutomationResourceExhausted`）。这个入参**现在
 * 就留着**，是因为决策表行 3 的判定逻辑（含 5 次上限）在这里才是可穷举测试的
 * （25 T-AUT-13/14），而不是因为它已经有真实产出方。
 */
export type SchedulingDecision = 'ok' | 'resource-exhausted';

export interface TriggerDecisionInput {
  automation: Automation;
  /** 上一条 run（含未终态的）。`PREVIOUS_RUNNING` 与「重试到第几次」都看它。 */
  previousRun: AutomationRun | null;
  /** 上一条 run 关联的 Task 是否仍在非终态。`previousRun` 为空时无意义。 */
  previousTaskActive: boolean;
  credentialState: CredentialState;
  schedulingDecision: SchedulingDecision;
  now: Date;
  /** 03 §8.2：默认 5min。 */
  missedThresholdMin?: number;
}

/**
 * `TriggerDecisionService`（23 §11.4，「本文档最重要的一个」）。
 *
 * **零 IO** —— 凭证状态、上次 run、资源决策、当前时刻全部由 application 先查好传入。
 * 这样 03 §8.2 的整张决策表可以用一组表驱动用例穷举（25 §3.7 的 T-AUT-10..18），
 * 不需要起数据库、不需要真时钟、不需要 mock 任何东西。
 *
 * ── 判定顺序 ────────────────────────────────────────────────────────────────
 *   0. missed（宕机错过）
 *   1. 上次 Task 仍非终态          ⇒ Skip(PREVIOUS_RUNNING)
 *   2. runtime 无生效凭证          ⇒ Skip(AUTH_EXPIRED)
 *   3. 资源不足                    ⇒ Retry(now+24min) / 5 次后 Fail
 *   4. 以上皆否                    ⇒ Trigger
 *
 * ⚠️ **1–4 的相对顺序是 03 §8.2 表格的「判定顺序」列，不能重排**（T-AUT-18 就是拿
 * 「上次仍在跑 **且** 凭证过期」来钉这一条的：答案必须是 `PREVIOUS_RUNNING`）。
 *
 * ★ **missed 排在最前面，这一条是本实现做的定位判断，文档没有明写。**
 * 判据：`next_trigger_at` 过期超过 5 分钟，在一个每分钟扫一次的调度器上只有一种成因
 * —— **平台那段时间没在跑**。那么这一格该记的事实就是「宕机错过了一次」，而不是
 * 「上次那个 Task 还没结束」（它没结束恰恰也是因为平台死了）。把 missed 排在行 1
 * 后面，会让一次两小时的宕机在历史里显示成一串 `PREVIOUS_RUNNING`，把停机这件事
 * 彻底掩盖掉。
 */
export class TriggerDecisionService {
  static decide(input: TriggerDecisionInput): TriggerDecision {
    const { automation, previousRun, now } = input;
    const thresholdMin = input.missedThresholdMin ?? DEFAULT_MISSED_THRESHOLD_MIN;

    // ── 0. 宕机 missed ──────────────────────────────────────────────────────
    const due = automation.nextTriggerAt;
    if (due !== null) {
      const lateMs = now.getTime() - due.getTime();
      if (lateMs > thresholdMin * 60_000) return Decisions.missed();
    }

    // ── 1. 上次触发的 Task 仍在非终态（03 §8.2 行 1；MVP 唯一并发档 'skip'）──
    if (previousRun !== null && !previousRun.isTerminal && input.previousTaskActive) {
      return Decisions.skip('PREVIOUS_RUNNING');
    }

    // ── 2. 该 runtime 无生效凭证 / 已过期 / 已吊销（行 2）────────────────────
    //
    // ⚠️ `expiring`（剩 <7 天）**放行**。它是预警不是拦截（10 §7.1 那一行原话：
    // 「只预警不拦截」），把它当过期会让一条规则在凭证到期前一周就静默停摆。
    if (input.credentialState === 'none' || input.credentialState === 'expired') {
      return Decisions.skip('AUTH_EXPIRED');
    }

    // ── 3. 资源不足：排队重试 24min × 最多 5 次（行 3）───────────────────────
    if (input.schedulingDecision === 'resource-exhausted') {
      const attempts = previousRun !== null && !previousRun.isTerminal ? previousRun.retryCount : 0;
      return RetryPolicy.canRetry(attempts)
        ? Decisions.retry(RetryPolicy.nextAttemptAt(now))
        : Decisions.fail();
    }

    // ── 4. 创建标准无头 Task（行 4）─────────────────────────────────────────
    return Decisions.trigger();
  }
}
