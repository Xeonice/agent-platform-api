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

function silentNotifier(): AutomationNotifier {
  const stub: NotifierSurface = {
    summarize: () => Promise.resolve(undefined),
    afterRunFinished: () => Promise.resolve(),
    afterAuthExpired: () => Promise.resolve(),
    afterStateChange: () => Promise.resolve(),
  };
  return stub as AutomationNotifier;
}

interface Harness {
  scheduler: AutomationScheduler;
  rules: InMemoryAutomationRepo;
  runs: InMemoryRunRepo;
  launcher: FakeLauncher;
  credentials: FakeCredentials;
  clock: FakeClock;
  events: RecordingEventBus;
}

function harness(now: Date): Harness {
  const rules = new InMemoryAutomationRepo();
  const runs = new InMemoryRunRepo();
  const launcher = new FakeLauncher();
  const credentials = new FakeCredentials('active');
  const clock = new FakeClock(now);
  const events = new RecordingEventBus();
  const scheduler = new AutomationScheduler(
    rules,
    runs,
    launcher,
    credentials,
    new SyncUow(),
    events,
    clock,
    new SeqIds(),
    new NoopAudit(),
    silentNotifier(),
  );
  return { scheduler, rules, runs, launcher, credentials, clock, events };
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
