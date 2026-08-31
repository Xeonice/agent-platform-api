import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import {
  ArchiveDiskInsufficientError,
  assertArchiveDiskSpace,
  diskUsageBytes,
  listWorkspaceArchiveEntries,
  packTarToFile,
  planTarArchive,
  tarReadable,
} from '../../src/fs/tar-archive';

/**
 * 打包口径（shared/10 §6 定案 2026-08-31）在**真实文件系统 + 真 git** 上的验证。
 *
 * ── 为什么这个文件必须跑在真 fs / 真 git 上 ──────────────────────────────────────
 * 整条设计押在一句话上：**tar 的大小是确定的算术，可以在写第一个字节之前精确算出来**
 * —— 那个数就是 `Content-Length`。用替身测「plan 说 N、write 也说 N」证明不了任何事：
 * 两边读的是同一份假数据。只有真的把字节写出来、数一遍，才谈得上「相等」。
 * 同理，「按 git 口径挑内容」的全部价值在于 `.gitignore` 真的被 git 解释了一遍。
 *
 * ── 每组断言钉住的变异 ──────────────────────────────────────────────────────────
 *  ① `planTarArchive` 少算结尾那两个全零块（或漏掉 padding）⇒「字节数逐字节相等」红。
 *  ② `--exclude-standard` 去掉、或把 `.git` 那一段删掉 ⇒「git 口径」那组红。
 *  ③ PAX 长名分支删掉（长于 100 字节的路径直接截断）⇒「长路径可还原」红 + 长度断言红。
 *  ④ `diskUsageBytes` 改成读 `st.size`（逻辑大小而非已分配块）⇒ 稀疏文件那条红。
 */
