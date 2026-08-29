import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { platform } from 'node:os';
import { Injectable } from '@nestjs/common';
import { filesystemStatsFor } from '@platform/shared-kernel';
import { env } from '../../../config/env';
import type { DiagnoseCheck, DiagnoseCheckResult, DiagnoseContext } from './check.types';

/**
 * Linux `statfs.f_type` 魔数 → 文件系统名。
 *
 * ⚠️ **这张表只在 Linux 上有意义，而这一位曾经被漏掉。** macOS 的 `statfs.f_type` 是
 * **vfs 类型序号**而不是魔数（实测 APFS = `26` = `0x1a`），拿它查这张表得到的是
 * 「未知（magic 0x1a）」—— 一句听起来像故障、实际只说明我们查错了表的话。
 * 所以 `FS_MAGIC` 现在只在 `platform() === 'linux'` 时被查（见 `fsTypeName`）。
 *
 * ⚠️ **这张表只用来「说出名字」，不用来判定能力。** 能力由下面那次真实的克隆拷贝判定 ——
 * 名字会骗人（同一个 `btrfs` 挂载可以关掉 CoW，`overlay` 的能力取决于底层），
 * 而一次成功的 `--reflink=always` 不会。表里没有的魔数就如实说「未知」，不猜。
 */
const FS_MAGIC: Record<number, string> = {
  0xef53: 'ext2/ext3/ext4',
  0x9123683e: 'btrfs',
  0x58465342: 'xfs',
  0x01021994: 'tmpfs',
  0x794c7630: 'overlayfs',
  0x6969: 'nfs',
  0x2fc12fc1: 'zfs',
  0xff534d42: 'cifs',
  0x65735546: 'fuse',
};

/** reflink 探测的三态。⚠️ `unknown` 不是 `false` —— 见 `probeReflink`。 */
type ReflinkVerdict =
  | { kind: 'supported' }
  | { kind: 'unsupported'; reason: string }
  | { kind: 'unknown'; reason: string };

@Injectable()
export class DataRootFsCheck implements DiagnoseCheck {
  readonly id = 'data-root-fs' as const;
  readonly label = 'DATA_ROOT 文件系统';

  async run(ctx: DiagnoseContext): Promise<DiagnoseCheckResult> {
    const root = env.dataRoot;
    try {
      await mkdir(root, { recursive: true });
    } catch (e) {
      return {
        status: 'fail',
        summary: `DATA_ROOT 不可写：${root} —— ${(e as Error).message}`,
        hint: `平台的全部持久化（工作区 / 审计库 / 日志）都写在这里。确认目录存在且属主正确：ls -ld ${root}`,
        detail: { dataRoot: root },
      };
    }

    const stats = await filesystemStatsFor(root);
    const probed = stats?.probedPath ?? root;
    const fsLabel = (await fsTypeName(probed, stats?.fsTypeMagic, ctx)) ?? '未知';
    const reflink = await probeReflink(root, ctx);
    const detail = {
      dataRoot: root,
      fsType: fsLabel,
      platform: platform(),
      reflink: reflink.kind,
      ...(reflink.kind === 'supported' ? {} : { reflinkReason: reflink.reason }),
    };

    return { ...reflinkOutcome(reflink, { root, fsLabel, os: platform() }), detail };
  }
}

/**
 * 三态 verdict → 这一项**说什么**。
 *
 * ⚠️ 抽成纯函数不是仪式：产品规则（`unknown` 渲染成 ℹ️ 而不是 ⚠️、非 Linux 上**不给**
 * 换文件系统的建议）全在这里，而它们与「怎么探」是两件独立会错的事。分开之后这三个分支
 * 可以零 IO 穷举，不必依赖跑测试的那台机器恰好是哪个平台 —— 而 CI 是 Linux、开发机是
 * macOS，只测「当前平台那一条」等于两边各测一半。
 */
