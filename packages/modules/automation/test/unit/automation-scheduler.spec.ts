import { beforeEach, describe, expect, it, vi } from 'vitest';
import { asAutomationId } from '@platform/shared-kernel';
import { AutomationResourceExhausted } from '@platform/contracts';
import { AutomationScheduler } from '../../src/application/automation.scheduler';
import { AutomationNotifier } from '../../src/application/automation.notifier';
import { AutomationRun } from '../../src/domain/entities/automation-run.entity';
import {
  FakeClock,
  FakeCredentials,
  FakeLauncher,
  InMemoryAutomationRepo,
  InMemoryRunRepo,
  NoopAudit,
  RecordingEventBus,
  SeqIds,
  SyncUow,
  hourlyRule,
} from './_scheduler-doubles';

/**
 * `AutomationScheduler` —— 03 §8.1 的五条，逐条钉住。
 *
 * ★★ 这是本切片唯一有**真并发语义**的部分，所以下面每一个 `★` 断言都对应一条
 *    明确的变异（报告里逐条列了改坏之后红的是哪几条）：
 *
 *  ① 「先推进 `next_trigger_at` 后执行」改成「先执行后推进」 ⇒ 「先推进后执行」两条红
 *  ② `runOnce` 的 `mutex.isLocked()` 早退去掉               ⇒ T-AUT-42 红
 *  ③ missed 阈值 5min 改成 90min                            ⇒ 「过期 90min ⇒ missed」红
 *  ④ 重试上限 5 → 6                                         ⇒ 「第 6 次转终态 failed」红
 *  ⑤ 时区改成读系统 TZ                                       ⇒ 「TZ 变了 next_trigger_at 不变」红
 *  ⑥ `outcome_applied` 补扫去掉                              ⇒ 「孤儿 run 被补记」红
 */

/**
 * 一个什么都不做的 notifier —— webhook 有它自己的单测，这里只测调度。
 *
 * ⚠️ 用 `Pick<>` 而不是 `as unknown as`：后者在本仓被 eslint 全局禁掉（含测试），
 * 而且它会让「调度器多调了一个 notifier 上不存在的方法」这种错误静默通过。
 */
type NotifierSurface = Pick<
  AutomationNotifier,
  'summarize' | 'afterRunFinished' | 'afterAuthExpired' | 'afterStateChange'
>;

/**
 * 一个**记账式**的 notifier：仍然什么都不发（webhook 有自己的单测），但把「谁在什么
 * 时候被通知了」记下来。
 *
 * ⚠️ 它取代了原来那个全 `Promise.resolve()` 的哑替身。哑替身让「凭证过期要发 webhook」
 * （03 §8.2 行 2）这条规则在调度器这一层**一次都没被断言过** —— 少发一条通知的实现
 * 和发了的实现在测试里长得一模一样。
 *
 * `rejectNext` 让「投递炸了」也能被摆出来：webhook 是旁路（03 §8.5），一次投递失败
 * 绝不能反过来影响 run 的状态，更不能变成 unhandled rejection 把进程带走。
 */
interface NotifierCalls {
  summarizeArgs: (string | null)[];
  runFinished: { automationId: string; runId: string }[];
  authExpired: { automationId: string; runId: string }[];
  stateChanged: string[];
}

interface RecordingNotifier {
  notifier: AutomationNotifier;
  calls: NotifierCalls;
  /** 让之后每一次 `afterRunFinished` 都以 reject 收场。 */
  breakDelivery: () => void;
}

function recordingNotifier(): RecordingNotifier {
  const calls: NotifierCalls = {
    summarizeArgs: [],
    runFinished: [],
    authExpired: [],
    stateChanged: [],
  };
  let broken = false;
  const stub: NotifierSurface = {
    summarize: (logPath) => {
      calls.summarizeArgs.push(logPath);
      return Promise.resolve(undefined);
    },
    afterRunFinished: (automation, run) => {
      calls.runFinished.push({ automationId: automation.id, runId: run.id });
      return broken ? Promise.reject(new Error('webhook 对端返回了畸形响应')) : Promise.resolve();
    },
    afterAuthExpired: (automation, run) => {
      calls.authExpired.push({ automationId: automation.id, runId: run.id });
      return Promise.resolve();
    },
    afterStateChange: (automation) => {
      calls.stateChanged.push(automation.id);
      return Promise.resolve();
    },
  };
  return {
    notifier: stub as AutomationNotifier,
    calls,
    breakDelivery: () => {
      broken = true;
    },
  };
}

interface Harness {
  scheduler: AutomationScheduler;
  rules: InMemoryAutomationRepo;
  runs: InMemoryRunRepo;
  launcher: FakeLauncher;
  credentials: FakeCredentials;
  clock: FakeClock;
  events: RecordingEventBus;
  audit: NoopAudit;
  notifications: NotifierCalls;
  breakDelivery: () => void;
}

function harness(now: Date): Harness {
  const rules = new InMemoryAutomationRepo();
  const runs = new InMemoryRunRepo();
  const launcher = new FakeLauncher();
  const credentials = new FakeCredentials('active');
  const clock = new FakeClock(now);
  const events = new RecordingEventBus();
  const audit = new NoopAudit();
  const notifier = recordingNotifier();
  const scheduler = new AutomationScheduler(
    rules,
    runs,
    launcher,
    credentials,
    new SyncUow(),
    events,
    clock,
    new SeqIds(),
    audit,
    notifier.notifier,
  );
  return {
    scheduler,
    rules,
    runs,
    launcher,
    credentials,
    clock,
    events,
    audit,
    notifications: notifier.calls,
    breakDelivery: notifier.breakDelivery,
  };
}

const at = (s: string) => new Date(s);

/** 把规则的 `next_trigger_at` 摆到指定时刻（测试要制造「已经过期 N 分钟」的局面）。 */
function setDue(rule: object, due: Date): void {
  Object.defineProperty(rule, '_nextTriggerAt', { value: due, writable: true });
}

describe('AutomationScheduler —— ③ 先推进 next_trigger_at，后执行（I-AUT-8）', () => {
  it('★ 触发时：`createSandbox` 被调用**之前**，规则的新 next_trigger_at 已经落库', async () => {
    const h = harness(at('2026-06-01T10:00:00Z'));
    const rule = h.rules.seed(hourlyRule('aut-1', at('2026-06-01T09:00:00Z')));
    setDue(rule, at('2026-06-01T10:00:00Z'));

    // 在 launcher 被调用的那一刻，去看仓库里那条规则的 next_trigger_at
    let nextAtLaunchTime: string | null | undefined;
    h.launcher.createBehaviour = () => {
      nextAtLaunchTime = h.rules.rows.get('aut-1')?.nextTriggerAt?.toISOString() ?? null;
      return { sandboxId: 'sbx-1' };
    };

    await h.scheduler.runOnce();

    expect(h.launcher.created).toHaveLength(1);
    // ★ 已经是 11:00 —— 也就是说推进发生在 launch 之前
    expect(nextAtLaunchTime).toBe('2026-06-01T11:00:00.000Z');
  });

  it('★ `createSandbox` 抛异常时，next_trigger_at 仍然被推进了（不会一分钟一发）', async () => {
    const h = harness(at('2026-06-01T10:00:00Z'));
    const rule = h.rules.seed(hourlyRule('aut-1', at('2026-06-01T09:00:00Z')));
    setDue(rule, at('2026-06-01T10:00:00Z'));
    h.launcher.createBehaviour = () => {
      throw new Error('provider exploded');
    };

    await h.scheduler.runOnce();

    // ★ 这一条是 I-AUT-8 的全部意义：执行炸了，推进照样生效
    expect(h.rules.rows.get('aut-1')?.nextTriggerAt?.toISOString()).toBe(
      '2026-06-01T11:00:00.000Z',
    );
    // 再扫一轮不会再触发（now 还是 10:00，而下一次在 11:00）
    h.launcher.createBehaviour = () => ({ sandboxId: 'sbx-2' });
    await h.scheduler.runOnce();
    expect(h.launcher.created).toHaveLength(1);
  });
});

describe('AutomationScheduler —— ② 单实例串行（async-mutex）', () => {
  it('★ T-AUT-42：runOnce 扫描期间再次调用 ⇒ 第二次立即返回 0，不产生重复触发', async () => {
    const h = harness(at('2026-06-01T10:00:00Z'));
    const rule = h.rules.seed(hourlyRule('aut-1', at('2026-06-01T09:00:00Z')));
    setDue(rule, at('2026-06-01T10:00:00Z'));

    // 让第一轮在 launcher 里挂住，好在它还没结束时发起第二轮
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.launcher.createBehaviour = () => ({ sandboxId: 'sbx-1' });
    const originalCreate = h.launcher.createSandbox.bind(h.launcher);
    h.launcher.createSandbox = async (input) => {
      await gate;
      return originalCreate(input);
    };

    const first = h.scheduler.runOnce();
    // ★ 第一轮还卡在 launcher 里 —— 第二轮必须**立即**返回 0，而不是排队等
    const second = await h.scheduler.runOnce();
    expect(second).toBe(0);

    release();
    await first;
    // ★ 全程只触发了一次
    expect(h.launcher.created).toHaveLength(1);
  });
});

