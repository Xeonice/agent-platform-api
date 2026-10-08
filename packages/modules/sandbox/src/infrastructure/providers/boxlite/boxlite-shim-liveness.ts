import { promises as fsp } from 'node:fs';
import { join } from 'node:path';
import { boxliteHome } from './boxlite-runtime';

/**
 * BoxLite 记录说「running」的 box，它的 shim 进程是不是真的还在。
 *
 * ── 为什么非问不可（读 0.9.7 源码确认）──────────────────────────────────────────
 * BoxLite 不配 health check 时**没有退出监视**：VM（`libkrun VM`，即 shim）被 `kill -9`
 * 之后，`getInfo` 照报 running —— 命中缓存的 BoxImpl 返回内存态，落到库里也还是 running。
 * 要等下一次 `metrics` / `exec` 在一个**新建的** BoxImpl 上 attach 失败，`CleanupGuard`
 * 才把记录标成 failed；而缓存里的 BoxImpl 什么时候被回收，取决于 V8 什么时候回收 JsBox。
 * ⇒ 只看 `getInfo`，helper 的存活复核与诊断在 VM 死后很可能一直说「在跑」，发版探针却按
 *    进程判它忙 —— 两边各说各的。
 *
 * ── 口径：与 BoxLite 自己的 `ProcessIdentity` 一致（`util/pid_file.rs` + `util/process.rs`）──
 * `boxes/<id>/shim.pid` = `<pid>\n<starttime>\n`：pid 是外层 bwrap（shim 进程树的根），
 * starttime 是它在 `/proc/<pid>/stat` 第 22 列的值。
 *   · `gone`    —— pid 文件不存在 / 进程不存在 / 已是僵尸 / starttime 对不上（pid 被复用）；
 *   · `alive`   —— 进程在，且 starttime 对得上（单行的旧格式只能比到「进程在」）；
 *   · `unknown` —— 其余一切读不出来、认不出来的情况。⛔ 不猜：调用方把 `gone` 读作「实例已死」，
 *                 误判的代价是 force remove 一个好好的 helper。
 * 主仓发版探针（`STOPPED_RESERVATIONS_PROBE`）对同一个文件、同一列做的是同一件事。
 *
 * ⚠️ 只在有 procfs 的地方成立（Linux）：`/proc/self/stat` 读不到 ⇒ `unknown`，macOS 上就是这样。
 * ⚠️ 那个 pid 属于 api 进程所在的 pid namespace：shim 由本进程 fork 出来，pid 文件是 fork 之后、
 *    bwrap 建新 namespace 之前写下的。
 * ⛔ 只读。不发信号、不删文件 —— 那是 BoxLite 自己的记账。
 */
export type ShimLiveness = 'alive' | 'gone' | 'unknown';

/** 读这两样东西只需要这几只手；注入进来，离线单测才跑得通（与 `boxlite-image-store` 同理）。 */
export interface ShimProbeIo {
  /** BoxLite 的 home（生产 = `boxliteHome()`）。 */
  home(): string;
  readFile(path: string): Promise<string>;
  /** procfs 挂在哪（生产 = `/proc`）。 */
  procRoot: string;
}

const HOST_IO: ShimProbeIo = {
  // ⚠️ 惰性取：测试里替身化的 `boxlite-runtime` 不一定带这个导出，取值失败也只落到 `unknown`。
  home: () => boxliteHome(),
  readFile: (path) => fsp.readFile(path, 'utf8'),
  procRoot: '/proc',
};

/** BoxLite 的 box id —— 拼路径之前先认形状，与发版探针同一条规则。 */
const BOX_ID = /^[A-Za-z0-9_-]{1,128}$/;

export async function shimLiveness(
  boxId: string,
  io: ShimProbeIo = HOST_IO,
): Promise<ShimLiveness> {
  if (!BOX_ID.test(boxId)) return 'unknown';
  try {
    // 先确认这里真有 procfs：没有的话，下面每个 pid 都会 ENOENT，被读成「进程不在」。
    await io.readFile(join(io.procRoot, 'self', 'stat'));
  } catch {
    return 'unknown';
  }

  let record: PidRecord | null;
  try {
    record = parsePidFile(await io.readFile(join(io.home(), 'boxes', boxId, 'shim.pid')));
  } catch (e: unknown) {
    // running 的记录必然有 pid 文件（BoxLite 先写它、后标 running）；没有 ⇒ shim 已不在。
    return isMissing(e) ? 'gone' : 'unknown';
  }
  if (record === null) return 'unknown';

  let stat: string;
  try {
    stat = await io.readFile(join(io.procRoot, String(record.pid), 'stat'));
  } catch (e: unknown) {
    return isMissing(e) ? 'gone' : 'unknown';
  }
  const proc = parseStat(stat);
  if (proc === null) return 'unknown';
  // 僵尸 = 已经退出、只是没人回收（发版探针里见过这种残留）；X = 正在被回收。
  if (proc.state === 'Z' || proc.state === 'X') return 'gone';
  if (record.startTime !== undefined && record.startTime !== proc.startTime) return 'gone';
  return 'alive';
}

interface PidRecord {
  pid: number;
  /** 十进制字符串原样比较，不经 number（tick 数可能超过 2^53 的精度不必去赌）。 */
  startTime?: string;
}

/**
 * `PidRecord::decode` 的同口径：第一行是 pid；第二行是 starttime，缺席或认不出 ⇒ 当旧格式。
 * 第一行都认不出 ⇒ `null`（调用方读作 `unknown`）。
 */
function parsePidFile(text: string): PidRecord | null {
  const [pidLine = '', startLine = ''] = text.split('\n');
  const pid = Number(pidLine.trim());
  if (!/^\d+$/.test(pidLine.trim()) || !Number.isSafeInteger(pid) || pid < 1) return null;
  const startTime = startLine.trim();
  return /^\d+$/.test(startTime) ? { pid, startTime } : { pid };
}

/**
 * `/proc/<pid>/stat`：`pid (comm) state ppid … starttime(第 22 列) …`。
 * ⚠️ comm 里可以有空格和右括号 —— 从**最后一个** `)` 切开，之后才按空白分列
 * （BoxLite 与发版探针都这么切）。
 */
function parseStat(stat: string): { state: string; startTime: string } | null {
  const close = stat.lastIndexOf(')');
  if (close < 0) return null;
  const fields = stat
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  const state = fields[0];
  const startTime = fields[19];
  if (state === undefined || startTime === undefined || !/^\d+$/.test(startTime)) return null;
  return { state, startTime };
}

function isMissing(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  return code === 'ENOENT' || code === 'ESRCH';
}