export function reflinkOutcome(
  verdict: ReflinkVerdict,
  ctx: { root: string; fsLabel: string; os: string },
): Pick<DiagnoseCheckResult, 'status' | 'summary' | 'hint'> {
  if (verdict.kind === 'supported') {
    return {
      status: 'ok',
      summary: `${ctx.root} 文件系统 ${ctx.fsLabel}，支持 reflink（CoW 加速就绪，工作区复制近乎零字节）`,
    };
  }
  if (verdict.kind === 'unknown') {
    // ⚠️ **「问不出来」既不是「支持」也不是「不支持」，所以它是 ℹ️ 而不是 ⚠️。**
    //    非 Linux 上这是**稳定**结论（见 `probeReflink`），所以它必须是一条安静的信息行 ——
    //    一个恒 ⚠️ 的检查项等于没有检查项：看久了就没人看了，还会把另外七项的可信度一起拉低。
    return {
      status: 'info',
      summary:
        `${ctx.root} 文件系统 ${ctx.fsLabel}（${ctx.os}）—— 本平台的工作区复制**不走 reflink 分支**` +
        '（`cp -a --reflink=auto` 只在 Linux 上跑，其余平台直接整份复制），所以 CoW 加速在这里无从谈起：' +
        '每个 Task 的工作区会实占一份完整副本。这是开发机形态的既定行为，不是可修的故障。',
      // ⛔ 刻意**不给** hint。这里没有任何该做的事 —— 在 macOS 上提示「换成 Btrfs/XFS」
      //    会让人以为必须换文件系统，而生产部署本来就在 Linux 上（11 §1 的建议是给那一侧的）。
    };
  }
  return {
    status: 'warn',
    summary: `${ctx.root} 文件系统 ${ctx.fsLabel}，不支持 reflink（${verdict.reason}）—— CoW 加速功能受限，每个 Task 工作区会实占一份完整副本`,
    hint: '把 DATA_ROOT 放到支持 reflink 的文件系统上（Btrfs / XFS with reflink=1）；不改也能用，只是更费磁盘（03 §1）',
  };
}

/**
 * 文件系统名 —— **按平台分支拿，不拿一张表硬套**。
 *
 * · Linux：`/proc/self/mountinfo` 直接写着 fstype，比魔数表更准也更全（表里没有的魔数
 *   不会退化成「未知（magic 0x…）」）；读不到才回落到 `FS_MAGIC`。
 * · darwin：`mount` 输出里括号中的第一项就是类型（`… on / (apfs, sealed, …)`）。
 * · 其余平台：如实说不知道。**不查 `FS_MAGIC`** —— 那张表是 Linux 的词汇表。
 *
 * 两条都取「**最长的、是目标路径前缀的**挂载点」，否则 `/` 会匹配一切。
 */
async function fsTypeName(
  probedPath: string,
  magic: number | undefined,
  ctx: DiagnoseContext,
): Promise<string | null> {
  const os = platform();
  if (os === 'linux') {
    const fromMount = await linuxFsType(probedPath);
    if (fromMount !== null) return fromMount;
    if (magic !== undefined) {
      return FS_MAGIC[magic] ?? `未知（magic 0x${magic.toString(16)}）`;
    }
    return null;
  }
  if (os === 'darwin') return darwinFsType(probedPath, ctx);
  return null;
}

async function linuxFsType(probedPath: string): Promise<string | null> {
  try {
    const text = await readFile('/proc/self/mountinfo', 'utf8');
    let best: { point: string; type: string } | null = null;
    for (const line of text.split('\n')) {
      const [before, after] = line.split(' - ');
      if (after === undefined) continue;
      const point = before.split(' ')[4];
      const type = after.split(' ')[0];
      if (point === undefined || type === undefined) continue;
      if (!isPrefixPath(point, probedPath)) continue;
      if (best === null || point.length > best.point.length) best = { point, type };
    }
    return best?.type ?? null;
  } catch {
    return null;
  }
}

async function darwinFsType(probedPath: string, ctx: DiagnoseContext): Promise<string | null> {
  const out = await run('/sbin/mount', [], ctx);
  if (out === null) return null;
  let best: { point: string; type: string } | null = null;
  for (const line of out.split('\n')) {
    const m = /^\S+ on (.+?) \(([^,)]+)/.exec(line);
    if (m === null) continue;
    const point = m[1]!;
    if (!isPrefixPath(point, probedPath)) continue;
    if (best === null || point.length > best.point.length) best = { point, type: m[2]! };
  }
  return best?.type ?? null;
}

/** `point` 是不是 `path` 的挂载点前缀（`/` 匹配一切，`/data` 不匹配 `/database`）。 */
function isPrefixPath(point: string, path: string): boolean {
  if (point === '/') return true;
  return path === point || path.startsWith(`${point}/`);
}

