import { createReadStream } from 'node:fs';
import { lstat, readdir, readlink, open } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { join, posix, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { promisify } from 'node:util';
import { availableBytesFor } from './free-space';

const execFileAsync = promisify(execFile);

/**
 * 平台**唯一**的打包机制（shared/10 §6「保留卷的打包口径」定案 2026-08-31）。
 *
 * 两个消费方共用这一份：`GET /api/retained-volumes/:id/archive`（保留卷整包下载，
 * 03 §7.7）与 `P21-8 §4` 的「立即备份」（SQLite + 可选卷 → 下载）。各写一套的代价
 * 在文档里写死了：**两个打包路径、两处磁盘水位判断，以后修一个漏一个**。
 *
 * ── 三条定案，都不要在这里推翻 ───────────────────────────────────────────────
 *
 * ① **tar，不压缩。** gzip 之后的大小只有真压完才知道（内容熵决定），而响应头必须
 *    **先**发 ⇒ 边压边传就给不出 `Content-Length` ⇒ 浏览器进度条显示「未知大小」。
 *    tar 的大小是**确定的算术**（内容 + 512 字节块头 + padding），可以在写第一个
 *    字节之前精确算出来 ⇒ 浏览器原生进度条直接可用、前端零代码。代价实测只有 9 MB
 *    （14 MB vs 4.8 MB）。
 *    ⛔ **流式直出 + 压缩 + 精确进度，三者不可兼得**，别在这里加 gzip。
 *
 * ② **按 git 口径挑内容**（{@link listWorkspaceArchiveEntries}）：已跟踪 + 未跟踪且
 *    未被 ignore，`.gitignore` 命中的一律不打包，**`.git` 保留**。实测本仓 web 工作区
 *    1.0 GB → 14 MB（砍掉 98.6%）——真正的体积杀手是这条排除，不是压缩。
 *
 * ③ **`totalBytes` 必须与真正写出去的字节数逐字节相等**，因为它就是 `Content-Length`。
 *    带**错**长度的流会在那个字节被截断、或吊死在永远不会到来的字节上——比不带长度
 *    （chunked，只是没有进度条）坏得多。{@link planTarArchive} 与 {@link tarReadable}
 *    因此走**同一份 entry 列表**，且写入侧对「计划之后文件变了」做了兜底（见下）。
 */

const BLOCK = 512;
const ZERO_BLOCK = Buffer.alloc(BLOCK);

export type TarEntryType = 'file' | 'dir' | 'symlink';

export interface TarEntry {
  /** 归档内路径，POSIX 分隔符，无前导 `/`。 */
  name: string;
  type: TarEntryType;
  /** 宿主绝对路径；`dir` 无。 */
  source?: string;
  /** 内容字节数；`dir` / `symlink` 恒 0。 */
  size: number;
  mode: number;
  mtimeSec: number;
  /** `symlink` 的目标。 */
  linkname?: string;
}

export interface TarPlan {
  entries: TarEntry[];
  /** 归档的**精确**字节数 —— 与 `Content-Length` 同一个数。 */
  totalBytes: number;
}

/** 一条 entry 在归档里占的字节数（含它可能需要的 PAX 扩展头）。 */
function entryBytes(entry: TarEntry): number {
  const pax = paxDataFor(entry);
  const paxBytes = pax === null ? 0 : BLOCK + roundUpToBlock(pax.length);
  return paxBytes + BLOCK + roundUpToBlock(entry.size);
}

function roundUpToBlock(n: number): number {
  return Math.ceil(n / BLOCK) * BLOCK;
}

/**
 * 计划一次归档：算出每条 entry 以及**总字节数**。
 *
 * ⚠️ 这里就是 ③ 的落点。`totalBytes` 不是估算：`512 字节头 + 内容 + 补齐到 512 的
 * padding + 结尾两个全零块`，每一项都是可数的。
 */
export function planTarArchive(entries: TarEntry[]): TarPlan {
  let total = 0;
  for (const entry of entries) total += entryBytes(entry);
  // POSIX: 归档以两个全零块结尾。
  return { entries, totalBytes: total + 2 * BLOCK };
}

/**
 * 把计划好的归档写成一条可读流。
 *
 * ⚠️ **写出的字节数与 `plan.totalBytes` 严格相等，即使文件在计划之后变了。** 读到的
 * 内容短了就补零、长了就截断（{@link streamFileExactly}）。这不是掩盖问题：一个保留卷
 * 是**已销毁**沙箱的目录，没有写者，真出现偏差说明有人在旁边动它——那时候「下载包
 * 里有一段零」远好过「浏览器吊死在一个永远不来的字节上」。
 */
export function tarReadable(plan: TarPlan): Readable {
  return Readable.from(generateTar(plan));
}

async function* generateTar(plan: TarPlan): AsyncGenerator<Buffer> {
  for (const entry of plan.entries) {
    const pax = paxDataFor(entry);
    if (pax !== null) {
      yield buildHeader(
        {
          name: paxHeaderName(entry.name),
          type: 'file',
          size: pax.length,
          mode: 0o644,
          mtimeSec: entry.mtimeSec,
        },
        'x',
      );
      yield pax;
      yield* padding(pax.length);
    }
    yield buildHeader(entry, typeflagOf(entry.type));
    if (entry.type === 'file' && entry.source !== undefined && entry.size > 0) {
      yield* streamFileExactly(entry.source, entry.size);
      yield* padding(entry.size);
    }
  }
  yield ZERO_BLOCK;
  yield ZERO_BLOCK;
}

function* padding(size: number): Generator<Buffer> {
  const pad = roundUpToBlock(size) - size;
  if (pad > 0) yield Buffer.alloc(pad);
}

/**
 * 读出**恰好** `size` 字节：短了补零，长了丢弃多余部分。见 {@link tarReadable} 的注释
 * ——`Content-Length` 已经发出去了，字节数不能再变。
 */
async function* streamFileExactly(source: string, size: number): AsyncGenerator<Buffer> {
  let sent = 0;
  try {
    const stream = createReadStream(source);
    for await (const chunk of stream) {
      const buf = chunk as Buffer;
      if (sent >= size) break;
      const slice = sent + buf.length > size ? buf.subarray(0, size - sent) : buf;
      sent += slice.length;
      yield slice;
    }
  } catch {
    /* 文件在计划之后消失/不可读 ⇒ 下面补零，长度照旧成立 */
  }
  if (sent < size) yield Buffer.alloc(size - sent);
}

function typeflagOf(type: TarEntryType): string {
  return type === 'dir' ? '5' : type === 'symlink' ? '2' : '0';
}

/**
 * ustar 头块。长名走 `prefix`(155) + `name`(100) 拆分；拆不开的由调用方先写一个 PAX
 * 扩展头（`paxDataFor`），这里再写一个被截断的名字兜底给不认 PAX 的解包器。
 */
function buildHeader(
  entry: Pick<TarEntry, 'name' | 'type' | 'size' | 'mode' | 'mtimeSec' | 'linkname'>,
  typeflag: string,
): Buffer {
  const header = Buffer.alloc(BLOCK);
  const { name, prefix } = splitName(entry.name);
  header.write(name, 0, 100, 'utf8');
  writeOctal(header, entry.mode & 0o7777, 100, 8);
  writeOctal(header, 0, 108, 8); // uid —— 不带宿主 uid：那是部署布局的一部分
  writeOctal(header, 0, 116, 8); // gid
  writeOctal(header, entry.size, 124, 12);
  writeOctal(header, entry.mtimeSec, 136, 12);
  header.write('        ', 148, 8, 'ascii'); // 校验和先填 8 个空格
  header.write(typeflag, 156, 1, 'ascii');
  if (entry.linkname !== undefined) header.write(entry.linkname, 157, 100, 'utf8');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  header.write(prefix, 345, 155, 'utf8');
  let sum = 0;
  for (const b of header) sum += b;
  // 校验和自身: 6 位八进制 + NUL + 空格（POSIX 规定的那一种写法）
  header.write(sum.toString(8).padStart(6, '0'), 148, 6, 'ascii');
  header.write('\0 ', 154, 2, 'ascii');
  return header;
}

function writeOctal(buf: Buffer, value: number, offset: number, len: number): void {
  buf.write(
    Math.max(0, Math.trunc(value))
      .toString(8)
      .padStart(len - 1, '0') + '\0',
    offset,
    len,
    'ascii',
  );
}

/** name ≤100 直接用；否则找一个 `/` 把它劈成 prefix(≤155) + name(≤100)。 */
function splitName(full: string): { name: string; prefix: string } {
  if (Buffer.byteLength(full) <= 100) return { name: full, prefix: '' };
  const parts = full.split('/');
  for (let i = 1; i < parts.length; i++) {
    const prefix = parts.slice(0, i).join('/');
    const name = parts.slice(i).join('/');
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) return { name, prefix };
  }
  // 劈不开 ⇒ PAX 扩展头承载真名，这里只留一个截断的占位
  return { name: truncateUtf8(full, 100), prefix: '' };
}

