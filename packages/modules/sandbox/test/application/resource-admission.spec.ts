import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { HttpException } from '@nestjs/common';
import type { CreateSandboxInput } from '@platform/contracts';
import { WorkspacePrepareError, DISK_INSUFFICIENT } from '@platform/contracts';
import { harness as makeHarness, waitForStatus } from './_harness';

/**
 * 03 §3「并发控制（防超分配）」的落地测试 —— 以及 `RESOURCE_EXHAUSTED` 在本平台**第一个
 * 真实抛出点**的回归。
 *
 * ── 这一整个文件在防什么 ───────────────────────────────────────────────────────
 * 落地之前：全仓 grep `SandboxProviderErrorCode.RESOURCE_EXHAUSTED` 只有枚举定义、HTTP
 * 映射表、automation adapter 的 catch，以及两个**自己造错误**的 spec —— **零个 throw 点**。
 * 叠加 `create` 的后半段是 `void provision.runSafely(...)`，容量类失败根本不在
 * `createSandbox` 的调用栈上，于是 03 §8.2 决策表行 3 那一整套（排队重试 / `retry_at` /
 * 「已排队 n/5」）全是死代码，而真实的资源不足会走「后台失败 ⇒ 记一次失败」，把一条只是
 * 排队等资源的规则连撞十次自动禁用。
 *
 * 所以下面每一条断言都在钉同一件事的一个侧面：**登记发生在同步段、在互斥区内、与落库
 * 同事务、失败时一行都不写、释放路径不漏**。
 */

const base: CreateSandboxInput = { projectId: 'prj-1', runtime: 'claude-code' };

/**
 * 把策略钉成「不打折」，让每条断言里的算术都可心算。
 *
 * ⚠️ 默认策略（15% 余量 + 1.5 CPU 超配）**另有一条专门的用例**在测 —— 在这里顺手用默认值
 * 会让每条容量断言都要读者心算 `× 0.85 × 1.5`，而算错的那次没人会发现。
 */
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = [
  'SCHEDULER_SAFETY_MARGIN',
  'SCHEDULER_CPU_OVERCOMMIT',
  'WORKSPACE_MIN_FREE_BYTES',
  'SANDBOX_DISK_FLOOR_MB',
  'SCHEDULER_NODE_ID',
];

