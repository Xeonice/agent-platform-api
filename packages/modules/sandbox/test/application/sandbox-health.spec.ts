import { beforeEach, describe, it, expect } from 'vitest';
import { asProjectId, asSandboxId, type SandboxId } from '@platform/shared-kernel';
import { Sandbox } from '../../src/domain/entities/sandbox.entity';
import { harness, waitForStatus } from './_harness';

/**
 * 运行期健康探针（03 §7.8「`running` 不许再撒谎」）。
 *
 * ── 这条链路要证明的两件事 ──────────────────────────────────────────────────────
 * ① **翻转的是 `health.state`，`status` 一个字都不动。** 03 §7.8 此前写的是
 *    「`status: running → unhealthy`」——那句话与本仓自己的契约冲突，而且挡住过一次
 *    实现（「要加第 13 个状态、跨仓枚举变更」被判为前置门槛）。
 * ② **分层**：常态只用零成本信号；出现异常迹象才进沙箱做**一次**最小 exec；连续 3 次
 *    确认失败才翻。⛔ 探测命令**不得**是 runtime CLI —— `codex --version` 那一次把整个
 *    沙箱的 agent 打挂了。
 *
 * ── 每组断言钉住的变异 ──────────────────────────────────────────────────────────
 *  Ⓐ 把翻转写成 `sandbox.transitionTo('unhealthy')`/改 `status` ⇒「status 仍是 running」红。
 *  Ⓑ 去掉 `FLIP_AFTER_CONSECUTIVE_FAILURES`（一次失败就翻）⇒「第 1/2 次还不翻」红。
 *  Ⓒ 异常迹象后不做数据面确认、直接翻 ⇒「数据面能用就不翻」红（那正是 aio HEALTHCHECK
 *     误报的场景）。
 *  Ⓓ 每次采样都记审计 ⇒「只在翻转时记」红（一天 2880 条噪音）。
 *  Ⓔ 探测命令换成 runtime CLI ⇒「argv 是 /bin/true」红。
 *  Ⓕ `confirmDataPlane` 把非 0 / 无退出码读成成功 ⇒ 对应两条红。
 *  Ⓖ `inspect()`/`spawn()` 的 catch 去掉 ⇒「探测异常不冒泡」红。
 *  Ⓗ `execErrorsTotal` 用绝对值而不是增长 ⇒「累计非零但没涨 ⇒ 不算迹象」红。
 */