describe('AutomationScheduler —— 宕机 missed（03 §8.2）', () => {
  it('★ 过期 90 分钟 ⇒ 记 missed、**不补跑**、直接推进到下一个未来时刻', async () => {
    const h = harness(at('2026-06-01T10:00:00Z'));
    const rule = h.rules.seed(hourlyRule('aut-1', at('2026-06-01T07:00:00Z')));
    setDue(rule, at('2026-06-01T08:30:00Z')); // 过期 90 分钟

    await h.scheduler.runOnce();

    const runs = [...h.runs.rows.values()];
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('missed');
    expect(runs[0].sandboxId).toBeNull();
    // ★ 不补跑：一次 launcher 都没调
    expect(h.launcher.created).toHaveLength(0);
    // ★ 直接推进到下一个**未来**时刻
    expect(h.rules.rows.get('aut-1')?.nextTriggerAt?.toISOString()).toBe(
      '2026-06-01T11:00:00.000Z',
    );
    // I-AUT-1：missed 不计入失败
    expect(h.rules.rows.get('aut-1')?.failureCount).toBe(0);
  });

  it('★ 过期 3 分钟（阈值 5min）⇒ 正常触发，不是 missed', async () => {
    const h = harness(at('2026-06-01T10:03:00Z'));
    const rule = h.rules.seed(hourlyRule('aut-1', at('2026-06-01T09:00:00Z')));
    setDue(rule, at('2026-06-01T10:00:00Z'));

    await h.scheduler.runOnce();

    expect(h.launcher.created).toHaveLength(1);
    expect([...h.runs.rows.values()][0].status).toBe('running');
  });
});

describe('AutomationScheduler —— 决策表行 1/2 落成终态 run', () => {
  it('上次 Task 仍在跑 ⇒ skipped / PREVIOUS_RUNNING，不起新 Task', async () => {
    const h = harness(at('2026-06-01T10:00:00Z'));
    const rule = h.rules.seed(hourlyRule('aut-1', at('2026-06-01T08:00:00Z')));
    setDue(rule, at('2026-06-01T10:00:00Z'));
    const prev = AutomationRun.pending(
      'run-prev',
      asAutomationId('aut-1'),
      at('2026-06-01T09:00:00Z'),
    );
    prev.markRunning('sbx-prev', at('2026-06-01T09:00:10Z'));
    h.runs.seed(prev);
    h.launcher.phaseQueue = [{ kind: 'running' }];

    await h.scheduler.runOnce();

    const skipped = [...h.runs.rows.values()].find((r) => r.status === 'skipped');
    expect(skipped?.errorCode).toBe('PREVIOUS_RUNNING');
    expect(h.launcher.created).toHaveLength(0);
    // I-AUT-1：skipped 不计入失败
    expect(h.rules.rows.get('aut-1')?.failureCount).toBe(0);
  });

  it('runtime 无生效凭证 ⇒ skipped / AUTH_EXPIRED', async () => {
    const h = harness(at('2026-06-01T10:00:00Z'));
    const rule = h.rules.seed(hourlyRule('aut-1', at('2026-06-01T09:00:00Z')));
    setDue(rule, at('2026-06-01T10:00:00Z'));
    h.credentials.state = 'expired';

    await h.scheduler.runOnce();

    const run = [...h.runs.rows.values()][0];
    expect(run.status).toBe('skipped');
    expect(run.errorCode).toBe('AUTH_EXPIRED');
    expect(h.launcher.created).toHaveLength(0);
  });
});

describe('AutomationScheduler —— 决策表行 3：资源不足排队重试 24min × 5', () => {
  function resourceStarvedHarness(): Harness {
    const h = harness(at('2026-06-01T10:00:00Z'));
    const rule = h.rules.seed(hourlyRule('aut-1', at('2026-06-01T09:00:00Z')));
    setDue(rule, at('2026-06-01T10:00:00Z'));
    h.launcher.createBehaviour = () => {
      throw new AutomationResourceExhausted('no capacity');
    };
    return h;
  }

  it('第一次资源不足 ⇒ 同一行 run 转 resource-exhausted，retryAt = now + 24min', async () => {
    const h = resourceStarvedHarness();
    await h.scheduler.runOnce();

    const runs = [...h.runs.rows.values()];
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('resource-exhausted');
    expect(runs[0].retryCount).toBe(1);
    expect(runs[0].retryAt?.toISOString()).toBe('2026-06-01T10:24:00.000Z');
  });

  it('★ 排队重试**始终是同一行 run**（I-AUR-2），第 6 次才转终态 failed', async () => {
    const h = resourceStarvedHarness();
    await h.scheduler.runOnce(); // retryCount 1
    // 把下一次触发推到明天：本用例要看的是**重试**这条线，不希望中途被规则自己的
    // 下一个整点插进来（那会正确地落一条 skipped/PREVIOUS_RUNNING，但不是这里的题）。
    setDue(h.rules.rows.get('aut-1') as never, at('2026-06-02T10:00:00Z'));

    // 之后每 24 分钟到点重试一次
    for (let i = 2; i <= 5; i += 1) {
      h.clock.advanceMinutes(24);
      await h.scheduler.runOnce();
      const rows = [...h.runs.rows.values()];
      // ★ 一直只有一条记录
      expect(rows).toHaveLength(1);
      expect(rows[0].retryCount).toBe(i);
      expect(rows[0].status).toBe('resource-exhausted');
    }

    // 第 6 次到点：预算用尽 ⇒ 终态 failed + RESOURCE_EXHAUSTED
    h.clock.advanceMinutes(24);
    await h.scheduler.runOnce();
    const rows = [...h.runs.rows.values()];
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('failed');
    expect(rows[0].errorCode).toBe('RESOURCE_EXHAUSTED');
    // 这一次才计入连续失败
    expect(h.rules.rows.get('aut-1')?.failureCount).toBe(1);
  });
});

describe('★ 决策表行 3 的**判据**：schedulingDecision 现在有真实产出方', () => {
  it('每一次触发都先问一次容量，问的是这条规则自己的项目/runtime', async () => {
    const h = harness(at('2026-06-01T10:00:00Z'));
    const rule = h.rules.seed(hourlyRule('aut-1', at('2026-06-01T09:00:00Z')));
    setDue(rule, at('2026-06-01T10:00:00Z'));

    await h.scheduler.runOnce();

    // 落地之前这里恒传 `'ok'`，`capacityFor` 根本不存在 —— 「行 3 有没有判据」
    // 这件事在测试里一次都没被问过。
    expect(h.launcher.capacityProbes).toHaveLength(1);
    expect(h.launcher.capacityProbes[0]).toMatchObject({
      projectId: rule.projectId,
      runtimeId: rule.runtimeId,
    });
  });

  it('★★ 容量判定为 resource-exhausted ⇒ **一个沙箱都不建**，直接排队', async () => {
    const h = harness(at('2026-06-01T10:00:00Z'));
    const rule = h.rules.seed(hourlyRule('aut-1', at('2026-06-01T09:00:00Z')));
    setDue(rule, at('2026-06-01T10:00:00Z'));
    h.launcher.capacityVerdict = 'resource-exhausted';

    await h.scheduler.runOnce();

    // 明知会被互斥区拒还去撞一次，会在任务列表里留下痕迹、也说不清「已排队 n/5」的 n
    // 是怎么来的。
    expect(h.launcher.created).toHaveLength(0);
    const runs = [...h.runs.rows.values()];
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('resource-exhausted');
    expect(runs[0].retryCount).toBe(1);
    expect(runs[0].retryAt?.toISOString()).toBe('2026-06-01T10:24:00.000Z');
    // ★ 与「失败」的分界：资源不足**不动**失败计数（I-AUT-1）
    expect(h.rules.rows.get('aut-1')?.failureCount).toBe(0);
  });

  it('★ 排队的这一发照样发 AutomationTriggered —— 历史里必须看得见它触发过', async () => {
    const h = harness(at('2026-06-01T10:00:00Z'));
    const rule = h.rules.seed(hourlyRule('aut-1', at('2026-06-01T09:00:00Z')));
    setDue(rule, at('2026-06-01T10:00:00Z'));
    h.launcher.capacityVerdict = 'resource-exhausted';

    await h.scheduler.runOnce();

    expect(h.events.published.filter((e) => e.type === 'AutomationTriggered')).toHaveLength(1);
  });

  it('容量回来之后，到点的那次重试正常起沙箱（同一行 run）', async () => {
    const h = harness(at('2026-06-01T10:00:00Z'));
    const rule = h.rules.seed(hourlyRule('aut-1', at('2026-06-01T09:00:00Z')));
    setDue(rule, at('2026-06-01T10:00:00Z'));
    h.launcher.capacityVerdict = 'resource-exhausted';
    await h.scheduler.runOnce();

    h.launcher.capacityVerdict = 'ok';
    setDue(h.rules.rows.get('aut-1') as never, at('2026-06-02T10:00:00Z'));
    h.clock.advanceMinutes(24);
    await h.scheduler.runOnce();

    const runs = [...h.runs.rows.values()];
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('running');
    expect(h.launcher.created).toHaveLength(1);
  });
});