function truncateUtf8(value: string, maxBytes: number): string {
  let out = value;
  while (Buffer.byteLength(out) > maxBytes) out = out.slice(0, -1);
  return out;
}

function needsPax(entry: TarEntry): { path?: string; linkpath?: string } | null {
  const records: { path?: string; linkpath?: string } = {};
  const { name, prefix } = splitName(entry.name);
  const roundTrip = prefix === '' ? name : `${prefix}/${name}`;
  if (roundTrip !== entry.name) records.path = entry.name;
  if (entry.linkname !== undefined && Buffer.byteLength(entry.linkname) > 100) {
    records.linkpath = entry.linkname;
  }
  return records.path === undefined && records.linkpath === undefined ? null : records;
}

/** PAX 扩展头的数据块（`"<len> key=value\n"` 串联），没有需要则 `null`。 */
function paxDataFor(entry: TarEntry): Buffer | null {
  const records = needsPax(entry);
  if (records === null) return null;
  const parts: string[] = [];
  if (records.path !== undefined) parts.push(paxRecord('path', records.path));
  if (records.linkpath !== undefined) parts.push(paxRecord('linkpath', records.linkpath));
  return Buffer.from(parts.join(''), 'utf8');
}

/** `"%d %s=%s\n"`，其中 %d 是**含它自己**的记录总长度——所以要迭代到不动点。 */
function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  let len = Buffer.byteLength(body) + 1;
  for (;;) {
    const candidate = `${String(len)}${body}`;
    const actual = Buffer.byteLength(candidate);
    if (actual === len) return candidate;
    len = actual;
  }
}

