import { describe, it, expect } from 'vitest';
import { classifyWorkspacePrepareError } from '@platform/contracts';
import { harness, waitForStatus } from './_harness';

/**
 * 审计流的**写入口 ②**（13 §2.8.2「写入语义：两个入口」）。
 *
 * ⚠️ **这个入口不是可选项，而这份 spec 就是那句话的兑现。**
 * 「projector 一把梭」是本设计最容易被想当然掉的地方：业务失败时聚合根本不
 * `publish` 领域事件 —— projector 什么也收不到 —— 而排障需要的恰恰是失败那一刻。
 * 下面的测试对着**真实的事件清单**（`h.publishedEvents`）断言这一点：失败路径上
 * 领域事件只有一条 `SandboxStateChanged(→failed)`，它带 from/to/errorCode，
 * **不带「是哪一段炸的」也不带「花了多久」**；而凭证缺席那条路**一个事件都没有**。
 * 这后半句是这条设计约束唯一能被机械验证的形式。
 *
 * MUTATION 记录（都实际跑过）：
 *   · 把 `catch` 里的两条 `recordStage(…, 'failed', e)` 删掉 ⇒ 第一条红。
 *   · 把失败那条的 `errorCode` 改成直接抄 `error.code` ⇒ 第二条红（拿到 errno）。
 *   · 把 `recordWorkspacePrepared` 的 severity 恒写 'info' ⇒ 第四条红。
 */