describe('★★ 决策表行 3 的**另一半**：后台 provision 阶段撞上容量，同样不计失败', () => {
  /** 一发已经建出沙箱、正在 provision 的 run。 */
  async function inFlight(): Promise<Harness> {
    const h = harness(at('2026-06-01T10:00:00Z'));
    const rule = h.rules.seed(hourlyRule('aut-1', at('2026-06-01T09:00:00Z')));
    setDue(rule, at('2026-06-01T10:00:00Z'));
    h.launcher.phaseQueue = [{ kind: 'provisioning' }];
    await h.scheduler.runOnce();
    setDue(h.rules.rows.get('aut-1') as never, at('2026-06-02T10:00:00Z'));
    return h;
  }

  it('★★ 沙箱死于 DISK_INSUFFICIENT ⇒ 排队重试，`consecutive_failures` **不动**', async () => {
    const h = await inFlight();
    h.launcher.phaseQueue = [
      {
        kind: 'finished',
        status: 'failed',
        errorCode: 'DISK_INSUFFICIENT',
        errorMessage: 'not enough free space to prepare the workspace',
      },
    ];

    await h.scheduler.runOnce();

    const runs = [...h.runs.rows.values()];
    expect(runs).toHaveLength(1);
    // 落地之前：这条路 100% 走 `applyOutcome('failed')` ⇒ 计数 +1。机器一忙、盘一紧，
    // 连撞三次就 degraded、十次自动禁用 —— 而 I-AUT-1 说资源不足不是规则的错。
    expect(runs[0].status).toBe('resource-exhausted');
    expect(runs[0].retryCount).toBe(1);
    expect(h.rules.rows.get('aut-1')?.failureCount).toBe(0);
    expect(h.rules.rows.get('aut-1')?.degraded).toBe(false);
  });

  it('★ 判据是**码**不是文案：同样一句话、没有码 ⇒ 照旧记一次失败', async () => {
    const h = await inFlight();
    h.launcher.phaseQueue = [
      {
        kind: 'finished',
        status: 'failed',
        errorMessage: 'not enough free space to prepare the workspace',
      },
    ];

    await h.scheduler.runOnce();

    const runs = [...h.runs.rows.values()];
    expect(runs[0].status).toBe('failed');
    expect(h.rules.rows.get('aut-1')?.failureCount).toBe(1);
  });

  it('★ `WORKSPACE_PREPARE_FAILED` **不算**容量 —— 它重试一百次也不会好', async () => {
    const h = await inFlight();
    h.launcher.phaseQueue = [
      { kind: 'finished', status: 'failed', errorCode: 'WORKSPACE_PREPARE_FAILED' },
    ];

    await h.scheduler.runOnce();

    expect([...h.runs.rows.values()][0].status).toBe('failed');
    expect(h.rules.rows.get('aut-1')?.failureCount).toBe(1);
  });

  it('★ 普通的 Task 失败（TASK_FAILED）仍然计入失败计数 —— 没有被这条分支误伤', async () => {
    const h = await inFlight();
    h.launcher.phaseQueue = [{ kind: 'finished', status: 'failed', errorCode: 'TASK_FAILED' }];

    await h.scheduler.runOnce();

    expect([...h.runs.rows.values()][0].status).toBe('failed');
    expect(h.rules.rows.get('aut-1')?.failureCount).toBe(1);
  });

  it('后台容量失败排满 5 次之后，第 6 次转终态 failed —— 那一次才计入失败', async () => {
    const h = await inFlight();
    const exhausted = {
      kind: 'finished' as const,
      status: 'failed' as const,
      errorCode: 'DISK_INSUFFICIENT',
    };
    for (let i = 1; i <= 5; i += 1) {
      h.launcher.phaseQueue = [exhausted];
      h.clock.advanceMinutes(24);
      await h.scheduler.runOnce();
      const rows = [...h.runs.rows.values()];
      expect(rows).toHaveLength(1);
      expect(rows[0].retryCount).toBe(i);
    }
    h.launcher.phaseQueue = [exhausted];
    h.clock.advanceMinutes(24);
    await h.scheduler.runOnce();

    const rows = [...h.runs.rows.values()];
    expect(rows[0].status).toBe('failed');
    expect(rows[0].errorCode).toBe('RESOURCE_EXHAUSTED');
    expect(h.rules.rows.get('aut-1')?.failureCount).toBe(1);
  });
});

describe('AutomationScheduler —— 相位机：provisioning → ready → running → finished', () => {
  it('沙箱 ready 之后才 POST Task；Task 落终态时 run 被 finalize 并记账', async () => {
    const h = harness(at('2026-06-01T10:00:00Z'));
    const rule = h.rules.seed(hourlyRule('aut-1', at('2026-06-01T09:00:00Z')));
    setDue(rule, at('2026-06-01T10:00:00Z'));

    // 第一轮：触发 + 创建沙箱
    h.launcher.phaseQueue = [{ kind: 'provisioning' }];
    await h.scheduler.runOnce();
    expect(h.launcher.created).toHaveLength(1);
    expect(h.launcher.started).toHaveLength(0);

    // 第二轮：沙箱起来了 ⇒ 才 POST Task
    h.clock.advanceMinutes(1);
    h.launcher.phaseQueue = [{ kind: 'ready' }];
    await h.scheduler.runOnce();
    expect(h.launcher.started).toEqual(['sbx-1']);

    // 第三轮：Task 落终态
    h.clock.advanceMinutes(5);
    h.launcher.phaseQueue = [
      { kind: 'finished', status: 'success', logPath: '/tmp/x/stdout.jsonl', logBytes: 12 },
    ];
    await h.scheduler.runOnce();

    const run = [...h.runs.rows.values()][0];
    expect(run.status).toBe('success');
    expect(run.logPath).toBe('/tmp/x/stdout.jsonl');
    expect(run.logBytes).toBe(12);
    expect(run.outcomeApplied).toBe(true);
    expect(h.rules.rows.get('aut-1')?.failureCount).toBe(0);
  });

  it('Task 失败 ⇒ 计入连续失败；连续三次 ⇒ 规则降频（I-AUT-2）', async () => {
    const h = harness(at('2026-06-01T10:00:00Z'));
    const rule = h.rules.seed(hourlyRule('aut-1', at('2026-06-01T09:00:00Z')));

    for (let i = 0; i < 3; i += 1) {
      setDue(h.rules.rows.get('aut-1') as never, h.clock.now());
      h.launcher.phaseQueue = [{ kind: 'provisioning' }];
      await h.scheduler.runOnce();
      h.clock.advanceMinutes(1);
      h.launcher.phaseQueue = [{ kind: 'finished', status: 'failed', errorMessage: 'boom' }];
      await h.scheduler.runOnce();
      h.clock.advanceMinutes(30);
    }

    expect(rule.failureCount).toBe(3);
    expect(rule.degraded).toBe(true);
    expect(rule.enabled).toBe(true);
  });

  it('★ 一条 skipped 的新 run **盖不住**上一条还在跑的 run（回归：静默死锁）', async () => {
    // 这条钉的是一个真写过的 bug：`inFlightRuns` 曾经按「每条规则取最新一条 run」取数，
    // 于是 10:00 触发、还在跑的 A，被 11:00 那轮落下的 `skipped/PREVIOUS_RUNNING` B
    // 盖住 —— A 再也没人推进，永远 `running`；而 `PREVIOUS_RUNNING` 的判据正是
    // 「上一条非终态」，这条规则从此**永远跳过**。日志上什么都看不见。
    const h = harness(at('2026-06-01T10:00:00Z'));
    const rule = h.rules.seed(hourlyRule('aut-1', at('2026-06-01T09:00:00Z')));
    setDue(rule, at('2026-06-01T10:00:00Z'));

    // 第一轮：触发，A 起来了
    h.launcher.phaseQueue = [{ kind: 'provisioning' }];
    await h.scheduler.runOnce();
    const runA = [...h.runs.rows.values()][0];
    expect(runA.status).toBe('running');

    // 第二轮（下一个整点）：A 还在跑 ⇒ 落一条更新的 skipped B
    h.clock.set(at('2026-06-01T11:00:00Z'));
    setDue(h.rules.rows.get('aut-1') as never, at('2026-06-01T11:00:00Z'));
    h.launcher.phaseQueue = [{ kind: 'running' }];
    await h.scheduler.runOnce();
    expect([...h.runs.rows.values()].some((r) => r.status === 'skipped')).toBe(true);

    // 第三轮：A 的 Task 落终态 —— ★ 它必须被推进，哪怕 B 更新
    h.clock.set(at('2026-06-01T11:05:00Z'));
    setDue(h.rules.rows.get('aut-1') as never, at('2026-06-02T10:00:00Z'));
    h.launcher.phaseQueue = [{ kind: 'finished', status: 'success' }];
    await h.scheduler.runOnce();

    expect(h.runs.rows.get(runA.id)?.status).toBe('success');
  });

  it('沙箱记录没了（gone）⇒ run 落 failed，而不是永远停在 running', async () => {
    const h = harness(at('2026-06-01T10:00:00Z'));
    const rule = h.rules.seed(hourlyRule('aut-1', at('2026-06-01T09:00:00Z')));
    setDue(rule, at('2026-06-01T10:00:00Z'));
    h.launcher.phaseQueue = [{ kind: 'provisioning' }];
    await h.scheduler.runOnce();

    h.clock.advanceMinutes(1);
    h.launcher.phaseQueue = [{ kind: 'gone' }];
    await h.scheduler.runOnce();

    expect([...h.runs.rows.values()][0].status).toBe('failed');
  });
});

