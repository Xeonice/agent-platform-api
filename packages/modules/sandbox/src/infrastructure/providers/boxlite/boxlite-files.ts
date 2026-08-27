import { Readable } from 'node:stream';
import {
  SandboxProviderError,
  SandboxProviderErrorCode,
  type FileEntry,
  type SandboxFiles,
  type SandboxHandle,
} from '@platform/contracts';
import { epochSecondsToIso } from '@platform/shared-kernel';
import { runGuestScript } from './boxlite-guest-shell';
import type { BoxFor } from './boxlite-box-ref';

/**
 * 文件面（04 §2.6 `SandboxFiles`）的 native 实现。
 *
 * ══ 为什么**不是** `copyIn` / `copyOut` ══════════════════════════════════════
 * 原计划是拿 SDK 的 `Box.copyIn/copyOut` 来做——它们确实二进制精确、8MB 12ms。
 * **实测把这个方案否掉了：那两个 API 只看得见容器 rootfs，看不见任何挂载点。**
 *
 * | guest 路径 | 性质 | `copyOut` | `copyIn` |
 * |---|---|---|---|
 * | `/var/tmp/x`、`/root/x` | rootfs | ✅ 字节精确 | ✅ |
 * | `/tmp/x` | **tmpfs** | ❌ `NotFound: source path does not exist` | ❌ **静默无声地什么都没发生** |
 * | `/workspace/x` | **virtiofs 卷**（idmapped） | ❌ 同上 | ❌ 同上 |
 *
 * 而平台的产物路径恰恰是 `TASK_ARTIFACT_DIR = /workspace/.agent-artifacts` ——
 * 也就是说，用 copyOut 实现的文件面，对**平台唯一真正会读的那个目录**会一律回
 * `null`（「任务没产出」），而 `writeFile` 会**成功返回但什么都没写**。后者尤其恶劣：
 * 静默失败，没有任何一层会红。
 *
 * ⇒ 通道改成 **exec + base64**：
 *   读 `base64 -w0 -- "$1"`（stdout 是纯 ASCII ⇒ 经 native 的字符串流无损）
 *   写 `base64 -d > "$1"`（内容走 **stdin**，只有**路径**进 argv ⇒ 沙箱内 `ps` /
 *      `/proc/<pid>/cmdline` 看不到内容，满足 05 §7 #3 / RA-14）
 * 代价实测过：8MB 文件 base64 往返 436ms（copyOut 是 12ms、aio 的 HTTP 是 36ms）。
 * 对「任务结束后读一次产物」这个唯一用法，几百毫秒换「在所有挂载上都正确」，值。
 *
 * ⚠️ 镜像前提（实测 `agent-infra/sandbox:latest`）：GNU coreutils 8.32（`base64`
 * 支持 `-w0` / `-d`）、GNU findutils 4.8.0（`find -printf`）、`/bin/sh` 是 dash。
 * 换成 busybox 镜像的话 `base64 -w0` 与 `find -printf` 都不成立——那属于 04 §7
 * 镜像契约的事，这里假定平台镜像。
 */

/** `[ -f "$1" ]` 不成立时脚本用的退出码——挑一个命令自己不会用的值。 */
const EXIT_NO_SUCH_FILE = 66;

/** 读整文件：不存在 ⇒ 66，存在 ⇒ base64 到 stdout。 */
const READ_SCRIPT = `[ -f "$1" ] || exit ${EXIT_NO_SUCH_FILE}; exec base64 -w0 -- "$1"`;

/**
 * 写整文件：先补齐父目录，再从 stdin 收 base64。
 * 契约要求「缺失的父目录自动创建」（aio 侧的 agent 就是这么做的，所以 `mkdir` 才
 * 没有进这个面），这里补上同样的行为。
 */
const WRITE_SCRIPT = `d=$(dirname -- "$1") && mkdir -p -- "$d" && exec base64 -d > "$1"`;

/**
 * 列目录。
 *
 * `-printf '%y\\t%s\\t%T@\\t%p\\0'` 一次拿齐四样，并且用 **NUL 分隔记录**——
 * 文件名里可以有空格、制表符甚至换行（实测 `we ird.txt` 原样通过），换行分隔会在
 * 这种名字上悄悄错位。`%T@` 是带小数的 epoch 秒，`epochSecondsToIso` 正好收。
 * 目录不存在时 `find` 回 exit 1 + stderr ⇒ 上层归一成**空数组**（「任务没产出」
 * 是正常结局，不是故障，与 aio 侧一致）。
 */
function listScript(recursive: boolean): string {
  const depth = recursive ? '' : ' -maxdepth 1';
  return `exec find "$1" -mindepth 1${depth} -printf '%y\\t%s\\t%T@\\t%p\\0'`;
}