beforeEach(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.SCHEDULER_SAFETY_MARGIN = '0';
  process.env.SCHEDULER_CPU_OVERCOMMIT = '1';
  process.env.WORKSPACE_MIN_FREE_BYTES = '0';
  process.env.SANDBOX_DISK_FLOOR_MB = '512';
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

async function rejection(p: Promise<unknown>): Promise<HttpException> {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(HttpException);
  return e as HttpException;
}

describe('03 §3 互斥登记：创建时真的登记一笔配额', () => {
  it('★ 一次成功的创建**恰好**留下一条活跃登记，quota 就是 03 §1 算出来的那个', async () => {
    // 基线 10 GiB ⇒ 磁盘 12288MB；CPU/内存来自镜像 resource_defaults（harness: 1 core / 512MB）
    const h = makeHarness({ baselineSizeBytes: 10 * 1024 ** 3 });
    const dto = await h.service.create(base);

    const rows = await h.allocations.listAll();
    expect(rows).toHaveLength(1);
    expect(rows[0].sandboxId).toBe(dto.id);
    expect(rows[0].isActive).toBe(true);
    expect(rows[0].quota).toEqual({ cores: 1, ramMb: 512, diskMb: 12_288 });
    await waitForStatus(h.service, dto.id, 'running');
  });

  it('空项目（基线没量过）登记的是配置下限', async () => {
    process.env.SANDBOX_DISK_FLOOR_MB = '777';
    const h = makeHarness();
    const dto = await h.service.create(base);
    const rows = await h.allocations.listAll();
    expect(rows[0].quota.diskMb).toBe(777);
    await waitForStatus(h.service, dto.id, 'running');
  });

  it('★★ 登记与 sandbox 行落在**同一个事务**里（FK + 「拒绝时一行都没写」都靠它）', async () => {
    const h = makeHarness();
    const dto = await h.service.create(base);

    // T1 那一帧必须同时含两条写入。分成两个事务时，真库上是一条
    // `FOREIGN KEY constraint failed`（登记指向一行还不存在的 sandbox）；
    // 而在单测里，后台 provision 一转状态就把 sandbox 行补写进去，看起来毫无异样。
    const t1 = h.txFrames[0];
    expect(t1).toContain(`sandbox:${dto.id}`);
    expect(t1).toContain(`allocation:${dto.id}`);
    await waitForStatus(h.service, dto.id, 'running');
  });

  it('★ 实例拿到的 quota **就是登记的那一份**，不是一个写死的默认值', async () => {
    const h = makeHarness({ baselineSizeBytes: 10 * 1024 ** 3 });
    const dto = await h.service.create(base);
    await waitForStatus(h.service, dto.id, 'running');
    // 账本说 12288MB、容器按 1024MB 建，就等于「防超分配」防的是一个与真实占用无关的数。
    expect(h.provider.createdSpecs[0].quota).toEqual({ cores: 1, ramMb: 512, diskMb: 12_288 });
  });
});

describe('03 §3:86「所有创建/销毁请求先进 SchedulerQueue」', () => {
  it('★★ 创建与销毁走的是**同一条**显式队列，不是各自一把锁', async () => {
    const h = makeHarness();
    const dto = await h.service.create(base);
    await waitForStatus(h.service, dto.id, 'running');
    await h.service.destroy(dto.id);

    const admitted = h.schedulerQueue.snapshot().admitted;
    expect(admitted.create).toBe(1);
    expect(admitted.destroy).toBe(1);
  });

  it('★ 只读的容量探测**不进**队列 —— 否则「队列深度」这个数字会开始撒谎', async () => {
    const h = makeHarness();
    await h.service.hasCapacityFor(base);
    await h.service.hasCapacityFor(base);
    // 自动化每分钟问一次容量；把它算进「有多少创建/销毁请求卡在调度上」，
    // 那个数字就再也回答不了它被造出来要回答的问题。
    expect(h.schedulerQueue.snapshot()).toMatchObject({
      depth: 0,
      admitted: { create: 0, destroy: 0, reconcile: 0 },
    });
  });

  it('★★ 6 个并发创建里，排在后面的那几个真的进过队列（深度 > 0）', async () => {
    const h = makeHarness({ hostProbeDelayMs: 5 });
    await Promise.all(Array.from({ length: 6 }, () => h.service.create(base)));
    const snap = h.schedulerQueue.snapshot();
    expect(snap.admitted.create).toBe(6);
    // 峰值深度是「刚才堵过」的唯一证据 —— 没有队列对象时这个数根本不存在。
    expect(snap.peakDepth).toBeGreaterThan(1);
    expect(snap.queued).toBeGreaterThan(0);
    expect(snap.depth).toBe(0);
  });
});

describe('03 §3 容量不足：RESOURCE_EXHAUSTED 的第一个真实抛出点', () => {
  /** 内存刚好只放得下 1 个（512MB × 2 > 900）。 */
  const tight = () => makeHarness({ hostCapacity: { ramMb: 900 } });

  it('★ 第二次创建被拒 —— 429 + `RESOURCE_EXHAUSTED` + `retryable:true`', async () => {
    const h = tight();
    const first = await h.service.create(base);

    const err = await rejection(h.service.create(base));
    expect(err.getStatus()).toBe(429);
    expect(err.getResponse()).toMatchObject({
      code: 'RESOURCE_EXHAUSTED',
      // automation 侧那 5 次排队重试建立在这一位上：不可重试的拒绝该就地改请求，
      // 而这一条的出路恰恰是「等一会儿」。
      retryable: true,
    });
    await waitForStatus(h.service, first.id, 'running');
  });

  it('★★ 拒绝时**一行都没写** —— 没有 sandbox 行，也没有登记行', async () => {
    const h = tight();
    const first = await h.service.create(base);
    await waitForStatus(h.service, first.id, 'running');

    await rejection(h.service.create(base));

    // 只有第一条活着的沙箱与它那一条登记。若登记与落库不同事务，这里会多出一个
    // `pending`/`failed` 的空壳沙箱 —— automation 那 5 次排队重试就会变成 5 条假任务。
    expect(h.repo.store.size).toBe(1);
    expect(await h.allocations.listAll()).toHaveLength(1);
    // 也**没有**去建实例：慢 IO 在互斥区外，而这次请求根本没走到那里。
    expect(h.provider.createdSpecs).toHaveLength(1);
  });

  it('★ 抛在**同步段** —— `create` 的 promise 自己 reject，而不是背地里把沙箱标 failed', async () => {
    const h = tight();
    const first = await h.service.create(base);
    await waitForStatus(h.service, first.id, 'running');

    // 这一条是整件事的关键：`AutomationTaskLauncherAdapter` 的 catch 只包着
    // `await this.sandboxes.create(...)`，容量失败若发生在 `void runSafely(...)` 里面，
    // 它一次都接不到（那正是落地前的状态）。
    await expect(h.service.create(base)).rejects.toBeInstanceOf(HttpException);
  });

  it('释放之后容量回来了 —— 销毁一条就能再建一条', async () => {
    const h = tight();
    const first = await h.service.create(base);
    await waitForStatus(h.service, first.id, 'running');
    await rejection(h.service.create(base));

    await h.service.destroy(first.id);
    const rows = await h.allocations.listAll();
    expect(rows.every((r) => !r.isActive)).toBe(true);

    const second = await h.service.create(base);
    expect(second.status).toBe('pending');
    await waitForStatus(h.service, second.id, 'running');
  });

  it('★ 物理闸：账本空空如也，但盘上真的没地方 ⇒ 照样 429', async () => {
    process.env.WORKSPACE_MIN_FREE_BYTES = String(1024 ** 4);
    const h = makeHarness({ hostCapacity: { diskAvailableBytes: 10 * 1024 ** 2 } });
    const err = await rejection(h.service.create(base));
    expect(err.getStatus()).toBe(429);
    expect(h.repo.store.size).toBe(0);
  });
});

describe('★★ TOCTOU：N 个并发创建里只有 M 个能成功（03 §1「消除 TOCTOU」）', () => {
  it('6 并发 / 容量 3 ⇒ 恰好 3 成功 3 被拒，且账本里正好 3 条活跃登记', async () => {
    // ram 2000MB，余量 0 ⇒ 池子 2000MB；每发 512MB ⇒ 3 发（4 发要 2048 > 2000）。
    const h = makeHarness({ hostCapacity: { ramMb: 2000 } });

    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () => h.service.create(base)),
    );
    const ok = results.filter((r) => r.status === 'fulfilled');
    const refused = results.filter((r) => r.status === 'rejected');

    expect(ok).toHaveLength(3);
    expect(refused).toHaveLength(3);
    for (const r of refused) {
      const reason: unknown = (r as PromiseRejectedResult).reason;
      expect(reason).toBeInstanceOf(HttpException);
      expect((reason as HttpException).getResponse()).toMatchObject({
        code: 'RESOURCE_EXHAUSTED',
      });
    }

    // ★ 这一行是「消除 TOCTOU」本身：没有互斥区时 6 个请求会同时读到空账本、
    // 同时通过判定、然后一起写进去 —— 库里会是 6 条。
    const active = (await h.allocations.listAll()).filter((a) => a.isActive);
    expect(active).toHaveLength(3);
    expect(h.repo.store.size).toBe(3);

    await Promise.all(
      ok.map((r) =>
        waitForStatus(h.service, (r as PromiseFulfilledResult<{ id: string }>).value.id, 'running'),
      ),
    );
  });

  it('★★ 互斥区**真的串行**：用时间证明（去掉 runExclusive 这条必红）', async () => {
    // 每次容量探测都要 30ms。串行 4 次 ⇒ ≥ 90ms（保守取 3 个间隔）；并行 ⇒ ~30ms。
    const h = makeHarness({ hostProbeDelayMs: 30 });
    const started = Date.now();
    const created = await Promise.all(Array.from({ length: 4 }, () => h.service.create(base)));
    const elapsed = Date.now() - started;

    expect(created).toHaveLength(4);
    // 与 `automation.scheduler` 那条「单实例串行」同款做法：只有时间说得清「排过队」。
    expect(elapsed).toBeGreaterThanOrEqual(90);
    await Promise.all(created.map((d) => waitForStatus(h.service, d.id, 'running')));
  });
});