describe('AutomationScheduler —— ④ outcome-pending 孤儿补扫（交叉评审 P2-7）', () => {
  it('★ run 已终态但 outcome_applied=false ⇒ 补记一次失败计数，且**幂等**', async () => {
    const h = harness(at('2026-06-01T10:00:00Z'));
    const rule = h.rules.seed(hourlyRule('aut-1', at('2026-06-01T09:00:00Z')));
    // 这条规则这一刻不到期，所以本轮唯一会发生的事就是补扫
    setDue(rule, at('2026-06-01T11:00:00Z'));

    const orphan = AutomationRun.pending(
      'run-orphan',
      asAutomationId('aut-1'),
      at('2026-06-01T09:00:00Z'),
    );
    orphan.markRunning('sbx-x', at('2026-06-01T09:00:10Z'));
    orphan.finalize('failed', at('2026-06-01T09:05:00Z'), { errorMessage: 'crashed' });
    expect(orphan.outcomeApplied).toBe(false); // 崩在 recordOutcome 之前
    h.runs.seed(orphan);

    await h.scheduler.runOnce();
    expect(rule.failureCount).toBe(1);
    expect(h.runs.rows.get('run-orphan')?.outcomeApplied).toBe(true);

    // ★ 幂等：再扫一轮不会把它算第二次
    await h.scheduler.runOnce();
    expect(rule.failureCount).toBe(1);
  });

  it('skipped / missed 的 run 从一开始就是 outcome-applied，补扫扫不到', async () => {
    const h = harness(at('2026-06-01T10:00:00Z'));
    const rule = h.rules.seed(hourlyRule('aut-1', at('2026-06-01T09:00:00Z')));
    setDue(rule, at('2026-06-01T11:00:00Z'));
    h.runs.seed(
      AutomationRun.skipped(
        'run-s',
        asAutomationId('aut-1'),
        'AUTH_EXPIRED',
        'x',
        at('2026-06-01T09:00:00Z'),
      ),
    );
    h.runs.seed(
      AutomationRun.missed('run-m', asAutomationId('aut-1'), 'y', at('2026-06-01T09:30:00Z')),
    );

    await h.scheduler.runOnce();
    expect(rule.failureCount).toBe(0);
  });
});

