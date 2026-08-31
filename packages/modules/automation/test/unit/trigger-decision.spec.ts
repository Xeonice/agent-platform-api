import { describe, expect, it } from 'vitest';
import { asAutomationId, asProjectId } from '@platform/shared-kernel';
import { Automation } from '../../src/domain/entities/automation.entity';
import { AutomationRun } from '../../src/domain/entities/automation-run.entity';
import { TriggerDecisionService } from '../../src/domain/services/trigger-decision.domain-service';
import type {
  CredentialState,
  SchedulingDecision,
} from '../../src/domain/services/trigger-decision.domain-service';

/**
 * `TriggerDecisionService` —— 03 §8.2 决策表的**表驱动穷举**（25 §3.7 T-AUT-10..18）。
 *
 * 零 IO、零 mock、零时钟：全部入参都是普通值。这正是 23 §11.4 把它设计成纯函数的
 * 目的 —— 决策表的每一行都能被单独钉住。
 *
 * ── 每组断言钉住的变异 ──────────────────────────────────────────────────────────
 *  ① 行 1 与行 2 对调                       ⇒ T-AUT-18 红
 *  ② `expiring` 也当成过期拦下来            ⇒「expiring 放行」红
 *  ③ missed 阈值 5min 改成别的              ⇒ T-AUT-15 / T-AUT-16 红
 *  ④ missed 判定挪到行 1 之后               ⇒「宕机期间上次还在跑 ⇒ missed」红
 *  ⑤ `RetryPolicy.MAX_ATTEMPTS` 5 → 6       ⇒ T-AUT-14 红
 *  ⑥ 行 3 的 `retryCount` 取自新 run（恒 0）⇒ T-AUT-14 红
 */
const at = (s: string) => new Date(s);
const NOW = at('2026-06-01T10:00:00Z');

/** `nextTriggerAt` 恰好等于 `now`（准点到期，未迟到）。 */
function rule(nextTriggerOffsetMin = 0): Automation {
  const a = Automation.create({
    id: asAutomationId('aut-1'),
    projectId: asProjectId('prj-1'),
    name: 'nightly',
    runtimeId: 'codex',
    prompt: 'go',
    scheduleKind: 'hourly',
    scheduleConfig: { minute: 0 },
    timezone: 'UTC',
    timeoutMinutes: 120,
    artifactRetentionDays: 7,
    now: at('2026-06-01T09:00:00Z'),
  });
  // 直接把 nextTriggerAt 摆到我们要的位置：advanceTrigger 只会算出未来时刻，
  // 而这里要的是「已经过期了 N 分钟」这个局面。
  a.advanceTrigger(at(`2026-06-01T${String(9).padStart(2, '0')}:59:00Z`));
  const due = new Date(NOW.getTime() - nextTriggerOffsetMin * 60_000);
  Object.defineProperty(a, '_nextTriggerAt', { value: due, writable: true });
  return a;
}

function decide(input: {
  overdueMin?: number;
  previousRun?: AutomationRun | null;
  previousTaskActive?: boolean;
  credentialState?: CredentialState;
  schedulingDecision?: SchedulingDecision;
  missedThresholdMin?: number;
}) {
  return TriggerDecisionService.decide({
    automation: rule(input.overdueMin ?? 0),
    previousRun: input.previousRun ?? null,
    previousTaskActive: input.previousTaskActive ?? false,
    credentialState: input.credentialState ?? 'active',
    schedulingDecision: input.schedulingDecision ?? 'ok',
    now: NOW,
    ...(input.missedThresholdMin !== undefined
      ? { missedThresholdMin: input.missedThresholdMin }
      : {}),
  });
}

const runningRun = (): AutomationRun => {
  const r = AutomationRun.pending('run-prev', asAutomationId('aut-1'), at('2026-06-01T09:00:00Z'));
  r.markRunning('sbx-prev', at('2026-06-01T09:00:10Z'));
  return r;
};

const exhaustedRun = (retries: number): AutomationRun => {
  const r = AutomationRun.pending('run-prev', asAutomationId('aut-1'), at('2026-06-01T08:00:00Z'));
  for (let i = 0; i < retries; i += 1) r.queueRetry(at('2026-06-01T08:00:00Z'));
  return r;
};