describe('03 §640 / §3：失败与销毁都要回滚配额登记', () => {
  it('★ 工作区准备失败（DISK_INSUFFICIENT）⇒ 沙箱 failed **且**登记被释放', async () => {
    const h = makeHarness({
      workspaceError: new WorkspacePrepareError(DISK_INSUFFICIENT, 'disk full mid-copy'),
    });
    const dto = await h.service.create(base);
    await waitForStatus(h.service, dto.id, 'failed');

    const rows = await h.allocations.listAll();
    expect(rows).toHaveLength(1);
    // 不释放的话，每一次 provision 失败都会永久吃掉一格容量 —— 攒够就是一台谁也建不出
    // Task 的机器，而日志里一句话都没有。
    expect(rows[0].isActive).toBe(false);
  });

  it('provision 在更靠后的一步失败（装 CLI）同样释放', async () => {
    const h = makeHarness({ installError: new Error('npm exploded') });
    const dto = await h.service.create(base);
    await waitForStatus(h.service, dto.id, 'failed');
    expect((await h.allocations.listAll())[0].isActive).toBe(false);
  });

  it('销毁释放；`keepVolume` 也释放（保留目录不进资源池，§1/§7.7）', async () => {
    const h = makeHarness();
    const dto = await h.service.create(base);
    await waitForStatus(h.service, dto.id, 'running');
    await h.service.destroy(dto.id, { keepVolume: true });
    expect((await h.allocations.listAll())[0].isActive).toBe(false);
  });

  it('`stopped` **不**释放 —— 工作区还在盘上，`start` 还能把它接回来', async () => {
    const h = makeHarness();
    const dto = await h.service.create(base);
    await waitForStatus(h.service, dto.id, 'running');
    await h.service.stop(dto.id);
    expect((await h.allocations.listAll())[0].isActive).toBe(true);
  });
});

