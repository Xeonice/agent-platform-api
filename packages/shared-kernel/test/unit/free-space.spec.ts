import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const statfs = vi.hoisted(() => vi.fn());
vi.mock('node:fs/promises', async (orig) => ({
  ...(await orig<typeof import('node:fs/promises')>()),
  statfs,
}));

/**
 * `df` 的替身。
 *
 * ⚠️ 打桩的是 `node:child_process` 的 `execFile` 回调形态，而实现用的是
 * `promisify(execFile)` —— promisify 认的是「最后一个参数是 (err, result) 回调」这个
 * 约定，所以替身必须照着调回调，⛔ 不能直接 `mockResolvedValue`。
 */
const execFileMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async (orig) => ({
  ...(await orig<typeof import('node:child_process')>()),
  execFile: execFileMock,
}));

/** 让下一次 df 调用回这段 stdout（`null` = 让 df 失败）。 */
function stubDf(stdout: string | null): void {
  execFileMock.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: unknown) => {
    const done = cb as (e: Error | null, r?: { stdout: string; stderr: string }) => void;
    if (stdout === null) done(new Error('df: not found'));
    else done(null, { stdout, stderr: '' });
  });
}

const { availableBytesFor, filesystemStatsFor } = await import('../../src/fs/free-space');

/**
 * ★ 两个磁盘预检共用的那段算术 —— 2026-08 之前它**零覆盖**。
 *
 * ── 为什么"有测试"却没有覆盖 ──────────────────────────────────────────────────
 * `clone-disk-precheck.spec.ts` 有一整套磁盘预检用例，但它们全部通过
 * `FakeBaselineManager.available = <数字>` 打桩 —— 也就是说，被验证的是 workflow 的
 * 判断逻辑（`available >= minFree` 就放行），**真正有讲究的那段算术被替身架空了**。
 * 真实的 `availableBytes` 从来没有被任何一条断言碰过。
 *
 * 这正是 LIVE-RUN-FINDINGS 共性 2 的形态：绿灯不等于覆盖。得问一句"它红过吗"。
 *
 * ── 这段算术有两个不显眼的讲究 ────────────────────────────────────────────────
 * 下面两条分别钉住它们。两条都用 mock 而非真实文件系统，是因为真机上 `bavail` 与
 * `bfree` 的差值取决于文件系统类型与保留块设置 —— 在 APFS 上跑可能恰好相等，于是
 * 一条"在开发机上碰巧绿"的测试会漏掉 ext4 生产机上 5% 的虚账。
 */
describe('availableBytesFor：bavail，不是 bfree', () => {
  afterEach(() => {
    statfs.mockReset();
  });

  it('用非特权可用块，不用总空闲块 —— 差值是 root 保留块，平台进程不是 root', async () => {
    // 一个典型的 ext4：5% 保留给 root。bfree 比 bavail 多整整那一份。
    statfs.mockResolvedValue({ bavail: 100n, bfree: 1000n, bsize: 4096 });

    // MUTATION: 把实现里的 `fs.bavail` 换成 `fs.bfree` ⇒ 这里得到 4096000，红。
    // 在真机上做同样的替换**不会有任何测试变红**，而生产后果是：预检把 root 保留的
    // 那 5%（200 GiB 盘上是 10 GiB）算成自己能用的，放行一个注定 ENOSPC 的 clone。
    expect(await availableBytesFor('/anywhere')).toBe(100 * 4096);
  });

  it('bigint 与 number 混用不会算错 —— statfs 在不同平台上返回类型不一致', async () => {
    statfs.mockResolvedValue({ bavail: 2n, bfree: 2n, bsize: 512 });
    expect(await availableBytesFor('/anywhere')).toBe(1024);
  });
});

