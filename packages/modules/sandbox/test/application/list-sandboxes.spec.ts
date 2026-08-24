import { describe, it, expect } from 'vitest';
import { harness, waitForStatus } from './_harness';

/**
 * `GET /api/sandboxes` 不带 `projectId` = 全部项目（docs/shared/10 §6）。
 *
 * 这条盯的是一个**线上真撞到**的 bug：`list()` 曾是 `if (!projectId) return [];`，
 * 而工作台左侧任务树发的正是裸 `GET /api/sandboxes` ⇒ 树里永远 0 个任务。更难查的是
 * 它**不报错**：树上的计数走的是另一条路（`ProjectDto.taskCount` ← `countActiveByProject`），
 * 所以界面呈现的是"项目后面写着 · 1，展开却一条都没有"。
 *
 * MUTATION ①：把 `list()` 改回 `if (!projectId) return [];` → 第一条红。
 * MUTATION ②：去掉 `.filter(s => s.status !== 'destroyed')` → 第二条红。
 */
describe('list sandboxes（不带 projectId = 全部项目）', () => {
  it('两个项目各建一个 → 裸 list 返回两个；按项目过滤各返回一个', async () => {
    const h = harness();
    const a = await h.service.create({ projectId: 'prj-a', runtime: 'claude-code' });
    const b = await h.service.create({ projectId: 'prj-b', runtime: 'claude-code' });
    await waitForStatus(h.service, a.id, 'running');
    await waitForStatus(h.service, b.id, 'running');

    const all = await h.service.list();
    expect(all.map((s) => s.id).sort()).toEqual([a.id, b.id].sort());
    // 过滤仍然有效——修好"缺省返回全部"不能把过滤能力弄丢。
    expect((await h.service.list('prj-a')).map((s) => s.id)).toEqual([a.id]);
    expect((await h.service.list('prj-b')).map((s) => s.id)).toEqual([b.id]);
  });

  it('destroyed 不出现在列表里——否则与 taskCount 各说各话', async () => {
    const h = harness();
    const keep = await h.service.create({ projectId: 'prj-a', runtime: 'claude-code' });
    const gone = await h.service.create({ projectId: 'prj-a', runtime: 'claude-code' });
    await waitForStatus(h.service, keep.id, 'running');
    await waitForStatus(h.service, gone.id, 'running');
    await h.service.destroy(gone.id, {});

    const ids = (await h.service.list()).map((s) => s.id);
    expect(ids).toContain(keep.id);
    // `countActiveByProject`（喂 taskCount）排除 destroyed，列表必须用同一口径。
    expect(ids).not.toContain(gone.id);
  });
});
