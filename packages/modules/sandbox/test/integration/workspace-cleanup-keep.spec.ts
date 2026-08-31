import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { FsWorkspacePreparer } from '../../src/infrastructure/workspace/workspace-preparer';

/**
 * `FsWorkspacePreparer.cleanup` 在**真实文件系统**上（03 §7.7 保留工作区）。
 *
 * ── 这个文件为什么必须存在 ──────────────────────────────────────────────────────
 * `cleanup(keep:true)` 报回来的那个 `hostPath` 是 application 层登记 `RetainedVolume`
 * （24 §3）**唯一**正当的路径来源。而 e2e 里的 `fakeWorkspace` 恒返回 `null`、单测
 * harness 返回的是一个假路径 —— 两边都不会碰真实现。实测过：把这里的
 * `return marked ? { hostPath } : null` 改成恒 `null`（= 登记这一步永远拿不到源，
 * 「已保留卷」永远是空的），**整套测试一条都不红**。这个文件就是那个洞。
 *
 * ── 每条断言钉住的变异 ──────────────────────────────────────────────────────────
 *  ① `return marked ? { hostPath } : null` 改成恒 `null` ⇒ 第一条红。
 *  ② `keep:false` 分支也返回 `{ hostPath }` ⇒ 第二条红（会去登记一个刚被 rm 掉的目录）。
 *  ③ 标记文件写的内容从 `kept` 改成别的 ⇒ 第一条红（启动对账靠这个标记区分
 *     `ready` 孤儿目录与真的保留卷，03 §7.6）。
 *  ④ 目录不存在时仍报回路径 ⇒ 第三条红。
 */
describe('FsWorkspacePreparer.cleanup —— keep 时必须把留下来的目录报回去', () => {
  const STATE_FILE = '.platform-workspace-state';
  const previousDataRoot = process.env.DATA_ROOT;
  let root: string;
  let preparer: FsWorkspacePreparer;

  beforeEach(() => {
    root = mkdtempSync(resolve(tmpdir(), 'platform-ws-cleanup-'));
    process.env.DATA_ROOT = resolve(root, 'data');
    preparer = new FsWorkspacePreparer();
  });

  afterEach(() => {
    if (previousDataRoot === undefined) delete process.env.DATA_ROOT;
    else process.env.DATA_ROOT = previousDataRoot;
    rmSync(root, { recursive: true, force: true });
  });

  const workspaceDir = (id: string) => resolve(root, 'data', 'workspaces', id);

  function seed(id: string): string {
    const dir = workspaceDir(id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, STATE_FILE), 'ready');
    writeFileSync(resolve(dir, 'result.md'), '# agent output');
    return dir;
  }

  it('★ keep:true ⇒ 目录留着、标记改成 kept、并把宿主路径报回去', async () => {
    const dir = seed('sbx-keep');
    const retained = await preparer.cleanup('sbx-keep', { keep: true });
    expect(retained).toEqual({ hostPath: dir });
    expect(existsSync(resolve(dir, 'result.md'))).toBe(true);
    expect(readFileSync(resolve(dir, STATE_FILE), 'utf8')).toBe('kept');
  });

  it('★ keep:false ⇒ 目录被删，且**不**报回路径（否则会去登记一个刚被 rm 掉的目录）', async () => {
    const dir = seed('sbx-drop');
    const retained = await preparer.cleanup('sbx-drop', { keep: false });
    expect(retained).toBeNull();
    expect(existsSync(dir)).toBe(false);
  });

  it('★ 目录压根不在（重放/半成品）⇒ keep:true 也报 null，不凭空造一条保留卷', async () => {
    expect(await preparer.cleanup('sbx-never-existed', { keep: true })).toBeNull();
  });

  it('keep:false 对一个不存在的目录是幂等的（provider.destroy 重放要靠这一点）', async () => {
    await expect(preparer.cleanup('sbx-never-existed', { keep: false })).resolves.toBeNull();
  });
});
