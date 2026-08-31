import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import {
  AutomationResourceExhausted,
  WorkspacePrepareError,
  DISK_INSUFFICIENT,
} from '@platform/contracts';
import type { AutomationTaskLaunchInput } from '@platform/contracts';
import { AutomationTaskLauncherAdapter } from '../../src/application/automation-task-launcher.adapter';
import { harness as makeHarness, waitForStatus } from './_harness';

/**
 * `AutomationTaskLauncherAdapter` —— **决策表行 3 的两条路径都从这里穿过去**，而在本切片
 * 之前它一个测试都没有。
 *
 * 它的注释里早就写着这件事的要害：「只认其中一种，行 3 就会在另一半路径上退化成『记一次
 * 失败』——而那会污染 `consecutive_failures`，最终把一条只是排队等资源的规则自动禁用掉。」
 * 下面这几条就是把那句话变成会红的断言：
 *
 *   ① 同步路径：创建门抛 429 `RESOURCE_EXHAUSTED` ⇒ 必须变成 `AutomationResourceExhausted`；
 *   ② 后台路径：沙箱死于 `DISK_INSUFFICIENT` ⇒ `phaseOf` 必须把**码**带出去（不是只带文案）；
 *   ③ 判据本身：`capacityFor` 是只读的、且永不抛。
 */

const launch: AutomationTaskLaunchInput = {
  projectId: 'prj-1',
  runtimeId: 'claude-code',
  prompt: 'do the thing',
  timeoutMinutes: 30,
  automationId: 'aut-1',
};

const saved: Record<string, string | undefined> = {};
const KEYS = ['SCHEDULER_SAFETY_MARGIN', 'SCHEDULER_CPU_OVERCOMMIT', 'WORKSPACE_MIN_FREE_BYTES'];

beforeEach(() => {
  for (const k of KEYS) saved[k] = process.env[k];
  process.env.SCHEDULER_SAFETY_MARGIN = '0';
  process.env.SCHEDULER_CPU_OVERCOMMIT = '1';
  process.env.WORKSPACE_MIN_FREE_BYTES = '0';
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function adapterOn(h: ReturnType<typeof makeHarness>): AutomationTaskLauncherAdapter {
  return new AutomationTaskLauncherAdapter(h.service, h.taskService, h.repo, h.taskRepo);
}

describe('① 同步路径：创建门的 429 变成 AutomationResourceExhausted', () => {
  it('★★ 容量不足 ⇒ `createSandbox` 抛的是**跨上下文的资源信号**，不是一个裸 HttpException', async () => {
    const h = makeHarness({ hostCapacity: { ramMb: 900 } }); // 只放得下 1 发
    const a = adapterOn(h);
    const { sandboxId } = await a.createSandbox(launch);
    await waitForStatus(h.service, sandboxId, 'running');

    // 调度器靠 `instanceof AutomationResourceExhausted` 决定「排队重试」还是「记一次失败」，
    // 两者对 consecutive_failures 的影响相反（I-AUT-1）。这里认不出来，行 3 就整条不成立。
    await expect(a.createSandbox(launch)).rejects.toBeInstanceOf(AutomationResourceExhausted);
  });

  it('★ 不是容量的失败**不许**被认成资源信号 —— 否则真坏了的规则会永远「已排队 n/5」', async () => {
    const h = makeHarness({ projectError: new NotFoundException('no such project') });
    const a = adapterOn(h);
    const e = await a.createSandbox(launch).then(
      () => null,
      (err: unknown) => err,
    );
    expect(e).not.toBeInstanceOf(AutomationResourceExhausted);
  });
});

describe('② 后台路径：phaseOf 必须把失败**码**带出去', () => {
  it('★★ 沙箱死于 DISK_INSUFFICIENT ⇒ `phase.errorCode` 就是那个码', async () => {
    const h = makeHarness({
      workspaceError: new WorkspacePrepareError(DISK_INSUFFICIENT, 'disk full mid-copy'),
    });
    const a = adapterOn(h);
    const { sandboxId } = await a.createSandbox(launch);
    await waitForStatus(h.service, sandboxId, 'failed');

    const phase = await a.phaseOf(sandboxId);
    expect(phase.kind).toBe('finished');
    // 只回 `errorMessage`（一句人类可读的自由文本）时，调度器只能把它当普通失败 +1 ——
    // 那正是「另一半路径」被漏掉的形状。
    expect(phase).toMatchObject({ status: 'failed', errorCode: DISK_INSUFFICIENT });
  });

  it('★ 普通 provision 失败带的是它自己的码，不是容量码', async () => {
    const h = makeHarness({ installError: new Error('npm exploded') });
    const a = adapterOn(h);
    const { sandboxId } = await a.createSandbox(launch);
    await waitForStatus(h.service, sandboxId, 'failed');

    const phase = await a.phaseOf(sandboxId);
    expect(phase).toMatchObject({ status: 'failed' });
    expect(phase.kind === 'finished' && phase.errorCode).not.toBe(DISK_INSUFFICIENT);
  });

  it('沙箱不存在仍然是 `gone`，不抛（一轮扫描不该被一条烂记录打断）', async () => {
    const h = makeHarness();
    await expect(adapterOn(h).phaseOf('sbx-nope')).resolves.toEqual({ kind: 'gone' });
  });
});

describe('③ capacityFor：只读、可判、永不抛', () => {
  it('空池子 `ok`；填满之后 `resource-exhausted`', async () => {
    const h = makeHarness({ hostCapacity: { ramMb: 900 } });
    const a = adapterOn(h);
    expect(await a.capacityFor(launch)).toBe('ok');
    const { sandboxId } = await a.createSandbox(launch);
    expect(await a.capacityFor(launch)).toBe('resource-exhausted');
    await waitForStatus(h.service, sandboxId, 'running');
  });

  it('★ 只读：问过之后没有沙箱行、没有登记、没有调 provider.create', async () => {
    const h = makeHarness();
    const a = adapterOn(h);
    await a.capacityFor(launch);
    expect(h.repo.store.size).toBe(0);
    expect(await h.allocations.listAll()).toHaveLength(0);
    expect(h.provider.createdSpecs).toHaveLength(0);
  });

  it('★★ 门本身抛（项目不存在）⇒ 答 `ok`，**不抛** —— 抛出去会让整条规则静默漏跑', async () => {
    // `fireOne` 的 catch 只会记一条 warn 然后跳过，而 `next_trigger_at` 早已推进：
    // 那一发就这么消失了，历史里连一条记录都没有。
    const h = makeHarness({ projectError: new NotFoundException('no such project') });
    await expect(adapterOn(h).capacityFor(launch)).resolves.toBe('ok');
  });
});