describe('tar 打包：大小是确定的算术，内容按 git 口径挑', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(resolve(tmpdir(), 'platform-tar-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  async function drain(stream: NodeJS.ReadableStream): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks);
  }

  it('★ plan 的 totalBytes 与真正写出去的字节数**逐字节相等** —— 它就是 Content-Length', async () => {
    writeFileSync(resolve(root, 'a.txt'), 'x'.repeat(1)); // 1 字节 ⇒ 511 字节 padding
    writeFileSync(resolve(root, 'b.bin'), Buffer.alloc(512)); // 正好一个块，padding 为 0
    writeFileSync(resolve(root, 'c.bin'), Buffer.alloc(513)); // 跨块 ⇒ 511 字节 padding
    mkdirSync(resolve(root, 'sub'));
    writeFileSync(resolve(root, 'sub/d.txt'), 'hello');

    const plan = planTarArchive(await listWorkspaceArchiveEntries(root));
    const bytes = await drain(tarReadable(plan));
    expect(bytes.length).toBe(plan.totalBytes);
    // 算术本身：4 个文件 = 4 个头 + 内容补齐到 512 + 结尾两个全零块
    expect(plan.totalBytes).toBe(4 * 512 + 512 + 512 + 1024 + 512 + 2 * 512);
  });

  it('★ 系统 tar 解得开，且解出来的内容与源一致', async () => {
    writeFileSync(resolve(root, 'a.txt'), 'hello tar');
    mkdirSync(resolve(root, 'nested/deep'), { recursive: true });
    writeFileSync(resolve(root, 'nested/deep/b.txt'), 'nested payload');

    const plan = planTarArchive(await listWorkspaceArchiveEntries(root));
    const archive = resolve(root, '..', 'out.tar');
    writeFileSync(archive, await drain(tarReadable(plan)));

    const out = mkdtempSync(resolve(tmpdir(), 'platform-tar-out-'));
    try {
      execFileSync('tar', ['-xf', archive, '-C', out]);
      const listed = execFileSync('tar', ['-tf', archive], { encoding: 'utf8' });
      expect(listed).toContain('a.txt');
      expect(listed).toContain('nested/deep/b.txt');
      expect(execFileSync('cat', [resolve(out, 'nested/deep/b.txt')], { encoding: 'utf8' })).toBe(
        'nested payload',
      );
    } finally {
      rmSync(out, { recursive: true, force: true });
      rmSync(archive, { force: true });
    }
  });

  it('★ 超过 100 字节的路径经 PAX 扩展头原样还原（不是被截断）', async () => {
    const deep = 'a'.repeat(60) + '/' + 'b'.repeat(60) + '/' + 'c'.repeat(60);
    mkdirSync(resolve(root, deep), { recursive: true });
    const longName = `${deep}/${'d'.repeat(120)}.txt`;
    writeFileSync(resolve(root, longName), 'long');

    const plan = planTarArchive(await listWorkspaceArchiveEntries(root));
    const archive = resolve(root, '..', 'long.tar');
    writeFileSync(archive, await drain(tarReadable(plan)));
    try {
      const listed = execFileSync('tar', ['-tf', archive], { encoding: 'utf8' });
      expect(listed).toContain(longName);
    } finally {
      rmSync(archive, { force: true });
    }
  });

  it('符号链接按链接打包，不跟随（否则会把链接目标复制进包里）', async () => {
    writeFileSync(resolve(root, 'real.txt'), 'payload');
    symlinkSync('real.txt', resolve(root, 'link.txt'));

    const entries = await listWorkspaceArchiveEntries(root);
    const link = entries.find((e) => e.name === 'link.txt');
    expect(link?.type).toBe('symlink');
    expect(link?.linkname).toBe('real.txt');
    expect(link?.size).toBe(0);

    const plan = planTarArchive(entries);
    expect((await drain(tarReadable(plan))).length).toBe(plan.totalBytes);
  });

  describe('git 口径（10 §6：真正的体积杀手是这条排除，不是压缩）', () => {
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', root, ...args], {
        encoding: 'utf8',
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 't',
          GIT_AUTHOR_EMAIL: 't@e',
          GIT_COMMITTER_NAME: 't',
          GIT_COMMITTER_EMAIL: 't@e',
        },
      });

    beforeEach(() => {
      git('init', '-q', '-b', 'main');
      writeFileSync(resolve(root, '.gitignore'), 'node_modules/\ndist/\n');
      writeFileSync(resolve(root, 'tracked.ts'), 'export const a = 1;');
      git('add', '-A');
      git('commit', '-qm', 'init');
      // 未跟踪但没被 ignore ⇒ **进包**（agent 刚写出来的成果就长这样）
      writeFileSync(resolve(root, 'untracked-result.md'), '# done');
      // .gitignore 命中的 ⇒ **不进包**
      mkdirSync(resolve(root, 'node_modules/left-pad'), { recursive: true });
      writeFileSync(resolve(root, 'node_modules/left-pad/index.js'), 'module.exports=1');
      mkdirSync(resolve(root, 'dist'));
      writeFileSync(resolve(root, 'dist/bundle.js'), 'x'.repeat(4096));
    });

    it('已跟踪 + 未跟踪未 ignore 进包；.gitignore 命中的一条都不进', async () => {
      const names = (await listWorkspaceArchiveEntries(root)).map((e) => e.name);
      expect(names).toContain('tracked.ts');
      expect(names).toContain('untracked-result.md');
      expect(names).toContain('.gitignore');
      expect(names.some((n) => n.startsWith('node_modules/'))).toBe(false);
      expect(names.some((n) => n.startsWith('dist/'))).toBe(false);
    });

    it('★ `.git` 保留 —— 没它就丢了全部历史，「拿走继续用」这个意图不成立', async () => {
      const names = (await listWorkspaceArchiveEntries(root)).map((e) => e.name);
      expect(names.some((n) => n === '.git/HEAD')).toBe(true);
      expect(names.some((n) => n.startsWith('.git/refs/'))).toBe(true);
    });

    it('排除是真的省了体积：包比目录小一个数量级', async () => {
      const packed = planTarArchive(await listWorkspaceArchiveEntries(root)).totalBytes;
      const onDisk = await diskUsageBytes(root);
      expect(packed).toBeLessThan(onDisk);
    });
  });

  it('★ 空项目没有 git ⇒ 回落到整目录遍历，而不是打出一个空包', async () => {
    // 刻意不 `git init`。这是「空项目」在生产上的真实形状（03 §7.1：空基线 ⇒ 空工作区，
    // agent 此后往里写东西，但从没有人 `git init` 过）。
    writeFileSync(resolve(root, 'agent-output.txt'), 'result');
    mkdirSync(resolve(root, 'out'));
    writeFileSync(resolve(root, 'out/report.md'), '# report');

    const names = (await listWorkspaceArchiveEntries(root)).map((e) => e.name);
    expect(names).toContain('agent-output.txt');
    expect(names).toContain('out/report.md');

    const plan = planTarArchive(await listWorkspaceArchiveEntries(root));
    expect((await drain(tarReadable(plan))).length).toBe(plan.totalBytes);
  });

  /**
   * ⚠️ **落盘那一路才判水位，流式那一路不判 —— 这不是漏了。**
   *
   * P21-8 §4 的「立即备份」要先把 SQLite dump + 卷写成一个文件再交给下载，那一份真的
   * 占磁盘，而磁盘是本项目的真实瓶颈（03 §1）⇒ `packTarToFile` 写第一个字节之前判一次，
   * 判据与 `WorkspacePreparer.assertDiskSpace()` 同类（一个 floor，不是精确需求量）。
   *
   * ⛔ 保留卷的 `/archive` 是纯流式（tar 直接写进 HTTP 响应，一个临时文件都不产生），
   * 它**不调**这个函数：对一个不写盘的操作做水位判断，唯一效果是在盘满时拒绝一个本来
   * 能成功的下载 —— 而下载正是用户腾出空间的手段。
   */
  describe('落盘形态的打包（P21-8 §4 备份共用的那一套）', () => {
    it('写出来的字节数与 plan 一致，内容与流式那一路逐字节相同', async () => {
      writeFileSync(resolve(root, 'a.txt'), 'same bytes either way');
      const plan = planTarArchive(await listWorkspaceArchiveEntries(root));
      const dest = resolve(root, '..', 'packed.tar');
      try {
        expect(await packTarToFile(plan, dest)).toBe(plan.totalBytes);
        const streamed = await drain(tarReadable(plan));
        // ⚠️ 这里**不用** `cmp -s dest /dev/stdin`（上一版那么写，CI 上必挂）：
        //    `/dev/stdin` 在 Linux 下配合 execFileSync 的管道 input 拿不到，`cmp` 退出码是
        //    **2（错误）而不是 1（不同）** —— 于是失败信息说的是"内容不一致"，实际是
        //    命令根本没跑成。macOS 上却是过的，典型的「本地绿 CI 红」。
        //    Buffer 比对不需要外部进程，跨平台，而且长度先断一次让失败信息更有用。
        const onDisk = readFileSync(dest);
        expect(onDisk.length).toBe(streamed.length);
        expect(Buffer.compare(onDisk, streamed)).toBe(0);
      } finally {
        rmSync(dest, { force: true });
      }
    });

    it('★ 水位不够就在写第一个字节之前拒（floor，与 WorkspacePreparer 同类判据）', async () => {
      writeFileSync(resolve(root, 'a.txt'), 'x');
      const plan = planTarArchive(await listWorkspaceArchiveEntries(root));
      // 要一个大到任何机器都给不出的 floor —— 判据成立与否与本机剩余空间无关
      await expect(
        assertArchiveDiskSpace(root, plan.totalBytes, Number.MAX_SAFE_INTEGER),
      ).rejects.toBeInstanceOf(ArchiveDiskInsufficientError);
      // 0 floor ⇒ 放行（证明上面那条红的是水位判断本身，不是这个函数恒抛）
      await expect(assertArchiveDiskSpace(root, 0, 0)).resolves.toBeUndefined();
    });
  });

  it('diskUsageBytes 走已分配块（`du` 口径），不是 st.size 的逻辑大小', async () => {
    // 一个 4 字节的文件在任何真实文件系统上都至少占一个块（≥512 字节）——
    // 读 `st.size` 会得到 4，读 `st.blocks * 512` 才是「删掉能拿回多少」。
    writeFileSync(resolve(root, 'tiny.txt'), 'abcd');
    expect(await diskUsageBytes(root)).toBeGreaterThan(512);
  });
});