describe('availableBytesFor：祖先回溯是常规路径，不是兜底分支', () => {
  afterEach(() => {
    statfs.mockReset();
  });

  it('目标目录尚不存在 ⇒ 量最近的已存在祖先', async () => {
    // 预检跑在目标目录**被创建之前**（这正是"预"的含义），所以 ENOENT 是常态。
    // MUTATION: 删掉回溯、直接把异常吞成 Infinity ⇒ 这里得到 Infinity，红 ——
    // 而那个变异在生产里是**静默**的：预检永远返回"空间无限"，只放行、永不误报，
    // 从外面看和"预检工作正常"一模一样。
    statfs.mockImplementation((p: string) => {
      if (p === '/data') return Promise.resolve({ bavail: 7n, bfree: 7n, bsize: 1024 });
      return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    });

    expect(await availableBytesFor('/data/baselines/prj-1/not-created-yet')).toBe(7 * 1024);
  });

  it('一路到根都量不到 ⇒ Infinity（不拦），而不是 0（拦死一切）', async () => {
    statfs.mockRejectedValue(Object.assign(new Error('EACCES'), { code: 'EACCES' }));
    // 量不出来的预检不该拒绝一个本来能成功的操作；真正的盘满由事后的 ENOSPC 分类兜底。
    // 返回 0 会让每一次 clone / 每一个 Task 都被预检拒绝 —— 平台直接不可用。
    expect(await availableBytesFor('/x/y/z')).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('availableBytesFor：真实文件系统上的行为', () => {
  let dir: string;
  beforeEach(() => {
    statfs.mockReset();
    dir = mkdtempSync(resolve(tmpdir(), 'free-space-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('不打桩时给出有限正数，且未创建的子路径回溯到同一个文件系统', async () => {
    const real = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    statfs.mockImplementation(real.statfs as typeof statfs);

    const here = await availableBytesFor(dir);
    expect(Number.isFinite(here)).toBe(true);
    expect(here).toBeGreaterThan(0);

    // 同一个文件系统上，一条还不存在的深路径必须回溯到同一个盘。
    //
    // ⚠️ 断言的是「同一个数量级」而不是「相等」。第一版写了 `toBe(here)`，在全量跑时挂了：
    // 两次 statfs 之间隔着几毫秒，而这是一块**活的**盘 —— 别的进程在写，实测差了 24 MB。
    // 精确的算术由上面的 mock 用例钉死（那里 bavail/bsize 是常量）；这条真机用例只负责
    // 回答「回溯有没有落到同一个文件系统上」，容差 1% 足够区分「同一个盘」与「根本没回溯」
    // （没回溯会返回 Infinity，差着无穷远）。
    const unborn = await availableBytesFor(resolve(dir, 'a/b/c/not-created-yet'));
    expect(Number.isFinite(unborn)).toBe(true);
    expect(Math.abs(unborn - here) / here).toBeLessThan(0.01);
  });
});

/**
 * ★ `bsize` 未必是「块计数的单位」—— 2026-09-18 在一台真机上撞出来的。
 *
 * ── 事实 ──────────────────────────────────────────────────────────────────────
 * POSIX 说 `f_blocks/f_bfree/f_bavail` 的单位是 **`f_frsize`**，不是 `f_bsize`。两者在
 * ext4/xfs/APFS 上恰好相等，所以拿 `bsize` 算了很久都是对的；而 Node 的 `statfs`
 * **根本不暴露 `f_frsize`**（v22 实测只有七个字段）。
 *
 * 容器里 bind 进来的宿主目录（virtiofs / gRPC-FUSE）把 `f_bsize` 报成传输尺寸 1 MiB，
 * 于是 926 GB 被算成 231 TB —— **虚报 256 倍**，OrbStack 与 Docker Desktop 都复现。
 * 而 `DATA_ROOT` 恰恰就是那个 bind mount ⇒ 每一个 macOS 部署都中。
 *
 * ── 为什么必须有这几条 ────────────────────────────────────────────────────────
 * 这段算术的下游是 clone / workspace 复制 / tar 解包 / 调度器容量 的预检分母。
 * 虚报 256 倍不会让任何东西报错，它只是**让所有磁盘门禁静默放行** —— 然后在真的写满
 * 时以 ENOSPC 收场，而那正是这些预检存在的全部理由。⚠️ 真机上跑这套断言是测不出来的：
 * 开发机的 APFS 上 `bsize === frsize`，这条路径永远走不到。
 */
describe('bsize 不是片段大小时：不能拿它当单位', () => {
  afterEach(() => {
    statfs.mockReset();
    execFileMock.mockReset();
  });

  it('bsize=1MiB（FUSE 的传输尺寸）⇒ 改问 df，而不是算出 256 倍的数', async () => {
    // 实测值：OrbStack 把 bind mount 的 bsize 报成 1048576，blocks 仍是 4KiB 单位。
    statfs.mockResolvedValue({ blocks: 242824745n, bavail: 172452586n, bsize: 1048576, type: 0 });
    // df 报的是真相（1024 字节块）：926 GiB 总 / 658 GiB 可用。
    stubDf(
      'Filesystem 1024-blocks      Used Available Capacity Mounted on\n' +
        'mac          971298980 281808620 689490360      30% /data\n',
    );

    const stats = await filesystemStatsFor('/data');
    // MUTATION: 把实现里的 `capacityFromStatfs(fs) ?? await capacityFromDf(probe)`
    //   换回 `blocks * bsize` ⇒ 这里得到 254599771586560（231 TB），红。
    expect(stats?.totalBytes).toBe(971298980 * 1024);
    expect(stats?.availableBytes).toBe(689490360 * 1024);
  });

  it('df 的第一列含空格也解析得对 —— ⛔ 不能按列切', async () => {
    statfs.mockResolvedValue({ blocks: 1n, bavail: 1n, bsize: 1048576, type: 0 });
    stubDf(
      'Filesystem 1024-blocks Used Available Capacity Mounted on\n' +
        'My Fancy Volume  1000  400  600  40% /mnt/some dir\n',
    );
    const stats = await filesystemStatsFor('/mnt/some dir');
    expect(stats?.totalBytes).toBe(1000 * 1024);
    expect(stats?.availableBytes).toBe(600 * 1024);
  });

  it('⛔⛔ bsize 可疑且 df 也答不上来 ⇒ 回 null，不许退回那个已知错的大数', async () => {
    statfs.mockResolvedValue({ blocks: 242824745n, bavail: 172452586n, bsize: 1048576, type: 0 });
    stubDf(null);

    // 一个已知虚报 256 倍的数，比「量不到」坏得多：它会把所有磁盘门禁静默放行。
    expect(await filesystemStatsFor('/data')).toBeNull();
    // 而预检侧收到「量不到」时的既定口径是不拦（见 availableBytesFor 抬头）。
    expect(await availableBytesFor('/data')).toBe(Number.POSITIVE_INFINITY);
  });

  it('64 KiB 仍然当作真实片段大小 —— ext4/xfs 的合法上限，不该被误伤', async () => {
    statfs.mockResolvedValue({ blocks: 10n, bavail: 4n, bsize: 65536, type: 0 });
    stubDf(null); // 不该被用到

    expect(await availableBytesFor('/x')).toBe(4 * 65536);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('原生文件系统（bsize=4096）一次 df 都不调 —— 这条路径必须零额外开销', async () => {
    statfs.mockResolvedValue({ blocks: 100n, bavail: 50n, bsize: 4096, type: 0 });
    stubDf(null);

    expect(await availableBytesFor('/x')).toBe(50 * 4096);
    expect(execFileMock).not.toHaveBeenCalled();
  });
});