describe('TriggerDecisionService —— 03 §8.2 决策表逐行', () => {
  it('T-AUT-10：上次 run 仍 running ⇒ Skip(PREVIOUS_RUNNING)（行 1）', () => {
    expect(decide({ previousRun: runningRun(), previousTaskActive: true })).toEqual({
      kind: 'skip',
      reason: 'PREVIOUS_RUNNING',
    });
  });

  it('上次 run 虽非终态但那个 Task 已经不在了 ⇒ 不算「还在跑」，照常触发', () => {
    expect(decide({ previousRun: runningRun(), previousTaskActive: false })).toEqual({
      kind: 'trigger',
    });
  });

  it('T-AUT-11：凭证 expired ⇒ Skip(AUTH_EXPIRED)（行 2）', () => {
    expect(decide({ credentialState: 'expired' })).toEqual({
      kind: 'skip',
      reason: 'AUTH_EXPIRED',
    });
  });

  it('T-AUT-12：凭证 none（从未配置）⇒ Skip(AUTH_EXPIRED)（行 2）', () => {
    expect(decide({ credentialState: 'none' })).toEqual({
      kind: 'skip',
      reason: 'AUTH_EXPIRED',
    });
  });

  it('凭证 expiring（剩 <7 天）⇒ **放行** —— 它是预警不是拦截（10 §7.1）', () => {
    expect(decide({ credentialState: 'expiring' })).toEqual({ kind: 'trigger' });
  });

  it('T-AUT-13：资源不足、retryCount=0 ⇒ Retry(now+24min)（行 3）', () => {
    const d = decide({ schedulingDecision: 'resource-exhausted' });
    expect(d.kind).toBe('retry');
    if (d.kind !== 'retry') throw new Error('unreachable');
    expect(d.at.toISOString()).toBe('2026-06-01T10:24:00.000Z');
  });

  it('资源不足、上一条已排过 4 次 ⇒ 还能再排第 5 次', () => {
    const d = decide({
      schedulingDecision: 'resource-exhausted',
      previousRun: exhaustedRun(4),
    });
    expect(d.kind).toBe('retry');
  });

  it('★ T-AUT-14：资源不足、retryCount=5 ⇒ Fail（终态失败，不再重试）', () => {
    expect(
      decide({ schedulingDecision: 'resource-exhausted', previousRun: exhaustedRun(5) }),
    ).toEqual({ kind: 'fail', errorCode: 'RESOURCE_EXHAUSTED' });
  });

  it('T-AUT-15：nextTriggerAt 过期 3min（阈值 5min）⇒ Trigger（正常迟到，不算 missed）', () => {
    expect(decide({ overdueMin: 3 })).toEqual({ kind: 'trigger' });
    // 边界：正好 5 分钟仍然是「迟到」，不是 missed
    expect(decide({ overdueMin: 5 })).toEqual({ kind: 'trigger' });
  });

  it('★ T-AUT-16：nextTriggerAt 过期 90min ⇒ Missed（**不补跑**）', () => {
    expect(decide({ overdueMin: 90 })).toEqual({ kind: 'missed' });
    // 刚过阈值一分钟也算
    expect(decide({ overdueMin: 6 })).toEqual({ kind: 'missed' });
  });

  it('missedThresholdMin 可调：阈值放到 120min 后，过期 90min 变回 Trigger', () => {
    expect(decide({ overdueMin: 90, missedThresholdMin: 120 })).toEqual({ kind: 'trigger' });
  });

  it('T-AUT-17：全部条件正常 ⇒ Trigger（行 4）', () => {
    expect(decide({})).toEqual({ kind: 'trigger' });
  });

  it('★ T-AUT-18：上次仍在跑 **且** 凭证过期 ⇒ PREVIOUS_RUNNING（判定优先级断言）', () => {
    expect(
      decide({
        previousRun: runningRun(),
        previousTaskActive: true,
        credentialState: 'expired',
      }),
    ).toEqual({ kind: 'skip', reason: 'PREVIOUS_RUNNING' });
  });

  it('★ 宕机 90 分钟期间上次还在跑 ⇒ **missed**，不是 PREVIOUS_RUNNING', () => {
    // 这一条钉的是本实现对「missed 排在行 1 之前」的定位判断（见决策服务的文件头）：
    // 一个每分钟扫一次的调度器，`next_trigger_at` 过期 90 分钟只有一种成因 —— 平台
    // 那段时间没在跑。历史里该看到的是「宕机错过」，而不是一串 PREVIOUS_RUNNING。
    expect(decide({ overdueMin: 90, previousRun: runningRun(), previousTaskActive: true })).toEqual(
      { kind: 'missed' },
    );
  });

  it('资源不足与凭证过期同时成立 ⇒ 凭证先判（行 2 在行 3 之前）', () => {
    expect(
      decide({ credentialState: 'expired', schedulingDecision: 'resource-exhausted' }),
    ).toEqual({ kind: 'skip', reason: 'AUTH_EXPIRED' });
  });
});