export class BoxliteSandboxFiles implements SandboxFiles {
  constructor(
    private readonly providerName: string,
    private readonly boxFor: BoxFor,
  ) {}

  /**
   * 整文件读；**缺文件返回 `null` 而不是抛**——契约把它写成正常路径而非错误，
   * 理由是实测：codex 的 `-o/--output-last-message <FILE>` 在任务失败时根本不会
   * 被创建。目录、符号链接指向的目录同样按「不是一个可读文件」回 `null`。
   */
  async readFile(handle: SandboxHandle, path: string): Promise<Buffer | null> {
    const box = await this.box(handle);
    const r = await runGuestScript(box, READ_SCRIPT, [path]);
    if (r.code === EXIT_NO_SUCH_FILE) return null;
    if (r.code !== 0) {
      throw new SandboxProviderError(
        SandboxProviderErrorCode.INTERNAL,
        `boxlite file read failed for ${path}: exit=${r.code} ${r.stderr.trim()}`.trim(),
      );
    }
    return Buffer.from(r.stdout, 'base64');
  }

  /**
   * 流式读。
   *
   * ⚠️ **这是一个诚实的半吊子，登记在案**：native 的 stdout 是「一块块 string」，
   * 要真正边收边解 base64，得自己维护 4 字符对齐的残尾缓冲；那份复杂度目前**没有
   * 调用方需要**——`agent-task.service` 只用它下载单个产物文件，量级是 KB 到几 MB。
   * 所以这里先读全再包成 `Readable`，语义（缺文件 ⇒ `null`）与契约一致，只是没有
   * 省下内存。⏳ 真要流式（大归档 / 长日志）时再补，改动被这个方法挡住，不外溢。
   */
  async openFileStream(handle: SandboxHandle, path: string): Promise<NodeJS.ReadableStream | null> {
    const bytes = await this.readFile(handle, path);
    return bytes === null ? null : Readable.from(bytes);
  }

  /** 内容走 stdin、路径走 argv —— 命令行里永远只有路径（05 §7 #3）。 */
  async writeFile(handle: SandboxHandle, path: string, content: string | Buffer): Promise<void> {
    const box = await this.box(handle);
    const payload = (Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8')).toString(
      'base64',
    );
    const r = await runGuestScript(box, WRITE_SCRIPT, [path], { stdin: payload });
    if (r.code !== 0) {
      throw new SandboxProviderError(
        SandboxProviderErrorCode.INTERNAL,
        `boxlite file write failed for ${path}: exit=${r.code} ${r.stderr.trim()}`.trim(),
      );
    }
  }

  async listFiles(
    handle: SandboxHandle,
    path: string,
    opts?: { recursive?: boolean; maxEntries?: number },
  ): Promise<FileEntry[]> {
    const box = await this.box(handle);
    const r = await runGuestScript(box, listScript(opts?.recursive ?? false), [path]);
    // 目录不存在 / 不可读 ⇒ 空列表，不抛（与 aio 侧同口径）。
    if (r.code !== 0) return [];
    const rows = r.stdout.split('\0').filter((s) => s !== '');
    const limit = opts?.maxEntries;
    const capped = limit !== undefined && limit >= 0 ? rows.slice(0, limit) : rows;
    return capped.map(parseFindRow).filter((e): e is FileEntry => e !== null);
  }

  private async box(handle: SandboxHandle) {
    if (handle.provider !== this.providerName) {
      throw new SandboxProviderError(
        SandboxProviderErrorCode.INVALID_STATE,
        `sandbox handle belongs to provider '${handle.provider}', not '${this.providerName}'`,
      );
    }
    return this.boxFor(handle);
  }
}

/**
 * `%y\t%s\t%T@\t%p` → `FileEntry`。
 *
 * ⚠️ `%p` 自己可能含制表符，所以只切**前三个** tab，剩下的整段都是路径。
 * 目录的 `size` 是**缺省**而不是 0（契约明写：aio 的 agent 对目录报 `size: null`，
 * 两边必须一致，不然同一段应用代码在两个 provider 上会看到不同的 JSON 形状）。
 */
function parseFindRow(row: string): FileEntry | null {
  const first = row.indexOf('\t');
  const second = row.indexOf('\t', first + 1);
  const third = row.indexOf('\t', second + 1);
  if (first < 0 || second < 0 || third < 0) return null;
  const kindChar = row.slice(0, first);
  const size = Number(row.slice(first + 1, second));
  const mtime = row.slice(second + 1, third);
  const path = row.slice(third + 1);
  if (path === '') return null;
  const isDir = kindChar === 'd';
  return {
    path,
    kind: isDir ? 'dir' : 'file',
    ...(isDir || !Number.isFinite(size) ? {} : { size }),
    modifiedAt: epochSecondsToIso(mtime) ?? '',
  };
}
