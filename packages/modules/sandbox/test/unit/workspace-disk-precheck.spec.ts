import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DISK_INSUFFICIENT,
  WORKSPACE_PREPARE_FAILED,
  WorkspacePrepareError,
} from '@platform/contracts';
import { FsWorkspacePreparer } from '../../src/infrastructure/workspace/workspace-preparer';

/**
 * 磁盘预检 for the COPY side (03 §7.6) —— clone 那条路 2026-08 就有了，这条一直没有。
 *
 * ── 为什么这条路更需要，不是更不需要 ──────────────────────────────────────────
 * 两条路搬的是**同样多的字节**（都是整个仓库），但频率完全不同：clone 每个项目一次，
 * workspace 复制**每个 Task 一次**。而且 `cp -a --reflink=auto` 在 ext4 上**没有 reflink**,
 * 会静默退化成整字节复制 —— 单机私有化部署里 ext4 是默认，于是"每建一个 Task 就再复制
 * 一整个仓库"是常态而不是极端情况。
 *
 * ⚠️ 用地板值而不是「基线体积」，理由与 clone 侧**相反但结论相同**。clone 侧是需求不可知
 * （没人问过远端多大）；这里是需求**在两个极端之间不可知**：btrfs/XFS 上 reflink 让复制
 * 花掉≈0 字节，ext4 上花掉≈基线体积，而 `--reflink=auto` 不会提前告诉你走哪条。要求
 * 「基线体积」的空闲会把 CoW 文件系统上本可免费完成的 Task 拒掉。地板值是两种情况下都成立
 * 的那部分。
 *
 * MUTATION: 删掉 `prepare()` 里的 `await this.assertDiskSpace(...)` ⇒ 第一条红。
 */
let dataRoot: string;
let prevDataRoot: string | undefined;
let prevMinFree: string | undefined;

beforeEach(() => {
  prevDataRoot = process.env.DATA_ROOT;
  prevMinFree = process.env.WORKSPACE_MIN_FREE_BYTES;
  dataRoot = mkdtempSync(resolve(tmpdir(), 'ws-disk-'));
  process.env.DATA_ROOT = dataRoot;
});

afterEach(() => {
  if (prevDataRoot === undefined) delete process.env.DATA_ROOT;
  else process.env.DATA_ROOT = prevDataRoot;
  if (prevMinFree === undefined) delete process.env.WORKSPACE_MIN_FREE_BYTES;
  else process.env.WORKSPACE_MIN_FREE_BYTES = prevMinFree;
  rmSync(dataRoot, { recursive: true, force: true });
});

function baselineWith(name: string, content: string): string {
  const baseline = resolve(dataRoot, 'baseline');
  mkdirSync(baseline, { recursive: true });
  writeFileSync(resolve(baseline, name), content);
  return baseline;
}

describe('FsWorkspacePreparer 磁盘预检 (03 §7.6)', () => {
  it('空间不足 ⇒ 在复制任何字节之前拒绝，且给的是 DISK_INSUFFICIENT', async () => {
    const baseline = baselineWith('README.md', 'baseline content\n');
    // 要求 1 PiB —— 任何真机都达不到，且不依赖当前磁盘状态。
    process.env.WORKSPACE_MIN_FREE_BYTES = String(1024 ** 5);

    const error = await new FsWorkspacePreparer()
      .prepare('sbx-disk', { baselinePath: baseline })
      .then(() => null)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(WorkspacePrepareError);
    // ① 用户拿得到一句他能执行的话，而不是"内部错误"。
    expect((error as WorkspacePrepareError).code).toBe(DISK_INSUFFICIENT);
    // ② 「预」检的意义：基线一个字节都没被复制过去。
    expect(existsSync(resolve(dataRoot, 'workspaces', 'sbx-disk', 'README.md'))).toBe(false);
  });

  it('空间充足 ⇒ 预检不挡路，复制照常发生', async () => {
    const baseline = baselineWith('README.md', 'baseline content\n');
    process.env.WORKSPACE_MIN_FREE_BYTES = '0';

    const ws = await new FsWorkspacePreparer().prepare('sbx-ok', { baselinePath: baseline });
    expect(existsSync(resolve(ws.hostPath, 'README.md'))).toBe(true);
  });

  it('WORKSPACE_MIN_FREE_BYTES 是独立旋钮，不复用 clone 的那个', async () => {
    const baseline = baselineWith('README.md', 'x\n');
    // 只设 clone 侧的旋钮到天文数字：这一侧必须**不受影响** —— 两个检查守的是两个目录，
    // 真实部署里常在不同挂载点上，调了一个不代表想调另一个。
    const prevClone = process.env.CLONE_MIN_FREE_BYTES;
    process.env.CLONE_MIN_FREE_BYTES = String(1024 ** 5);
    try {
      const ws = await new FsWorkspacePreparer().prepare('sbx-knob', { baselinePath: baseline });
      expect(existsSync(resolve(ws.hostPath, 'README.md'))).toBe(true);
    } finally {
      if (prevClone === undefined) delete process.env.CLONE_MIN_FREE_BYTES;
      else process.env.CLONE_MIN_FREE_BYTES = prevClone;
    }
  });
});

/**
 * ★ 出线的必须是闭集码，不能是 errno —— 这是 ③ 的「抛出处命名」那一层。
 *
 * MUTATION: 把 `prepare()` 的 `catch (e) { throw classifyWorkspacePrepareError(e); }`
 * 改成 `throw e` ⇒ 下面这条红，拿到的是 `ENOTDIR`。
 */
describe('FsWorkspacePreparer 把 errno 归一成闭集码', () => {
  it('真实的 fs 故障出线时已是 WorkspacePrepareError，不是裸 errno', async () => {
    // 让 DATA_ROOT 落在一个**文件**下面：mkdir 会得到 ENOTDIR，是真实 fs 错误而非替身。
    const notADir = resolve(dataRoot, 'i-am-a-file');
    writeFileSync(notADir, 'not a directory\n');
    process.env.DATA_ROOT = resolve(notADir, 'data');
    process.env.WORKSPACE_MIN_FREE_BYTES = '0';

    const error = await new FsWorkspacePreparer()
      .prepare('sbx-enotdir', { baselinePath: resolve(dataRoot, 'baseline') })
      .then(() => null)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(WorkspacePrepareError);
    const wpe = error as WorkspacePrepareError;
    // ① 码属于词汇表 —— 前端查得到一句话。
    expect(wpe.code).toBe(WORKSPACE_PREPARE_FAILED);
    // ② errno 本身没有当成平台码出线…
    expect(wpe.code).not.toBe('ENOTDIR');
    // ③ …但也没有被丢掉：它在 cause 里，排查时找得回来。
    expect((wpe.cause as { code?: string } | undefined)?.code).toBe('ENOTDIR');
  });
});