describe('provision 失败路径的审计（13 §2.8.2 入口 ②）', () => {
  it('工作区准备失败 ⇒ 有 outcome=failed 的阶段记录；领域事件那侧不带 stage/duration', async () => {
    const h = harness({ workspaceError: new Error('boom') });
    const dto = await h.service.create({ projectId: 'prj-1', runtime: 'claude-code' });
    await waitForStatus(h.service, dto.id, 'failed');

    const failures = h.auditRecords.filter(
      (r) => r.type === 'sandbox.provision.stage' && r.outcome === 'failed',
    );
    // 失败那一段 + 整段 provision —— 「哪一步炸的」与「用户等了多久才看见失败」
    // 是两个不同的问题。
    expect(failures.map((r) => r.detail?.stage)).toEqual(['preparing-workspace', 'provision']);
    expect(failures.every((r) => r.severity === 'error')).toBe(true);
    expect(failures.every((r) => typeof r.durationMs === 'number')).toBe(true);
    expect(failures.every((r) => r.subjectId === dto.id)).toBe(true);

    // ⚠️ **对照组**：领域事件那一侧知道「失败了」，但不知道是哪一段、也不知道多久。
    // projector 能投影出的最多就是这些字段 —— 这就是入口 ② 不可省的证据。
    const eventFields = h.publishedEvents.flatMap((e) => Object.keys(e));
    expect(eventFields).not.toContain('stage');
    expect(eventFields).not.toContain('durationMs');
  });

  it('失败记的是闭集里的码，不是 fs 的 errno', async () => {
    const enospc = Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
    const h = harness({ workspaceError: enospc });
    const dto = await h.service.create({ projectId: 'prj-1', runtime: 'claude-code' });
    await waitForStatus(h.service, dto.id, 'failed');

    const failed = h.auditRecords.find(
      (r) => r.type === 'sandbox.provision.stage' && r.outcome === 'failed',
    );
    // 与 `sandboxes.failure_code` 同一条判定（`splitFailure`）。errno 混进审计流的
    // 后果与它当初混进 failure_code 一样：前端按码查文案，查不到。
    expect(failed?.errorCode).not.toBe('ENOSPC');
    expect(failed?.errorCode).toBe('INTERNAL');
  });

  it('已归类的 WorkspacePrepareError ⇒ 码原样进审计', async () => {
    const h = harness({
      workspaceError: classifyWorkspacePrepareError(
        Object.assign(new Error('no space'), { code: 'ENOSPC' }),
      ),
    });
    const dto = await h.service.create({ projectId: 'prj-1', runtime: 'claude-code' });
    await waitForStatus(h.service, dto.id, 'failed');
    const failed = h.auditRecords.find(
      (r) => r.type === 'sandbox.provision.stage' && r.outcome === 'failed',
    );
    expect(failed?.errorCode).toBe('DISK_INSUFFICIENT');
  });

  it('成功路径落齐 03 §7.8 的三类记录，且阶段记录都带 durationMs', async () => {
    const h = harness();
    const dto = await h.service.create({ projectId: 'prj-1', runtime: 'claude-code' });
    await waitForStatus(h.service, dto.id, 'running');

    const types = h.auditRecords.map((r) => r.type);
    expect(types).toContain('sandbox.provision.stage');
    expect(types).toContain('sandbox.workspace.prepared');
    expect(types).toContain('sandbox.agent_session');

    const stages = h.auditRecords.filter((r) => r.type === 'sandbox.provision.stage');
    expect(stages.map((r) => r.detail?.stage)).toEqual([
      'preparing-workspace',
      'creating',
      'starting',
      'provision',
    ]);
    expect(stages.every((r) => typeof r.durationMs === 'number' && r.outcome === 'ok')).toBe(true);

    const ws = h.auditRecords.find((r) => r.type === 'sandbox.workspace.prepared');
    expect(ws?.detail).toMatchObject({ baselineExisted: true, entryCount: 1 });
    expect(ws?.severity).toBe('info');
  });

  it('starting 那条阶段记录带上 imageStaged —— 回答的是「这一段为什么慢」', async () => {
    const h = harness();
    h.provider.declareImageStaged(false);
    const dto = await h.service.create({ projectId: 'prj-1', runtime: 'claude-code' });
    await waitForStatus(h.service, dto.id, 'running');

    const starting = h.auditRecords.find(
      (r) => r.type === 'sandbox.provision.stage' && r.detail?.stage === 'starting',
    );
    expect(starting?.detail).toMatchObject({ stage: 'starting', imageStaged: false });

    // ⚠️ 只有 starting 那一段带。整段 `provision` 横跨多个阶段，把某一段的解释挂在
    // 总计上，会让读者以为那是整段的成因。
    const total = h.auditRecords.find(
      (r) => r.type === 'sandbox.provision.stage' && r.detail?.stage === 'provision',
    );
    expect(total?.detail && 'imageStaged' in total.detail).toBe(false);
    // 前面的阶段更不该沾上它 —— 那说明 `enter()` 没清空上一段的解释。
    const earlier = h.auditRecords.filter(
      (r) =>
        r.type === 'sandbox.provision.stage' &&
        (r.detail?.stage === 'preparing-workspace' || r.detail?.stage === 'creating'),
    );
    expect(earlier.length).toBe(2);
    expect(earlier.every((r) => r.detail && !('imageStaged' in r.detail))).toBe(true);
  });

  it('取的是「进入 starting 那一刻」的值 —— start() 之后再问永远是 true', async () => {
    const h = harness();
    h.provider.declareImageStaged(false);
    // 真实语义：`provider.start()` 干的正是「把镜像铺开」，所以它返回之后再问，
    // 答案必然翻成 true。⚠️ 没有这一句，「在 start() 之后才问」这个改动**测不出来**
    // ——替身恒答同一个值，问的时机就成了不可观测的东西（本仓管这叫「变异无效」）。
    const start = h.provider.start.bind(h.provider);
    h.provider.start = async (...args: Parameters<typeof start>): Promise<void> => {
      await start(...args);
      h.provider.declareImageStaged(true);
    };

    const dto = await h.service.create({ projectId: 'prj-1', runtime: 'claude-code' });
    await waitForStatus(h.service, dto.id, 'running');

    const starting = h.auditRecords.find(
      (r) => r.type === 'sandbox.provision.stage' && r.detail?.stage === 'starting',
    );
    // 记 true 就等于说「本机早有这镜像」，而这一段恰恰慢在**现拉**上 —— 那是把成因
    // 反着写进审计，比不写更坏。
    expect(starting?.detail).toMatchObject({ imageStaged: false });
  });

  it('provider 答不上 ⇒ 整个字段缺席，不退化成 false', async () => {
    // 没有 declareImageStaged：方法根本不存在，正是第三方 provider 的常态。
    const h = harness();
    const dto = await h.service.create({ projectId: 'prj-1', runtime: 'claude-code' });
    await waitForStatus(h.service, dto.id, 'running');

    const starting = h.auditRecords.find(
      (r) => r.type === 'sandbox.provision.stage' && r.detail?.stage === 'starting',
    );
    // ⛔ `false` 是「问了，本机没有」；缺席是「没问出来」。退化成 false 等于替 provider
    //    编了一个它没说过的答案，而这条 detail 的读者会拿它解释耗时。
    expect(starting?.detail && 'imageStaged' in starting.detail).toBe(false);
  });

  it('baseline 读不到 ⇒ 那条 workspace.prepared 是 warn，不是一次静默的"成功"', async () => {
    const h = harness({ workspaceBaselineMissing: true });
    const dto = await h.service.create({ projectId: 'prj-1', runtime: 'claude-code' });
    await waitForStatus(h.service, dto.id, 'running');
    const ws = h.auditRecords.find((r) => r.type === 'sandbox.workspace.prepared');
    // ⚠️ `prepare()` 对读不到的 baseline 是**静默**降级的（importBaseline 的
    // `catch { return; }`），沙箱照样 running —— 用户只会看到「agent 什么也没干」。
    // 这一条 warn 是那条路唯一的记录。
    expect(ws?.severity).toBe('warn');
    expect(ws?.detail).toMatchObject({ baselineExisted: false, entryCount: 0 });
  });

  /**
   * ⚠️ **与上一条是两件事**：baseline 读到了（空项目是合法的），只是导入进来的东西
   * 是空的。用户看到的仍然是「agent 什么也没干」，所以同样要 warn。
   *
   * 这条分支曾经**不可达**：真实 adapter 把自己写的 `.platform-workspace-state` 也数
   * 进 `entryCount`，真实文件系统上它恒 ≥ 1（`test/integration/workspace-entry-count.
   * spec.ts` 实测），于是 `const empty = ws.entryCount === 0` 一次也没成立过，而那条
   * 审计还会对着一个空工作区说「工作区就绪，**1** 个顶层条目」+ info。
   * ⚠️ 光有本条还不够 —— 它用的是 `_harness.ts` 里**硬编码返回**的假 preparer，
   * 真实计数口径由那个集成测试钉住，两条缺一不可。
   */
  it('baseline 读到了但产出为空 ⇒ 同样是 warn，且这条分支真的可达', async () => {
    const h = harness({ workspaceEmpty: true });
    const dto = await h.service.create({ projectId: 'prj-1', runtime: 'claude-code' });
    await waitForStatus(h.service, dto.id, 'running');
    const ws = h.auditRecords.find((r) => r.type === 'sandbox.workspace.prepared');
    expect(ws?.detail).toMatchObject({ baselineExisted: true, entryCount: 0 });
    expect(ws?.severity).toBe('warn');
    // 措辞必须跟「baseline 读不到」那条分得开 —— 两条的下一步动作完全不同
    // （一个是去看项目配置，一个是去看项目里到底有没有代码）。
    expect(ws?.summary).toContain('一个文件都没有');
  });

  it('没有凭证时留下一条 warn —— 「agent 起来了但没登录」在用户眼里是「它什么都没干」', async () => {
    const h = harness();
    const dto = await h.service.create({ projectId: 'prj-1', runtime: 'claude-code' });
    await waitForStatus(h.service, dto.id, 'running');
    // 默认 harness 不给凭证 ⇒ workflow 走 `CredentialPreparationError` 那条 warn 分支。
    const absent = h.auditRecords.find((r) => r.type === 'sandbox.credential.absent');
    expect(absent?.severity).toBe('warn');
    expect(absent?.outcome).toBe('skipped');
    // ⚠️ 对照组：凭证缺席**不改变任何状态**，因此聚合一个事件都不发 —— projector
    // 这条路上收到的是零。没有入口 ②，这件事在平台上不存在任何记录。
    expect(h.publishedEvents.some((e) => e.type.toLowerCase().includes('credential'))).toBe(false);
  });
});