describe('SandboxHealthMonitor（03 §7.8）', () => {
  let h: ReturnType<typeof harness>;
  let id: string;

  beforeEach(async () => {
    h = harness();
    const dto = await h.service.create({ projectId: 'prj-1', runtime: 'claude-code' });
    await waitForStatus(h.service, dto.id, 'running');
    id = dto.id;
    h.provider.calls.length = 0;
    h.provider.execCalls.length = 0;
    h.auditRecords.length = 0;
  });

  const healthOf = async (): Promise<Record<string, unknown> | undefined> => {
    const [dto] = await h.service.list();
    return dto.health as Record<string, unknown> | undefined;
  };
  const statusOf = async (): Promise<string> => (await h.service.list())[0].status;
  const healthAudits = () => h.auditRecords.filter((r) => r.type === 'sandbox.health');

  it('还没采过样 ⇒ DTO 上**没有** health 字段（缺席 ≠ unhealthy，老客户端行为不变）', async () => {
    expect(await healthOf()).toBeUndefined();
  });

  it('零成本信号正常且 provider 明确报 healthy ⇒ healthy，**不进沙箱**、**不记审计**', async () => {
    h.provider.inspectResult = {
      lifecycleState: 'instance_running',
      health: { state: 'healthy', lastCheckedAt: 'x', consecutiveFailures: 0 },
    };
    await h.healthMonitor.runOnce();

    expect((await healthOf())?.state).toBe('healthy');
    // ★ 常态一次 exec 都不做 —— 「探测的代价」是这一节的第一个问题
    expect(h.provider.execCalls).toEqual([]);
    // ★ 常态不写审计：一个长命沙箱一天 2880 条会把审计流冲垮
    expect(healthAudits()).toEqual([]);
  });

  it('★ Ⓒ 零成本层报异常，但数据面确认能用 ⇒ 仍是 healthy，不翻', async () => {
    // 这就是 aio 镜像 HEALTHCHECK 的形状：它探 8091+9222，比平台的关心面更严格。
    h.provider.inspectResult = {
      lifecycleState: 'instance_running',
      health: { state: 'unhealthy', lastCheckedAt: 'x', consecutiveFailures: 9 },
    };
    await h.healthMonitor.runOnce();

    expect((await healthOf())?.state).toBe('healthy');
    expect((await healthOf())?.consecutiveFailures).toBe(0);
    expect(h.provider.execCalls).toHaveLength(1); // 确认了一次，但没翻
    expect(healthAudits()).toEqual([]);
  });

  it('★ Ⓔ 探测命令是 `/bin/true`，绝不是 runtime CLI', async () => {
    h.provider.inspectResult = {
      lifecycleState: 'instance_running',
      health: { state: 'unhealthy', lastCheckedAt: 'x', consecutiveFailures: 1 },
    };
    await h.healthMonitor.runOnce();

    expect(h.provider.execCalls).toEqual([['/bin/true']]);
    const joined = h.provider.execCalls.flat().join(' ');
    // ⛔ 那一次 `codex --version` 把被检查的对象摧毁了
    expect(joined).not.toMatch(/codex|claude|--version/);
  });

  it('★ Ⓐ+Ⓑ+Ⓓ 连续 3 次确认失败才翻；status 全程是 running；审计只有翻转那一条', async () => {
    h.provider.inspectResult = {
      lifecycleState: 'instance_running',
      health: { state: 'unhealthy', lastCheckedAt: 'x', consecutiveFailures: 1 },
    };
    h.provider.execExitCodes = [{ match: /bin\/true/, exitCode: 1 }];

    await h.healthMonitor.runOnce();
    expect((await healthOf())?.state).toBe('unknown'); // 一次失败还不构成「不健康」这个断言
    expect((await healthOf())?.consecutiveFailures).toBe(1);

    await h.healthMonitor.runOnce();
    expect((await healthOf())?.state).toBe('unknown');
    expect((await healthOf())?.consecutiveFailures).toBe(2);

    await h.healthMonitor.runOnce();
    expect((await healthOf())?.state).toBe('unhealthy');
    expect((await healthOf())?.consecutiveFailures).toBe(3);

    // ★★ 全程 `running` —— `SANDBOX_STATUSES` 那 12 个取值一个都没动
    expect(await statusOf()).toBe('running');

    // ★ 审计**只有翻转那一条**：第一次观测（`unknown`）不记 —— 每个沙箱开机写一行
    // 「健康度：unknown」就是这一节明令要避免的噪音；第 2 次「还是 unknown」也不记。
    const audits = healthAudits();
    expect(audits.map((a) => a.detail?.state)).toEqual(['unhealthy']);
    expect(audits.at(-1)?.actor).toBe('health-check');
    expect(audits.at(-1)?.severity).toBe('error');
    expect(audits.at(-1)?.detail?.previousState).toBe('unknown');
    // 读审计的人不该去找一个不存在的状态流转
    expect(audits.at(-1)?.detail?.status).toBe('running');
  });

  it('翻回 healthy 也记一条 —— 「什么时候恢复的」同样只有这里答得出', async () => {
    h.provider.inspectResult = {
      lifecycleState: 'instance_running',
      health: { state: 'unhealthy', lastCheckedAt: 'x', consecutiveFailures: 1 },
    };
    h.provider.execExitCodes = [{ match: /bin\/true/, exitCode: 1 }];
    for (let i = 0; i < 3; i++) await h.healthMonitor.runOnce();
    expect((await healthOf())?.state).toBe('unhealthy');

    h.provider.execExitCodes = [{ match: /bin\/true/, exitCode: 0 }];
    await h.healthMonitor.runOnce();
    expect((await healthOf())?.state).toBe('healthy');
    expect(healthAudits().map((a) => a.detail?.state)).toEqual(['unhealthy', 'healthy']);
  });

  it('★ Ⓕ 无退出码的 exec 绝不当成功（实测出现过一批 undefined）', async () => {
    h.provider.inspectResult = {
      lifecycleState: 'instance_running',
      health: { state: 'unhealthy', lastCheckedAt: 'x', consecutiveFailures: 1 },
    };
    h.provider.execNoExitCode = /bin\/true/;
    for (let i = 0; i < 3; i++) await h.healthMonitor.runOnce();
    expect((await healthOf())?.state).toBe('unhealthy');
  });

  it('★ Ⓖ 命令不存在会**抛**（不是返回非零）—— 必须 catch，不能冒泡', async () => {
    h.provider.inspectResult = {
      lifecycleState: 'instance_running',
      health: { state: 'unhealthy', lastCheckedAt: 'x', consecutiveFailures: 1 },
    };
    h.provider.execThrows = /bin\/true/;
    // 一次探测异常冒泡出去就成了别人的失败（provision 曾经就是这么挂的）
    await expect(h.healthMonitor.runOnce()).resolves.toBeUndefined();
    expect((await healthOf())?.state).toBe('unknown');
    expect((await healthOf())?.message).toContain('inconclusive');
  });

  it('★ Ⓖ `inspect()` 自己抛也不冒泡，而是降级成一次异常迹象（再由数据面裁）', async () => {
    h.provider.inspectResult = new Error('boxlite runtime unavailable');
    // 数据面还能用 ⇒ 迹象归迹象，不翻（控制面暂时问不到，不等于沙箱挂了）
    await expect(h.healthMonitor.runOnce()).resolves.toBeUndefined();
    expect((await healthOf())?.state).toBe('healthy');
    expect(h.provider.execCalls).toEqual([['/bin/true']]);

    // 数据面也不行了 ⇒ 才开始计数
    h.provider.execExitCodes = [{ match: /bin\/true/, exitCode: 1 }];
    await h.healthMonitor.runOnce();
    expect((await healthOf())?.consecutiveFailures).toBe(1);
    expect((await healthOf())?.message).toContain('boxlite runtime unavailable');
    expect(await statusOf()).toBe('running');
  });

  it('★ 「没有异常迹象」而 provider 没报正面信号 ⇒ unknown，**不是** healthy', async () => {
    // 实测（真 boxlite 微 VM + agent-infra/sandbox:latest）：`healthStatus.state === 'None'`
    // —— 这张镜像根本没配 health check。此时零成本层的正面证据只有「VM 在跑」，
    // 拿它写 healthy 就是替沙箱担保一件没人问过的事，而 03 §7.8 定的语义是
    // 「healthy ⇒ agent 可用（充分条件）」。
    h.provider.inspectResult = {
      lifecycleState: 'instance_running',
      health: { state: 'unknown', lastCheckedAt: 'x', consecutiveFailures: 0 },
    };
    await h.healthMonitor.runOnce();
    expect((await healthOf())?.state).toBe('unknown');
    expect(h.provider.execCalls).toEqual([]); // 仍然不进沙箱：没有迹象就不确认
    expect(healthAudits()).toEqual([]); // 也不记审计：这不是一个「开始不健康」的时刻
  });

  it('provider 完全不填 health（本轮之前两个内建 provider 的样子）⇒ unknown', async () => {
    h.provider.inspectResult = { lifecycleState: 'instance_running' };
    await h.healthMonitor.runOnce();
    expect((await healthOf())?.state).toBe('unknown');
  });

  it('★ Ⓗ execErrorsTotal 累计非零但**没涨** ⇒ 不算异常迹象', async () => {
    // 绝对值天然非零（开机以来出过错），拿它当判据会把健康沙箱判死。
    h.provider.inspectResult = {
      lifecycleState: 'instance_running',
      health: { state: 'healthy', lastCheckedAt: 'x', consecutiveFailures: 0 },
      raw: { execErrorsTotal: 12 },
    };
    await h.healthMonitor.runOnce();
    await h.healthMonitor.runOnce();
    expect((await healthOf())?.state).toBe('healthy');
    expect(h.provider.execCalls).toEqual([]); // 一次数据面确认都没触发
    expect(healthAudits()).toEqual([]);
  });

  it('★ Ⓗ execErrorsTotal **涨了** ⇒ 触发一次数据面确认', async () => {
    h.provider.inspectResult = {
      lifecycleState: 'instance_running',
      health: { state: 'healthy', lastCheckedAt: 'x', consecutiveFailures: 0 },
      raw: { execErrorsTotal: 12 },
    };
    await h.healthMonitor.runOnce(); // 建立基线
    h.provider.inspectResult = {
      lifecycleState: 'instance_running',
      health: { state: 'healthy', lastCheckedAt: 'x', consecutiveFailures: 0 },
      raw: { execErrorsTotal: 13 },
    };
    await h.healthMonitor.runOnce();
    expect(h.provider.execCalls).toEqual([['/bin/true']]);
  });

  it('lifecycleState 不再是 instance_running ⇒ 异常迹象（DB 说 running，实例已经没了）', async () => {
    h.provider.inspectResult = { lifecycleState: 'instance_exited' };
    await h.healthMonitor.runOnce();
    expect(h.provider.execCalls).toHaveLength(1);
    expect((await healthOf())?.message).toContain('instance_exited');
  });

  it('★ `idle` 也要采样 —— 空闲不等于健康，「running 不许再撒谎」对它同样成立', async () => {
    // 少了 `|| s.status === 'idle'`，一个 idle 了几小时的沙箱就完全没人看 —— 而
    // idle ⇄ running 之间来回切换的正是交互式 Task，最可能撞上 agent 已挂的那一类。
    const sandbox = await h.repo.findById(id as SandboxId);
    sandbox!.transitionTo('idle', 'reaper', new Date('2026-08-31T00:00:00.000Z'));
    h.uow.run((tx) => h.repo.saveSync(tx, sandbox!));
    expect((await h.service.list())[0].status).toBe('idle');

    h.provider.inspectResult = {
      lifecycleState: 'instance_running',
      health: { state: 'healthy', lastCheckedAt: 'x', consecutiveFailures: 0 },
    };
    await h.healthMonitor.runOnce();
    expect(h.healthMonitor.healthOf(id)?.state).toBe('healthy');
  });

  /**
   * ★ `running` 但**没有 `providerSandboxId`** —— 状态机正常路径下走不到这里
   * （`creating` 那一步就把实例 id 挂上了），所以只能在 monitor 自己的接缝上造。
   *
   * 它不是洁癖：启动对账真的见过「DB 说活着、实例查无」的行（13 §4 的 orphaned 判据
   * 就是为它写的）。这条分支缺失的后果是拿一个 `providerSandboxId: undefined` 的
   * handle 去 `inspect()` —— provider 侧的表现是抛，而 monitor 会把它算成一次异常迹象，
   * 于是一条本该被对账处理的孤儿行会在健康流里变成「不健康」的噪音。
   */
  it('★ `running` 但没有实例 id ⇒ 连 inspect 都不调', async () => {
    const bare = harness();
    const orphan = Sandbox.create({
      imageRef: 'localhost:5001/platform/sandbox:v2',
      id: asSandboxId('sbx-orphan'),
      projectId: asProjectId('prj-1'),
      runtime: 'claude-code',
      provider: bare.provider.name,
      headless: false,
      timeoutMinutes: null,
      idleTimeoutSec: 1800,
      now: new Date('2026-08-31T00:00:00.000Z'),
    });
    for (const to of [
      'scheduling',
      'preparing-workspace',
      'creating',
      'starting',
      'running',
    ] as const) {
      orphan.transitionTo(to, 'system' as never, new Date('2026-08-31T00:00:00.000Z'));
    }
    expect(orphan.status).toBe('running');
    expect(orphan.providerSandboxId).toBeFalsy(); // 从没 attach 过实例
    bare.uow.run((tx) => bare.repo.saveSync(tx, orphan));

    bare.provider.calls.length = 0;
    await bare.healthMonitor.runOnce();
    // ⚠️ 断言 `inspect` **一次都没调**，而不是「没有 exec」—— 后者太弱：默认 inspect
    // 结果没有异常迹象，本来就不会触发数据面确认，那条断言恒绿（实测：变异活下来了）。
    expect(bare.provider.calls).not.toContain('inspect');
  });

  it('★ 单实例串行：上一轮没跑完时下一轮直接返回，不重复采样', async () => {
    let release = (): void => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const slowProvider = h.provider;
    const original = slowProvider.inspect.bind(slowProvider);
    let entered = 0;
    slowProvider.inspect = async () => {
      entered += 1;
      await gate;
      return original();
    };

    const first = h.healthMonitor.runOnce();
    await h.healthMonitor.runOnce(); // 上一轮还卡在 gate 上
    expect(entered).toBe(1);
    release();
    await first;
    expect(entered).toBe(1);
  });

  it('销毁之后不再采样，观测也被丢掉（map 不能只增不减）', async () => {
    h.provider.inspectResult = {
      lifecycleState: 'instance_running',
      health: { state: 'healthy', lastCheckedAt: 'x', consecutiveFailures: 0 },
    };
    await h.healthMonitor.runOnce();
    expect(h.healthMonitor.healthOf(id)).toBeDefined();

    await h.service.destroy(id, {});
    await h.healthMonitor.runOnce();
    expect(h.healthMonitor.healthOf(id)).toBeUndefined();
  });
});