function paxHeaderName(name: string): string {
  const base = name.split('/').pop() ?? 'pax';
  return truncateUtf8(`PaxHeaders/${base}`, 100);
}

// ---------------------------------------------------------------------------
// 内容挑选：git 口径 + 回落
// ---------------------------------------------------------------------------

/**
 * 决定「哪些东西进包」——定案 ②。
 *
 * `git ls-files -z --cached --others --exclude-standard` = 已跟踪 + 未跟踪且未被
 * ignore。`.gitignore` 命中的（`node_modules` / `.next` / 构建产物）一律不进；
 * **`.git` 单独走目录遍历补进来**，因为 `ls-files` 从不列它，而没有它就丢了全部历史，
 * 「拿走继续用」这个意图不成立。
 *
 * ⚠️ **空项目没有 git，必须有回落**：`git ls-files` 在非仓库目录上退非零 ⇒ 整目录遍历。
 * 回落路径下没有 `.gitignore` 语义可用（那是 git 的知识），所以它按原样打包——一个
 * 从未 `git init` 过的工作区里也没有 `node_modules` 之外的判据可依。
 */
export async function listWorkspaceArchiveEntries(root: string): Promise<TarEntry[]> {
  const abs = resolve(root);
  const paths = await gitListedPaths(abs);
  if (paths === null) return walkDirectory(abs, abs, /* includeEmptyDirs */ true);
  const entries: TarEntry[] = [];
  for (const rel of paths) {
    const entry = await statEntry(join(abs, rel), rel);
    if (entry !== null) entries.push(entry);
  }
  const dotGit = join(abs, '.git');
  if (await isDirectory(dotGit)) {
    entries.push(...(await walkDirectory(dotGit, abs, /* includeEmptyDirs */ true)));
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return entries;
}

/** `null` ⇒ 这里不是 git 仓库（或 git 不可用）⇒ 调用方回落到整目录遍历。 */
async function gitListedPaths(root: string): Promise<string[] | null> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'],
      { maxBuffer: 256 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
    );
    return stdout.split('\0').filter((p) => p !== '');
  } catch {
    return null;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function statEntry(source: string, name: string): Promise<TarEntry | null> {
  try {
    const st = await lstat(source);
    const mtimeSec = Math.floor(st.mtimeMs / 1000);
    if (st.isSymbolicLink()) {
      return {
        name,
        type: 'symlink',
        size: 0,
        mode: 0o777,
        mtimeSec,
        linkname: await readlink(source),
      };
    }
    if (st.isDirectory()) {
      return { name: `${name}/`, type: 'dir', size: 0, mode: st.mode & 0o7777, mtimeSec };
    }
    if (!st.isFile()) return null; // socket / fifo / device —— 打包没有意义
    return { name, type: 'file', source, size: st.size, mode: st.mode & 0o7777, mtimeSec };
  } catch {
    return null; // 计划期间消失的文件：不进包，长度自然也不含它
  }
}

async function walkDirectory(
  dir: string,
  base: string,
  includeEmptyDirs: boolean,
): Promise<TarEntry[]> {
  const out: TarEntry[] = [];
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return out;
  }
  if (names.length === 0 && includeEmptyDirs && dir !== base) {
    const entry = await statEntry(dir, relName(dir, base));
    if (entry !== null) out.push(entry);
    return out;
  }
  for (const name of names.sort()) {
    const source = join(dir, name);
    const entry = await statEntry(source, relName(source, base));
    if (entry === null) continue;
    if (entry.type === 'dir') {
      out.push(...(await walkDirectory(source, base, includeEmptyDirs)));
    } else {
      out.push(entry);
    }
  }
  return out;
}