describe('AutomationScheduler —— ⑤ 时区只读规则自己的列（I-AUT-9）', () => {
  const originalTz = process.env.TZ;
  beforeEach(() => {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  it('★ 进程 TZ 换成别的时区，同一条规则算出的 next_trigger_at 完全相同', async () => {
    const results: (string | null | undefined)[] = [];
    for (const tz of ['UTC', 'America/New_York', 'Asia/Kolkata']) {
      process.env.TZ = tz;
      const h = harness(at('2026-06-01T10:00:00Z'));
      // 规则自己的时区是 Asia/Shanghai —— 与进程 TZ 无关
      const rule = h.rules.seed(hourlyRule('aut-1', at('2026-06-01T09:00:00Z'), 'Asia/Shanghai'));
      setDue(rule, at('2026-06-01T10:00:00Z'));
      await h.scheduler.runOnce();
      results.push(h.rules.rows.get('aut-1')?.nextTriggerAt?.toISOString());
    }
    process.env.TZ = originalTz;

    expect(results[0]).toBe('2026-06-01T11:00:00.000Z');
    expect(new Set(results).size).toBe(1);
  });
});

describe('AutomationScheduler —— 一轮扫挂了不该带走定时器', () => {
  it('取数抛异常 ⇒ runOnce 返回 0 而不是把异常抛出去', async () => {
    const h = harness(at('2026-06-01T10:00:00Z'));
    vi.spyOn(h.rules, 'listDue').mockRejectedValueOnce(new Error('db gone'));
    await expect(h.scheduler.runOnce()).resolves.toBe(0);
  });
});

describe('AutomationScheduler —— 定时器的装与拆（03 §8.1 每分钟一轮）', () => {
  beforeEach(() => {
    vi.useRealTimers();
    delete process.env.DISABLE_AUTOMATION_SCHEDULER;
  });

  it('★ 装上的是「每分钟一次」，并且 `unref` 掉 —— 调度器不该把进程吊在事件循环上', () => {
    vi.useFakeTimers();
    try {
      const h = harness(at('2026-06-01T10:00:00Z'));
      const sweep = vi.spyOn(h.scheduler, 'runOnce').mockResolvedValue(0);
      h.scheduler.onApplicationBootstrap();

      // 59 秒还没到点
      vi.advanceTimersByTime(59_000);
      expect(sweep).toHaveBeenCalledTimes(0);
      // 第 60 秒第一轮；再过一分钟第二轮 —— 间隔是 60s，不是 30s 也不是 120s
      vi.advanceTimersByTime(1_000);
      expect(sweep).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(60_000);
      expect(sweep).toHaveBeenCalledTimes(2);

      expect(vi.getTimerCount()).toBe(1);
      h.scheduler.onModuleDestroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('★ 装完当场 `unref()` —— 调度器不该把进程吊在事件循环上', () => {
    // ⚠️ `vi.getTimerCount()` 证明不了这件事（它数的是待触发的定时器，ref 与否都数），
    // 所以这里直接看**那个 handle 上的 unref 被调了没有**。与 VolumeReaper /
    // CredentialRefreshScanner 同款：一个 ref 住的一分钟定时器会让进程永远退不出去。
    const parked = setInterval(() => undefined, 1_000_000);
    const unref = vi.fn(() => parked);
    const handle = Object.assign(parked, { unref });
    const setSpy = vi.spyOn(globalThis, 'setInterval').mockReturnValue(handle);
    try {
      const h = harness(at('2026-06-01T10:00:00Z'));
      h.scheduler.onApplicationBootstrap();
      expect(setSpy).toHaveBeenCalledTimes(1);
      // 间隔就是 03 §8.1 说的一分钟
      expect(setSpy.mock.calls[0][1]).toBe(60_000);
      expect(unref).toHaveBeenCalledTimes(1);
      h.scheduler.onModuleDestroy();
    } finally {
      setSpy.mockRestore();
      clearInterval(parked);
    }
  });

  it('★★ `onModuleDestroy` 之后定时器真的不再醒 —— `unref()` 替代不了 `clearInterval`', () => {
    vi.useFakeTimers();
    try {
      const h = harness(at('2026-06-01T10:00:00Z'));
      const sweep = vi.spyOn(h.scheduler, 'runOnce').mockResolvedValue(0);
      h.scheduler.onApplicationBootstrap();
      vi.advanceTimersByTime(60_000);
      expect(sweep).toHaveBeenCalledTimes(1); // 正向执行证据：它本来是会醒的

      h.scheduler.onModuleDestroy();
      vi.advanceTimersByTime(600_000); // 十分钟
      // ⚠️ 这条否定断言的价值全在上面那条正向证据上：没有它，「一次都没醒」也可能
      // 是因为定时器压根没装上。e2e 是 singleFork，35 个 spec 各起一次 AppModule，
      // 不清理就会有几十个指向**已关闭 DB** 的调度器同时醒来。
      expect(sweep).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
      // 幂等：再拆一次不炸（Nest 在某些路径上会重复调）
      h.scheduler.onModuleDestroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('DISABLE_AUTOMATION_SCHEDULER=1 ⇒ 一个定时器都不装', () => {
    vi.useFakeTimers();
    try {
      process.env.DISABLE_AUTOMATION_SCHEDULER = '1';
      const h = harness(at('2026-06-01T10:00:00Z'));
      const sweep = vi.spyOn(h.scheduler, 'runOnce').mockResolvedValue(0);
      h.scheduler.onApplicationBootstrap();
      vi.advanceTimersByTime(600_000);
      expect(sweep).toHaveBeenCalledTimes(0);
      expect(vi.getTimerCount()).toBe(0);

      // ★ 只有精确的 '1' 才关：一个 `!== '1'` 的写法会让 `DISABLE_…=0` 也把调度器关掉，
      // 而那正是「明明配了 0 却什么都不跑」这类静默故障的形状。
      process.env.DISABLE_AUTOMATION_SCHEDULER = '0';
      const h2 = harness(at('2026-06-01T10:00:00Z'));
      const sweep2 = vi.spyOn(h2.scheduler, 'runOnce').mockResolvedValue(0);
      h2.scheduler.onApplicationBootstrap();
      vi.advanceTimersByTime(60_000);
      expect(sweep2).toHaveBeenCalledTimes(1);
      h2.scheduler.onModuleDestroy();
    } finally {
      delete process.env.DISABLE_AUTOMATION_SCHEDULER;
      vi.useRealTimers();
    }
  });
});

describe('AutomationScheduler —— 通知是旁路，不是主干（03 §8.5）', () => {
  it('★★ 一次 webhook 投递炸了：run 照样落终态，且不产生 unhandled rejection', async () => {
    const h = harness(at('2026-06-01T10:00:00Z'));
    const rule = h.rules.seed(hourlyRule('aut-1', at('2026-06-01T09:00:00Z')));
    setDue(rule, at('2026-06-01T10:00:00Z'));
    h.breakDelivery();

    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown): void => {
      unhandled.push(e);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      h.launcher.phaseQueue = [{ kind: 'provisioning' }];
      await h.scheduler.runOnce();
      h.clock.advanceMinutes(1);
      h.launcher.phaseQueue = [{ kind: 'finished', status: 'success' }];
      await h.scheduler.runOnce();
      // 让 microtask + macrotask 都跑完，unhandled rejection 才会被报出来
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }

    // ★ 正向执行证据：投递确实被发起过（不是「没发所以没炸」）
    expect(h.notifications.runFinished).toHaveLength(1);
    // ★ run 的状态没有被一次失败的旁路投递改写
    expect([...h.runs.rows.values()][0].status).toBe('success');
    // ★★ 裸 `void aRejectingPromise` 在 Node 22 下会让进程退出 —— 那是这一行能造成的
    // 最贵的事故。必须 `.catch()`。
    expect(unhandled).toEqual([]);
  });

  it('★ 凭证过期这一发要发 webhook，而「上一发还在跑」不发（03 §8.2 行 1/2 的分工）', async () => {
    const expired = harness(at('2026-06-01T10:00:00Z'));
    const r1 = expired.rules.seed(hourlyRule('aut-1', at('2026-06-01T09:00:00Z')));
    setDue(r1, at('2026-06-01T10:00:00Z'));
    expired.credentials.state = 'expired';
    await expired.scheduler.runOnce();

    const skipped = [...expired.runs.rows.values()][0];
    expect(skipped.errorCode).toBe('AUTH_EXPIRED'); // 决策确实走到了行 2
    expect(expired.notifications.authExpired).toEqual([
      { automationId: 'aut-1', runId: skipped.id },
    ]);

    const busy = harness(at('2026-06-01T10:00:00Z'));
    const r2 = busy.rules.seed(hourlyRule('aut-2', at('2026-06-01T08:00:00Z')));
    setDue(r2, at('2026-06-01T10:00:00Z'));
    const prev = AutomationRun.pending(
      'run-prev',
      asAutomationId('aut-2'),
      at('2026-06-01T09:00:00Z'),
    );
    prev.markRunning('sbx-prev', at('2026-06-01T09:00:10Z'));
    busy.runs.seed(prev);
    busy.launcher.phaseQueue = [{ kind: 'running' }];
    await busy.scheduler.runOnce();

    // ★ 正向执行证据落在被断言那一步的**下游**：skip 分支真的落了一条 run，
    // 而 `afterAuthExpired` 就写在这条 run 落库之后的那一行。
    const busySkip = [...busy.runs.rows.values()].find((r) => r.status === 'skipped');
    expect(busySkip?.errorCode).toBe('PREVIOUS_RUNNING');
    expect(busy.notifications.authExpired).toEqual([]);
  });

  it('run 落终态 ⇒ 先问一次日志摘要，再通知 —— 摘要问的是这条 run 自己的 logPath', async () => {
    const h = harness(at('2026-06-01T10:00:00Z'));
    const rule = h.rules.seed(hourlyRule('aut-1', at('2026-06-01T09:00:00Z')));
    setDue(rule, at('2026-06-01T10:00:00Z'));
    h.launcher.phaseQueue = [{ kind: 'provisioning' }];
    await h.scheduler.runOnce();

    h.clock.advanceMinutes(1);
    h.launcher.phaseQueue = [
      { kind: 'finished', status: 'success', logPath: '/logs/run-1.jsonl', logBytes: 42 },
    ];
    await h.scheduler.runOnce();

    const run = [...h.runs.rows.values()][0];
    expect(run.status).toBe('success');
    // 摘要在 `attachLog` **之后**取，所以它拿得到刚落下的那条日志路径
    expect(h.notifications.summarizeArgs).toEqual(['/logs/run-1.jsonl']);
    expect(h.notifications.runFinished).toEqual([{ automationId: 'aut-1', runId: run.id }]);
    // 记账（recordOutcome）也各通知了一次状态变化
    expect(h.notifications.stateChanged).toEqual(['aut-1']);
  });
});

describe('AutomationScheduler —— 自动禁用要在审计里留下痕迹（13 §2.8.2）', () => {
  /** 连续跑 n 发失败的 Task。 */
  async function failTimes(h: Harness, n: number): Promise<void> {
    for (let i = 0; i < n; i += 1) {
      setDue(h.rules.rows.get('aut-1') as never, h.clock.now());
      h.launcher.phaseQueue = [{ kind: 'provisioning' }];
      await h.scheduler.runOnce();
      h.clock.advanceMinutes(1);
      h.launcher.phaseQueue = [{ kind: 'finished', status: 'failed', errorMessage: 'boom' }];
      await h.scheduler.runOnce();
      h.clock.advanceMinutes(30);
    }
  }

  it('★ 连续 10 次失败 ⇒ 规则被自动禁用，并落一条 automation.disabled 审计', async () => {
    const h = harness(at('2026-06-01T10:00:00Z'));
    h.rules.seed(hourlyRule('aut-1', at('2026-06-01T09:00:00Z')));
    await failTimes(h, 10);

    const rule = h.rules.rows.get('aut-1');
    expect(rule?.failureCount).toBe(10);
    expect(rule?.enabled).toBe(false);

    // 一条，且只有一条 —— 每一轮都记会把审计流刷成噪音
    const disabled = h.audit.records.filter(
      (r) => (r as { type?: string }).type === 'automation.disabled',
    );
    expect(disabled).toHaveLength(1);
    expect(disabled[0]).toMatchObject({
      category: 'project',
      actor: 'scheduler',
      subjectType: 'automation',
      subjectId: 'aut-1',
      outcome: 'failed',
      detail: { projectId: 'prj-1', failureCount: 10 },
    });
  });

  it('★ 还没到 10 次（规则仍 enabled）⇒ 一条 automation.disabled 都不记', async () => {
    const h = harness(at('2026-06-01T10:00:00Z'));
    h.rules.seed(hourlyRule('aut-1', at('2026-06-01T09:00:00Z')));
    await failTimes(h, 9);

    // 正向证据：这 9 发确实都跑到了记账那一步
    expect(h.rules.rows.get('aut-1')?.failureCount).toBe(9);
    expect(h.rules.rows.get('aut-1')?.enabled).toBe(true);
    expect(h.notifications.stateChanged).toHaveLength(9);
    expect(
      h.audit.records.filter((r) => (r as { type?: string }).type === 'automation.disabled'),
    ).toEqual([]);
  });
});

describe('AutomationScheduler —— 补扫的两个边角（03 §8.1 ④）', () => {
  it('★ 规则已被删的孤儿 run：标掉 outcome_applied 就走，不炸也不记一次失败', async () => {
    const h = harness(at('2026-06-01T10:00:00Z'));
    // 库里**没有** aut-gone 这条规则 —— CASCADE 删除的竞态窗口里留下的残影
    const orphan = AutomationRun.pending(
      'run-orphan',
      asAutomationId('aut-gone'),
      at('2026-06-01T09:00:00Z'),
    );
    orphan.markRunning('sbx-x', at('2026-06-01T09:00:10Z'));
    orphan.finalize('failed', at('2026-06-01T09:05:00Z'), { errorMessage: 'crashed' });
    h.runs.seed(orphan);

    await expect(h.scheduler.runOnce()).resolves.toBe(0); // 它不算「动了一条」
    // ★ 但它被标掉了 —— 否则下一轮、再下一轮，永远扫得到它
    expect(h.runs.rows.get('run-orphan')?.outcomeApplied).toBe(true);
    // 没有规则可记账 ⇒ 一条通知都不该发
    expect(h.notifications.stateChanged).toEqual([]);
  });

  it('一轮最多补扫 100 条 —— 一次大规模崩溃不该把单轮撑爆', async () => {
    const h = harness(at('2026-06-01T10:00:00Z'));
    const spy = vi.spyOn(h.runs, 'listOutcomePending');
    await h.scheduler.runOnce();
    expect(spy).toHaveBeenCalledWith(100);
  });
});

describe('AutomationScheduler —— 日志体积被夹在 I-AUR-4 的上限内', () => {
  async function finishWith(phase: {
    logPath?: string;
    logBytes?: number;
  }): Promise<{ logPath: string | null; logBytes: number | null }> {
    const h = harness(at('2026-06-01T10:00:00Z'));
    const rule = h.rules.seed(hourlyRule('aut-1', at('2026-06-01T09:00:00Z')));
    setDue(rule, at('2026-06-01T10:00:00Z'));
    h.launcher.phaseQueue = [{ kind: 'provisioning' }];
    await h.scheduler.runOnce();
    h.clock.advanceMinutes(1);
    h.launcher.phaseQueue = [{ kind: 'finished', status: 'success', ...phase }];
    await h.scheduler.runOnce();
    const run = [...h.runs.rows.values()][0];
    return { logPath: run.logPath, logBytes: run.logBytes };
  }

  it('★ provider 报上来一个超过 30MB 的体积 ⇒ 夹到 30MB，而不是原样写进库', async () => {
    // 超限的体积会被聚合拒绝（I-AUR-4），于是「一条日志太大」会变成「这条 run 落不了
    // 终态」—— 夹住它是让大日志退化成截断，而不是让整条 run 卡死。
    expect(await finishWith({ logPath: '/logs/a.jsonl', logBytes: 99_999_999 })).toEqual({
      logPath: '/logs/a.jsonl',
      logBytes: 31_457_280,
    });
  });

  it('provider 没报体积 ⇒ 记 0（有路径没大小是常态，不是错误）', async () => {
    expect(await finishWith({ logPath: '/logs/a.jsonl' })).toEqual({
      logPath: '/logs/a.jsonl',
      logBytes: 0,
    });
  });

  it('没有 logPath ⇒ 一个字段都不挂上去', async () => {
    expect(await finishWith({})).toEqual({ logPath: null, logBytes: null });
  });
});

describe('AutomationScheduler —— missed 阈值可调（03 §8.2）', () => {
  const original = process.env.AUTOMATION_MISSED_THRESHOLD_MIN;
  const restore = (): void => {
    if (original === undefined) delete process.env.AUTOMATION_MISSED_THRESHOLD_MIN;
    else process.env.AUTOMATION_MISSED_THRESHOLD_MIN = original;
  };
  beforeEach(restore);

  /** 让一条规则「已经过期 N 分钟」，返回这一轮为它落下的 run 的状态。 */
  async function fireOverdueBy(minutes: number): Promise<string> {
    const now = at('2026-06-01T10:00:00Z');
    const h = harness(now);
    const rule = h.rules.seed(hourlyRule('aut-1', at('2026-06-01T07:00:00Z')));
    setDue(rule, new Date(now.getTime() - minutes * 60_000));
    await h.scheduler.runOnce();
    return [...h.runs.rows.values()][0].status;
  }

  it('★ 阈值放宽到 120min ⇒ 过期 90 分钟不再算 missed，照常触发', async () => {
    try {
      process.env.AUTOMATION_MISSED_THRESHOLD_MIN = '120';
      expect(await fireOverdueBy(90)).toBe('running');
    } finally {
      restore();
    }
  });

  it('★★ 配了个不能用的值 ⇒ 回落到默认 5min —— 不是 0，也不是 NaN', async () => {
    // ⚠️ 「过期 90 分钟仍判 missed」这一条**区分不出**阈值是 5 还是 0 —— 两个值下
    // 它都 missed。能区分的是**过期 3 分钟**：默认 5min 时它正常触发，阈值一旦
    // 静默变成 0（`Number('')` 就是 0），它会被判成 missed 而**永远不补跑**。
    for (const bad of ['', 'abc', '0', '-30']) {
      process.env.AUTOMATION_MISSED_THRESHOLD_MIN = bad;
      expect(await fireOverdueBy(3), `${bad} 应回落到 5min`).toBe('running');
      expect(await fireOverdueBy(90), `${bad} 应回落到 5min`).toBe('missed');
    }
    restore();
    expect(await fireOverdueBy(3)).toBe('running');
    expect(await fireOverdueBy(90)).toBe('missed');
  });

  it('★ 一个溢出成 Infinity 的值同样回落 —— 否则 missed 分支永远不可达', async () => {
    // `Number('1e999')` 是 Infinity，而 `Infinity > 0` 为真：少了 `isFinite` 这一半，
    // 阈值就变成无穷大，宕机多久都不会被记成 missed，规则会去补跑一个几小时前的槽。
    try {
      process.env.AUTOMATION_MISSED_THRESHOLD_MIN = '1e999';
      expect(await fireOverdueBy(90)).toBe('missed');
    } finally {
      restore();
    }
  });
});

describe('AutomationScheduler —— 一条规则出问题不带走整批（fireDue 的 try/catch）', () => {
  it('★ 第一条规则取数就炸 ⇒ 第二条照样触发，runOnce 返回 1', async () => {
    const h = harness(at('2026-06-01T10:00:00Z'));
    const bad = h.rules.seed(hourlyRule('aut-bad', at('2026-06-01T09:00:00Z')));
    const good = h.rules.seed(hourlyRule('aut-good', at('2026-06-01T09:00:00Z')));
    setDue(bad, at('2026-06-01T10:00:00Z'));
    setDue(good, at('2026-06-01T10:00:00Z'));
    const realFindLatest = h.runs.findLatest.bind(h.runs);
    vi.spyOn(h.runs, 'findLatest').mockImplementation((id) =>
      id === 'aut-bad' ? Promise.reject(new Error('db hiccup')) : realFindLatest(id),
    );

    await expect(h.scheduler.runOnce()).resolves.toBe(1);

    expect(h.launcher.created.map((c) => c.automationId)).toEqual(['aut-good']);
    // 炸掉的那条没有留下任何 run —— 它在决策之前就断了
    expect([...h.runs.rows.values()].every((r) => r.automationId === 'aut-good')).toBe(true);
    // ⚠️ 并且它的 `next_trigger_at` **停在原地**。`fireDue` 的 catch 上那句
    // 「它的 next_trigger_at 已经推进过了」只对**推进之后**才抛的失败成立；
    // `findLatest` / `phaseOf` / `stateOf` / `capacityFor` 这四步都在推进之前。
    // 这一条不是 I-AUT-8 的破口：推进之前抛意味着**一条 run 都没落**，所以不会
    // 「一分钟一发」，只是下一轮再试一次；等外部恢复时若已过阈值，decide 会把它
    // 判成 missed 并在那时推进。钉住现状，免得下次有人按注释去读代码。
    expect(h.rules.rows.get('aut-bad')?.nextTriggerAt?.toISOString()).toBe(
      '2026-06-01T10:00:00.000Z',
    );
  });

  it('★ 推进之后才抛的失败：`next_trigger_at` 确实已经落库了（I-AUT-8 覆盖的那一半）', async () => {
    const h = harness(at('2026-06-01T10:00:00Z'));
    const rule = h.rules.seed(hourlyRule('aut-1', at('2026-06-01T09:00:00Z')));
    setDue(rule, at('2026-06-01T10:00:00Z'));
    // 决策已经做完、规则也已推进，写 run 的那一刻炸 —— 这正是 I-AUT-8 说的场景
    vi.spyOn(h.runs, 'saveSync').mockImplementation(() => {
      throw new Error('disk full');
    });

    await expect(h.scheduler.runOnce()).resolves.toBe(0);

    expect(h.rules.rows.get('aut-1')?.nextTriggerAt?.toISOString()).toBe(
      '2026-06-01T11:00:00.000Z',
    );
    // 正向执行证据：确实走到了「推进之后」—— 规则的 lastTriggeredAt 也动了
    expect(h.rules.rows.get('aut-1')?.lastTriggeredAt?.toISOString()).toBe(
      '2026-06-01T10:00:00.000Z',
    );
  });
});

describe('AutomationScheduler —— 相位机只问「有沙箱的」在飞 run', () => {
  it('★ 一条还没拿到 sandboxId 的 pending run：`phaseOf` 一次都不问，也不被推进', async () => {
    const h = harness(at('2026-06-01T10:00:00Z'));
    const rule = h.rules.seed(hourlyRule('aut-1', at('2026-06-01T09:00:00Z')));
    setDue(rule, at('2026-06-01T12:00:00Z')); // 本轮不到期：只看相位机
    h.runs.seed(
      AutomationRun.pending('run-nosbx', asAutomationId('aut-1'), at('2026-06-01T09:00:00Z')),
    );
    const phaseOf = vi.spyOn(h.launcher, 'phaseOf');

    await expect(h.scheduler.runOnce()).resolves.toBe(0);

    // 拿 `null` 去问 provider 相位是一次必然失败的调用；这条 run 还在等沙箱，
    // 它的下一步是**创建**而不是**推进**。
    expect(phaseOf).not.toHaveBeenCalled();
    expect(h.runs.rows.get('run-nosbx')?.status).toBe('pending');
  });

  it('沙箱还在 provisioning / running ⇒ 这一轮什么都不动', async () => {
    for (const kind of ['provisioning', 'running'] as const) {
      const h = harness(at('2026-06-01T10:00:00Z'));
      const rule = h.rules.seed(hourlyRule('aut-1', at('2026-06-01T09:00:00Z')));
      setDue(rule, at('2026-06-01T12:00:00Z'));
      const run = AutomationRun.pending(
        'run-1',
        asAutomationId('aut-1'),
        at('2026-06-01T09:00:00Z'),
      );
      run.markRunning('sbx-1', at('2026-06-01T09:00:10Z'));
      h.runs.seed(run);
      h.launcher.phaseQueue = [{ kind }];

      await expect(h.scheduler.runOnce()).resolves.toBe(0);

      // 正向证据：相位确实被问过了（不是「没走到这里所以没动」）
      expect(h.runs.rows.get('run-1')?.status).toBe('running');
      expect(h.launcher.started).toEqual([]);
      expect(h.notifications.runFinished).toEqual([]);
    }
  });
});

describe('AutomationScheduler —— 记账那一笔必须真的落库、真的发事件', () => {
  it('★★ run 的终态与规则的失败计数是**写进去的**，不只是改在内存里', async () => {
    const h = harness(at('2026-06-01T10:00:00Z'));
    const rule = h.rules.seed(hourlyRule('aut-1', at('2026-06-01T09:00:00Z')));
    setDue(rule, at('2026-06-01T10:00:00Z'));
    h.launcher.phaseQueue = [{ kind: 'provisioning' }];
    await h.scheduler.runOnce();
    h.clock.advanceMinutes(1);
    h.launcher.phaseQueue = [{ kind: 'finished', status: 'failed', errorMessage: 'boom' }];
    await h.scheduler.runOnce();

    const run = [...h.runs.rows.values()][0];
    // ⚠️ 内存里的对象和库里的行是**同一个引用**，所以 `rows.get(id).status` 证明不了
    // 「写过库」。快照里必须有那一笔带着终态 + outcomeApplied 的写。
    expect(h.runs.saveLog).toContainEqual({
      id: run.id,
      status: 'failed',
      outcomeApplied: true,
    });
    // 规则那一侧同理：`saveLog` 里必须有推进后的 next_trigger_at
    expect(h.rules.saveLog.map((r) => r.nextTriggerAt)).toContain('2026-06-01T11:00:00.000Z');
  });

  it('★ 一次触发发 AutomationTriggered，落终态时发 AutomationRunFinished（同一个事务里）', async () => {
    const h = harness(at('2026-06-01T10:00:00Z'));
    const rule = h.rules.seed(hourlyRule('aut-1', at('2026-06-01T09:00:00Z')));
    setDue(rule, at('2026-06-01T10:00:00Z'));
    h.launcher.phaseQueue = [{ kind: 'provisioning' }];
    await h.scheduler.runOnce();
    h.clock.advanceMinutes(1);
    h.launcher.phaseQueue = [{ kind: 'finished', status: 'success' }];
    await h.scheduler.runOnce();

    const run = [...h.runs.rows.values()][0];
    expect(h.events.published.map((e) => e.type)).toEqual([
      'AutomationTriggered',
      'AutomationRunFinished',
    ]);
    expect(h.events.published[1]).toMatchObject({
      automationId: 'aut-1',
      name: 'rule-aut-1',
      runId: run.id,
      status: 'success',
    });
  });
});

describe('AutomationScheduler —— 「上一发还在跑吗」的判据（决策表行 1）', () => {
  /**
   * 造一条**非终态、但相位机不会去碰**的上一发 run —— `resource-exhausted` 且
   * `retry_at` 还没到（这正是 `queueOrGiveUp` 走后台那一半留下的形状：沙箱建出来过，
   * 撞上容量之后排队重试）。它是唯一能让 `isPreviousStillGoing` 真正走到「问相位」
   * 那一步的局面：`pending`/`running` 会先被 `advanceInFlight` 推成终态，
   * 于是判据在第一行就返回了。
   */
  function harnessWithQueuedPrevious(): Harness {
    const h = harness(at('2026-06-01T10:00:00Z'));
    const rule = h.rules.seed(hourlyRule('aut-1', at('2026-06-01T08:00:00Z')));
    setDue(rule, at('2026-06-01T10:00:00Z'));
    const prev = AutomationRun.pending(
      'run-prev',
      asAutomationId('aut-1'),
      at('2026-06-01T09:00:00Z'),
    );
    prev.markRunning('sbx-prev', at('2026-06-01T09:00:10Z'));
    prev.queueRetry(at('2026-06-01T10:00:00Z')); // retry_at = 10:24，本轮捞不到
    h.runs.seed(prev);
    return h;
  }

  it('★ 非终态但**还没有沙箱** ⇒ 算「还在跑」，这一发跳过', async () => {
    // 最容易写漏的一条：把「没有 sandboxId」当成 false，会让一条每小时的规则在沙箱
    // 冷启动的那几分钟里被再触发一次 —— 两个 agent 同时改同一个工作区。
    const h = harness(at('2026-06-01T10:00:00Z'));
    const rule = h.rules.seed(hourlyRule('aut-1', at('2026-06-01T08:00:00Z')));
    setDue(rule, at('2026-06-01T10:00:00Z'));
    const prev = AutomationRun.pending(
      'run-prev',
      asAutomationId('aut-1'),
      at('2026-06-01T09:00:00Z'),
    );
    prev.queueRetry(at('2026-06-01T10:00:00Z'));
    h.runs.seed(prev);

    await h.scheduler.runOnce();

    expect([...h.runs.rows.values()].find((r) => r.status === 'skipped')?.errorCode).toBe(
      'PREVIOUS_RUNNING',
    );
    expect(h.launcher.created).toHaveLength(0);
  });

  it('上一发有沙箱、相位仍在跑 ⇒ 跳过', async () => {
    const h = harnessWithQueuedPrevious();
    h.launcher.phaseQueue = [{ kind: 'running' }];
    await h.scheduler.runOnce();
    expect([...h.runs.rows.values()].find((r) => r.status === 'skipped')?.errorCode).toBe(
      'PREVIOUS_RUNNING',
    );
    expect(h.launcher.created).toHaveLength(0);
  });

  it('★★ 相位是 `gone` 或 `finished` ⇒ 上一发已经结束，这一发照常触发', async () => {
    // ⚠️ 两个相位都是「已经结束」的写法。把它们当成「还在跑」，规则会在沙箱消失之后
    // 永远跳过 —— 而 `PREVIOUS_RUNNING` 的判据正是「上一条非终态」，那条 run 也永远
    // 不会被推进。一个只有靠人去看库才能发现的自锁。
    for (const kind of ['gone', 'finished'] as const) {
      const h = harnessWithQueuedPrevious();
      h.launcher.phaseQueue = [
        kind === 'finished' ? { kind: 'finished', status: 'success' } : { kind: 'gone' },
      ];
      await h.scheduler.runOnce();
      expect(
        [...h.runs.rows.values()].some((r) => r.status === 'skipped'),
        kind,
      ).toBe(false);
      expect(h.launcher.created, kind).toHaveLength(1);
    }
  });

  it('上一发已经是终态 ⇒ 连相位都不问', async () => {
    const h = harness(at('2026-06-01T10:00:00Z'));
    const rule = h.rules.seed(hourlyRule('aut-1', at('2026-06-01T08:00:00Z')));
    setDue(rule, at('2026-06-01T10:00:00Z'));
    h.runs.seed(
      AutomationRun.missed('run-prev', asAutomationId('aut-1'), 'x', at('2026-06-01T09:00:00Z')),
    );
    const phaseOf = vi.spyOn(h.launcher, 'phaseOf');

    await h.scheduler.runOnce();

    expect(h.launcher.created).toHaveLength(1);
    expect(phaseOf).not.toHaveBeenCalled();
  });

  it('★★ I-AUT-10：上一发在**这一轮**里刚落成 failed ⇒ 本轮那个到期的槽仍然留下一行', async () => {
    // 这里曾经是一处真缺陷（29 §3.3.2b-5 交回，本轮已修）：`advanceInFlight` 先把上一发
    // 推成 `failed` ⇒ `recordOutcome('failed')` 在 `automation.entity` 里**顺手重算了
    // `next_trigger_at`**（那行本是为降频/禁用写的）⇒ 紧接着的 `fireDue` 用
    // `listDue(now)`（判据 `next_trigger_at <= now`）已经取不到这条规则 ⇒ 10:00 这个槽
    // 既没有触发、也没有 `skipped`/`missed`，历史里是一个**没有任何行**的空洞。
    // 现在普通失败不动槽位（I-AUT-10），这一槽照常被取到并走完决策表。
    const h = harness(at('2026-06-01T10:00:00Z'));
    const rule = h.rules.seed(hourlyRule('aut-1', at('2026-06-01T08:00:00Z')));
    setDue(rule, at('2026-06-01T10:00:00Z'));
    const prev = AutomationRun.pending(
      'run-prev',
      asAutomationId('aut-1'),
      at('2026-06-01T09:00:00Z'),
    );
    prev.markRunning('sbx-prev', at('2026-06-01T09:00:10Z'));
    h.runs.seed(prev);
    h.launcher.phaseQueue = [{ kind: 'gone' }]; // ⇒ 上一发落 failed

    await h.scheduler.runOnce();

    expect(h.runs.rows.get('run-prev')?.status).toBe('failed');
    // ★ 10:00 那个槽有了自己的一行 —— 上一发已经终态，决策表走到行 4：真触发
    const forThisSlot = [...h.runs.rows.values()].filter((r) => r.id !== 'run-prev');
    expect(forThisSlot).toHaveLength(1);
    expect(forThisSlot[0].status).toBe('running');
    expect(h.launcher.created).toHaveLength(1);
    // 推进发生在**触发那一刻**（I-AUT-8），不是发生在记账那一刻
    expect(h.rules.rows.get('aut-1')?.nextTriggerAt?.toISOString()).toBe(
      '2026-06-01T11:00:00.000Z',
    );
  });

  it('★★ I-AUT-10 三路对齐：上一发 failed / success / 还在跑 —— 10:00 那个槽**都**恰好留下一行', async () => {
    // 这条是不变量本身：三条路径此前给出三种历史（触发 / 触发 / 什么都没有），
    // 现在只剩「留下恰好一行」这一种形状，区别只在那一行是什么。
    const cases = [
      { name: 'failed', phase: { kind: 'gone' } as const, status: 'running', created: 1 },
      {
        name: 'success',
        phase: { kind: 'finished', status: 'success' } as const,
        status: 'running',
        created: 1,
      },
      { name: '还在跑', phase: { kind: 'running' } as const, status: 'skipped', created: 0 },
    ];

    for (const c of cases) {
      const h = harness(at('2026-06-01T10:00:00Z'));
      const rule = h.rules.seed(hourlyRule('aut-1', at('2026-06-01T08:00:00Z')));
      setDue(rule, at('2026-06-01T10:00:00Z'));
      const prev = AutomationRun.pending(
        'run-prev',
        asAutomationId('aut-1'),
        at('2026-06-01T09:00:00Z'),
      );
      prev.markRunning('sbx-prev', at('2026-06-01T09:00:10Z'));
      h.runs.seed(prev);
      h.launcher.phaseQueue = [c.phase];

      await h.scheduler.runOnce();

      const forThisSlot = [...h.runs.rows.values()].filter((r) => r.id !== 'run-prev');
      expect(forThisSlot, c.name).toHaveLength(1);
      expect(forThisSlot[0].status, c.name).toBe(c.status);
      expect(h.launcher.created, c.name).toHaveLength(c.created);
      // 三条路径的 next_trigger_at 也对齐：都被推进过恰好一次
      expect(h.rules.rows.get('aut-1')?.nextTriggerAt?.toISOString(), c.name).toBe(
        '2026-06-01T11:00:00.000Z',
      );
    }
  });

  it('★★ I-AUT-10：那一发失败**恰好把规则打进降频**时，到期的槽也还在', async () => {
    // 最刁的一格：`recordOutcome` 这一次真的翻转了状态（failureCount 2 → 3 ⇒ degraded），
    // 「频率变了要重算」在这里是成立的 —— 但重算不许吃掉一个**已经到期**的槽。
    // 降频由这一槽触发时的 `advanceTrigger` 兑现：下一次从每小时变成每天 00:00。
    const h = harness(at('2026-06-01T10:00:00Z'));
    const rule = h.rules.seed(hourlyRule('aut-1', at('2026-06-01T08:00:00Z')));
    rule.recordOutcome('failed', at('2026-06-01T08:30:00Z'));
    rule.recordOutcome('failed', at('2026-06-01T09:30:00Z'));
    setDue(rule, at('2026-06-01T10:00:00Z'));
    const prev = AutomationRun.pending(
      'run-prev',
      asAutomationId('aut-1'),
      at('2026-06-01T09:00:00Z'),
    );
    prev.markRunning('sbx-prev', at('2026-06-01T09:00:10Z'));
    h.runs.seed(prev);
    h.launcher.phaseQueue = [{ kind: 'gone' }];

    await h.scheduler.runOnce();

    expect(h.rules.rows.get('aut-1')?.failureCount).toBe(3);
    expect(h.rules.rows.get('aut-1')?.degraded).toBe(true);
    // ★ 槽没被降频吃掉：它照常触发了
    expect(h.launcher.created).toHaveLength(1);
    expect([...h.runs.rows.values()].filter((r) => r.id !== 'run-prev')).toHaveLength(1);
    // ★ 而降频确实生效了 —— 下一次是次日 00:00 而不是 11:00
    expect(h.rules.rows.get('aut-1')?.nextTriggerAt?.toISOString()).toBe(
      '2026-06-02T00:00:00.000Z',
    );
  });
});

describe('AutomationScheduler —— createSandbox 抛的不是「没资源」时', () => {
  it('★ 普通异常 ⇒ 这一发当场落 failed（带上原始 message），并计入失败计数', async () => {
    const h = harness(at('2026-06-01T10:00:00Z'));
    const rule = h.rules.seed(hourlyRule('aut-1', at('2026-06-01T09:00:00Z')));
    setDue(rule, at('2026-06-01T10:00:00Z'));
    h.launcher.createBehaviour = () => {
      throw new Error('provider refused the handle');
    };

    await h.scheduler.runOnce();

    const run = [...h.runs.rows.values()][0];
    expect(run.status).toBe('failed');
    // ⚠️ 与「资源不足」分道扬镳的地方：那一条排队重试、**不**计失败；这一条两样都反过来。
    expect(run.retryCount).toBe(0);
    expect(run.errorMessage).toBe('provider refused the handle');
    expect(h.rules.rows.get('aut-1')?.failureCount).toBe(1);
    // 落终态就要通知（否则 webhook 订阅者永远等不到这一发的结局）
    expect(h.notifications.runFinished).toEqual([{ automationId: 'aut-1', runId: run.id }]);
  });
});

describe('AutomationScheduler —— 相位机回来的那条 run 的细节', () => {
  async function finishedWith(phase: {
    status: 'success' | 'failed';
    errorMessage?: string;
  }): Promise<AutomationRun> {
    const h = harness(at('2026-06-01T10:00:00Z'));
    const rule = h.rules.seed(hourlyRule('aut-1', at('2026-06-01T09:00:00Z')));
    setDue(rule, at('2026-06-01T12:00:00Z')); // 本轮不到期，只跑相位机
    const run = AutomationRun.pending('run-1', asAutomationId('aut-1'), at('2026-06-01T09:00:00Z'));
    run.markRunning('sbx-1', at('2026-06-01T09:00:10Z'));
    h.runs.seed(run);
    h.launcher.phaseQueue = [{ kind: 'finished', ...phase }];
    await h.scheduler.runOnce();
    return h.runs.rows.get('run-1') as AutomationRun;
  }

  it('★ provider 报了 errorMessage ⇒ 原样落在 run 上；没报 ⇒ 字段留空而不是空串', async () => {
    expect((await finishedWith({ status: 'failed', errorMessage: 'exit 137' })).errorMessage).toBe(
      'exit 137',
    );
    // ⚠️ 空串与 null 在前端是两件事：null ⇒ 渲染兜底文案，'' ⇒ 渲染一行空白。
    expect((await finishedWith({ status: 'failed' })).errorMessage).toBeNull();
    expect((await finishedWith({ status: 'success' })).errorMessage).toBeNull();
  });

  it('★ 还停在 pending 的 run 直接看到终态 ⇒ 先补一次 markRunning，startedAt 不能是空的', async () => {
    // 沙箱起得快时，一轮之内 pending → finished 是常态。少了这一步，run 落终态时
    // `started_at` 是 NULL，历史里那一条的「跑了多久」就永远算不出来。
    const h = harness(at('2026-06-01T10:00:00Z'));
    const rule = h.rules.seed(hourlyRule('aut-1', at('2026-06-01T09:00:00Z')));
    setDue(rule, at('2026-06-01T12:00:00Z'));
    const run = AutomationRun.pending('run-1', asAutomationId('aut-1'), at('2026-06-01T09:00:00Z'));
    // 有沙箱、但还没被 markRunning（`tryStartSandbox` 之后进程就崩了）
    Object.defineProperty(run, '_sandboxId', { value: 'sbx-1', writable: true });
    h.runs.seed(run);
    h.launcher.phaseQueue = [{ kind: 'finished', status: 'success' }];

    await h.scheduler.runOnce();

    const stored = h.runs.rows.get('run-1');
    expect(stored?.status).toBe('success');
    expect(stored?.startedAt).toBeInstanceOf(Date);
  });
});
