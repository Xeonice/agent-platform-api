import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { FsWorkspacePreparer } from '../../src/infrastructure/workspace/workspace-preparer';

/**
 * `PreparedWorkspace.entryCount` —— 在**真实文件系统**上（03 §7.8
 * `sandbox.workspace.prepared` / 10 §6.6 的「workspace 空了无人报错」）。
 *
 * ── 这个文件为什么必须存在 ──────────────────────────────────────────────────────
 * 此前关于 `entryCount` / `baselineExisted` 的断言**全部**来自 `_harness.ts` 里
 * 硬编码返回的假 preparer（`{ baselineExisted: true, entryCount: 1 }`），真实计算
 * 一次也没被跑过。而真实计算当时是错的：`prepare()` 自己往工作区里写了
 * `.platform-workspace-state`，`readdir` 又把点文件算进来 ⇒ **`entryCount` 恒 ≥ 1**，
 * `ProvisionSandboxWorkflow` 里 `const empty = ws.entryCount === 0` 因此是死代码，
 * 一个空空如也的工作区会被报成「工作区就绪，1 个顶层条目」+ `info`。
 * 假 preparer 恰好返回 0/1 这两个"正确"的数，所以那批断言全绿。
 *
 * ── 这里的每条断言各自钉住什么变异 ──────────────────────────────────────────────
 *   ① 去掉 `readdir` 之后的 `.filter(name => name !== STATE_FILE)` ⇒ 三条 case 的
 *      期望值全部 +1（0→1、0→1、1→2），三条一起红。这是本文件的主变异。
 *   ② 把 `entryCount` 改成恒 0 / 恒 1 之类的常数 ⇒ 「有内容」与「空」两条里必有一条红
 *      （所以这两种 baseline 一定要同时在场，只测一种是可以被常数糊弄过去的）。
 * 下面还显式断言了状态文件**确实躺在盘上** —— 否则 `entryCount === 0` 可能只是因为
 * 那个文件压根没被写出来，那样的绿是假的。
 */
describe('FsWorkspacePreparer.entryCount 数的是导入进来的东西，不含平台自己的状态文件', () => {
  const STATE_FILE = '.platform-workspace-state';
  const previousDataRoot = process.env.DATA_ROOT;
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(resolve(tmpdir(), 'platform-ws-entrycount-'));
    process.env.DATA_ROOT = resolve(root, 'data');
  });

  afterAll(() => {
    if (previousDataRoot === undefined) delete process.env.DATA_ROOT;
    else process.env.DATA_ROOT = previousDataRoot;
    rmSync(root, { recursive: true, force: true });
  });

  it('baseline 里有一个文件 ⇒ entryCount === 1（状态文件不算）', async () => {
    const baseline = resolve(root, 'baseline-filled');
    mkdirSync(baseline, { recursive: true });
    writeFileSync(resolve(baseline, 'README.md'), 'hello\n');

    const ws = await new FsWorkspacePreparer().prepare('sbx-filled', { baselinePath: baseline });

    expect(ws.baselineExisted).toBe(true);
    // 盘上确实是 2 个条目，其中一个是平台自己的记号 —— 这一行让下面那个 1 不会
    // 因为"状态文件根本没写出来"而假绿。
    expect(readdirSync(ws.hostPath).sort()).toEqual([STATE_FILE, 'README.md'].sort());
    expect(ws.entryCount).toBe(1);
  });

  it('空 baseline ⇒ entryCount === 0，「产出为空」这条分支真的可达', async () => {
    const baseline = resolve(root, 'baseline-empty');
    mkdirSync(baseline, { recursive: true });

    const ws = await new FsWorkspacePreparer().prepare('sbx-empty', { baselinePath: baseline });

    // baseline 读到了（空项目是合法的），但工作区里除了平台记号什么都没有。
    expect(ws.baselineExisted).toBe(true);
    expect(readdirSync(ws.hostPath)).toEqual([STATE_FILE]);
    expect(ws.entryCount).toBe(0);
  });

  it('baseline 读不到 ⇒ 静默降级成空工作区，entryCount 同样是 0', async () => {
    const ws = await new FsWorkspacePreparer().prepare('sbx-missing', {
      baselinePath: resolve(root, 'baseline-does-not-exist'),
    });

    expect(ws.baselineExisted).toBe(false);
    expect(ws.entryCount).toBe(0);
  });
});