function relName(source: string, base: string): string {
  return source
    .slice(base.length + 1)
    .split(sep)
    .join(posix.sep);
}

// ---------------------------------------------------------------------------
// 磁盘：实占字节数 + 落盘前的水位判据
// ---------------------------------------------------------------------------

/**
 * 宿主目录**实占**字节数（`du` 口径 = 已分配块 × 512，不是 `st.size` 的逻辑大小）。
 * 13 §2.2.2 要它回答的是「删掉能拿回多少磁盘」，而 `download_bytes`（tar 字节数）
 * 回答的是「下载要等多久」——**实测差 70 倍，两个都存两个都显示**。
 *
 * ⚠️ 硬链接按 `(dev, ino)` 去重，与 `du -s` 同口径；不去重会把同一份块数重复计入。
 */
export async function diskUsageBytes(root: string): Promise<number> {
  const seen = new Set<string>();
  return walkDiskUsage(resolve(root), seen);
}

async function walkDiskUsage(path: string, seen: Set<string>): Promise<number> {
  let st;
  try {
    st = await lstat(path);
  } catch {
    return 0;
  }
  const key = `${String(st.dev)}:${String(st.ino)}`;
  if (st.nlink > 1) {
    if (seen.has(key)) return 0;
    seen.add(key);
  }
  let total = Number(st.blocks) * 512;
  if (st.isDirectory()) {
    let names: string[];
    try {
      names = await readdir(path);
    } catch {
      return total;
    }
    for (const name of names) total += await walkDiskUsage(join(path, name), seen);
  }
  return total;
}

/** 打包落盘前的水位下限；判据与 `WorkspacePreparer.assertDiskSpace()` 同类（03 §7.6）。 */
export const DEFAULT_ARCHIVE_MIN_FREE_BYTES = 1024 * 1024 * 1024; // 1 GiB

export class ArchiveDiskInsufficientError extends Error {
  readonly code = 'DISK_INSUFFICIENT';
  constructor(message: string) {
    super(message);
    this.name = 'ArchiveDiskInsufficientError';
  }
}

/**
 * **只有会落盘的打包路径需要它。** P21-8 §4 的备份要先把 SQLite dump + 卷写成一个
 * 文件再交给下载，那一份**真的**占磁盘，磁盘又是本项目的真实瓶颈（03 §1）。
 *
 * ⛔ 保留卷的 `/archive` 是**纯流式**（{@link tarReadable} 直接写进 HTTP 响应，一个
 * 临时文件都不产生），所以它**不调**这个函数：对一个不写盘的操作做水位判断，唯一
 * 效果是在盘满时拒绝一个本来能成功的下载——而下载正是用户腾出空间的手段。
 */
export async function assertArchiveDiskSpace(
  destination: string,
  requiredBytes: number,
  minFreeBytes = DEFAULT_ARCHIVE_MIN_FREE_BYTES,
): Promise<void> {
  const available = await availableBytesFor(destination);
  const needed = requiredBytes + minFreeBytes;
  if (available >= needed) return;
  throw new ArchiveDiskInsufficientError(
    `not enough free space to write the archive: ${String(available)} bytes available ` +
      `under ${destination}, ${String(needed)} required (${String(requiredBytes)} archive + ` +
      `${String(minFreeBytes)} floor)`,
  );
}

/** 落盘形态的打包（P21-8 §4 备份用）——写之前判水位，写完返回真实字节数。 */
export async function packTarToFile(plan: TarPlan, destination: string): Promise<number> {
  await assertArchiveDiskSpace(destination, plan.totalBytes);
  const handle = await open(destination, 'w');
  try {
    let written = 0;
    for await (const chunk of generateTar(plan)) {
      await handle.write(chunk);
      written += chunk.length;
    }
    return written;
  } finally {
    await handle.close();
  }
}