describe('03 §8.2 行 3 的只读判据：hasCapacityFor', () => {
  it('空池子答 true；填满之后答 false', async () => {
    const h = makeHarness({ hostCapacity: { ramMb: 900 } });
    expect(await h.service.hasCapacityFor(base)).toBe(true);
    const dto = await h.service.create(base);
    expect(await h.service.hasCapacityFor(base)).toBe(false);
    await waitForStatus(h.service, dto.id, 'running');
  });

  it('★ 它是**只读**的：问过之后账本与仓储都没有多出任何东西', async () => {
    const h = makeHarness();
    await h.service.hasCapacityFor(base);
    await h.service.hasCapacityFor(base);
    expect(h.repo.store.size).toBe(0);
    expect(await h.allocations.listAll()).toHaveLength(0);
    expect(h.provider.createdSpecs).toHaveLength(0);
  });
});

describe('默认策略（15% 余量 / CPU 1.5 超配）在没有 env 时确实生效', () => {
  it('★ 不设 env ⇒ 内存池是宿主的 85%，而不是 100%', async () => {
    for (const k of ENV_KEYS) delete process.env[k];
    // 1024MB × 0.85 = 870 ⇒ 只放得下 1 发（512×2 = 1024 > 870）。
    // 若谁把余量默认成 0，池子就是 1024，两发都放得进去，这条会红。
    const h = makeHarness({ hostCapacity: { ramMb: 1024 } });
    const first = await h.service.create(base);
    await rejection(h.service.create(base));
    await waitForStatus(h.service, first.id, 'running');
  });
});