/**
 * reflink 能力 —— **探的必须是平台真正会用的那条路径**。
 *
 * ── 这里此前测错了东西 ─────────────────────────────────────────────────────
 * 第一版用 Node 的 `copyFile(..., COPYFILE_FICLONE_FORCE)`。实测（2026-08-28，macOS/APFS）
 * 它返回 **`ENOSYS`** —— 而 libuv 的 `FICLONE` 分支**只在 Linux 上存在**，所以那个 ENOSYS
 * 说的是「这个平台的 `copyFile` 不实现 reflink」，**不是**「这个文件系统不支持克隆」。
 * APFS 本身是支持 `clonefile(2)` 的。把前者当后者，就得到了那条错误结论：
 * 「不支持 reflink → 每个 Task 实占一份完整副本 → 建议换 Btrfs/XFS」——
 * 在一台文件系统完全没问题的机器上，指着一个不存在的故障。
 *
 * ── 现在探的是什么 ─────────────────────────────────────────────────────────
 * `FsWorkspacePreparer.importBaseline` 的真实行为是：**只在 `platform === 'linux'` 时**跑
 * `cp -a --reflink=auto`，其余平台直接 `fs.cp` 整份复制。所以：
 *
 * · **Linux** ⇒ 用 `cp --reflink=always` 探同一个工具。`always` 而不是 `auto` 是关键：
 *   `auto` 在不支持时**静默退化成整份复制并返回成功**，正好把「不支持」测成「支持」——
 *   与第一版必须用 `FICLONE_**FORCE**` 是同一个坑。`cp` 不认 `--reflink`（busybox）时
 *   回落到 Node 的 `FICLONE_FORCE`，那条路在 Linux 上是真的。
 * · **非 Linux** ⇒ 平台压根不会走 reflink，探它没有意义 ⇒ `unknown`，由调用方渲染成 ℹ️。
 *   ⚠️ 这不是「懒得测」：就算 APFS 能 clone，平台的复制路径也不会用到它，
 *   报「支持」同样是**对用户撒谎**（他会以为工作区不占空间）。
 */
async function probeReflink(root: string, ctx: DiagnoseContext): Promise<ReflinkVerdict> {
  const strategy = reflinkStrategy(platform());
  if (strategy.kind === 'not-applicable') return { kind: 'unknown', reason: strategy.reason };
  const src = join(root, `.reflink-probe-${String(process.pid)}`);
  const dst = `${src}.clone`;
  try {
    await writeFile(src, 'reflink probe');
    await rm(dst, { force: true });
    // ① 与平台同一个工具。`--reflink=always` ⇒ 不支持就报错，绝不静默退化。
    const viaCp = await run('cp', ['--reflink=always', src, dst], ctx);
    if (viaCp !== null) {
      return (await readFile(dst, 'utf8')) === 'reflink probe'
        ? { kind: 'supported' }
        : { kind: 'unsupported', reason: 'cp --reflink=always 产出的内容对不上' };
    }
    // ② busybox cp 之类不认 --reflink：退回 Node 的 FICLONE_FORCE（Linux 上它是真的）。
    await rm(dst, { force: true });
    await copyFile(src, dst, constants.COPYFILE_FICLONE_FORCE);
    return (await readFile(dst, 'utf8')) === 'reflink probe'
      ? { kind: 'supported' }
      : { kind: 'unsupported', reason: 'FICLONE 产出的内容对不上' };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    // Linux 上的 ENOSYS 同样是「问不出来」而不是「不支持」（老内核 / 不认识的 fs）。
    if (code === 'ENOSYS') return { kind: 'unknown', reason: 'ENOSYS' };
    return { kind: 'unsupported', reason: code ?? (e as Error).message };
  } finally {
    await rm(src, { force: true }).catch(() => undefined);
    await rm(dst, { force: true }).catch(() => undefined);
  }
}

/**
 * 这个平台该不该探 reflink —— **纯函数，因为它是一条关于平台的判断，不是一次测量**。
 *
 * ⚠️ 抽出来的直接原因是一次**变异存活**：把 `platform() !== 'linux'` 的短路删掉之后，
 * 全部用例照旧全绿 —— 在 macOS 上删掉短路会去跑 `cp --reflink=always`（macOS 的 cp 不认它）
 * 再退回 `FICLONE_FORCE`（darwin 恒 ENOSYS），**兜了一圈落到同一个 `unknown`**。
 * 结论虽然碰巧一样，但那条短路仍然是有意义的：它省掉两次没有意义的进程 spawn，
 * 更重要的是它让 `reason` 说得出**为什么**（「工作区复制不走 reflink 分支」）而不是丢一个
 * 读者无从解释的 `ENOSYS`。判断与测量分开之后，这条短路自己就可以被断言。
 */
export function reflinkStrategy(
  os: string,
): { kind: 'probe' } | { kind: 'not-applicable'; reason: string } {
  if (os === 'linux') return { kind: 'probe' };
  return {
    kind: 'not-applicable',
    reason: `${os}: 工作区复制不走 reflink 分支（workspace-preparer 仅在 Linux 上用 cp --reflink=auto）`,
  };
}

/** 跑一条命令，成功回 stdout；**命令不存在 / 退出码非 0 一律回 `null`**（= 这条路走不通）。 */
function run(cmd: string, args: string[], ctx: DiagnoseContext): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { timeout: Math.min(ctx.timeoutMs, 3000), signal: ctx.signal },
      (error, stdout) => resolve(error ? null : stdout),
    );
  });
}
