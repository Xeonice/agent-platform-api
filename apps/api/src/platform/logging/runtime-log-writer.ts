import {
  chmodSync,
  closeSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  renameSync,
  statSync,
  unlinkSync,
  type WriteStream,
} from 'node:fs';
import { join } from 'node:path';

/** 初值：20MB × 5 份（shared/11 §1.2.1 表）。5 份 = 当前 1 份 + 已轮转 4 份 ⇒ 上限 100MB。 */
export const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;
export const DEFAULT_MAX_FILES = 5;

export interface RuntimeLogWriterOptions {
  /** 日志目录，生产上是 `${DATA_ROOT}/logs`。 */
  dir: string;
  /** 文件名前缀，默认 `runtime` ⇒ `runtime.log` / `runtime.log.1` … */
  baseName?: string;
  /** 单份上限（字节）。 */
  maxBytes?: number;
  /** 保留总份数（含当前那份）。 */
  maxFiles?: number;
}

/**
 * 按大小轮转的落盘 writer —— 零依赖，只用 Node 内置 `fs`（shared/11 §1.2.1
 * 「轮转自己写，但有一个必踩的坑」）。
 *
 * ── ⛔ 那个坑（已实测，不要重犯）────────────────────────────────────────────
 *   写 BEFORE-1 / BEFORE-2 → renameSync(runtime.log → runtime.log.1) → 写 AFTER-RENAME
 *   实测：runtime.log.1 = "BEFORE-1\nBEFORE-2\nAFTER-RENAME"，runtime.log **不存在**
 *
 * `rename` 之后旧的 write stream **跟随 inode**：轮转后所有写继续落进那份已改名的
 * 旧文件，而 `runtime.log` 这个路径直接消失（外部 `tail -f` 也一并断掉，`tail -F`
 * 才能恢复）。失败是**完全静默**的 —— 日志照写，只是没人找得到，包括平台自己的
 * 导出（P21-5 §10.3 的 [导出日志] 会导出一个空的 runtime.log）。
 *
 * ⇒ 正确顺序固定为：`end()` 旧流 →（在它的 callback 里）rename 链式移位 → 重开流。
 *
 * ── ⚠️ 第二个坑：`end()` 是异步的 ──────────────────────────────────────────
 * 从 `end()` 到新流开好之间有一个窗口，这期间到来的日志**没有流可写**。不缓冲就是
 * 直接丢行，而且同样静默。所以 `rotating` 期间的每一行都进 `pending`，新流开好后
 * **按原序重放**。轮转窗口内丢行数实测为 0。
 *
 * ── 有意的取舍 ────────────────────────────────────────────────────────────
 * - 进程被 `SIGKILL` 时 `pending` 与 stream 内部缓冲会一起丢。运行日志是观察设施
 *   而不是账本（同 P21-5 §10.5 对审计流的定性），不为此引入 sync 写的吞吐代价。
 * - 单行大于 `maxBytes` 时先轮转一次再照写（`size > 0` 的守卫挡住死循环），
 *   该份文件因此会略微超过上限 —— 比把这一行截断或丢掉好。
 */
export class RuntimeLogWriter {
  readonly dir: string;
  readonly baseName: string;
  readonly maxBytes: number;
  readonly maxFiles: number;

  private ws: WriteStream | null = null;
  private size = 0;
  private rotating = false;
  /** ⚠️ 轮转窗口内到来的行 —— 这个数组就是「零丢行」的全部实现。 */
  private pending: string[] = [];
  private closed = false;
  private idleWaiters: (() => void)[] = [];

  constructor(options: RuntimeLogWriterOptions) {
    this.dir = options.dir;
    this.baseName = options.baseName ?? 'runtime';
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
    this.openStream();
  }

  /** 当前正在写的那份（外部 `tail -F` 盯的就是它）。 */
  get currentPath(): string {
    return join(this.dir, `${this.baseName}.log`);
  }

  /** 第 n 份已轮转文件（n ≥ 1，n 越大越旧）。 */
  rotatedPath(n: number): string {
    return `${this.currentPath}.${n}`;
  }

  /** 现存日志文件，**从旧到新** —— reader 按这个顺序拼接就是时间序。 */
  existingPaths(): string[] {
    const paths: string[] = [];
    for (let i = this.maxFiles - 1; i >= 1; i--) {
      const p = this.rotatedPath(i);
      if (existsSync(p)) paths.push(p);
    }
    if (existsSync(this.currentPath)) paths.push(this.currentPath);
    return paths;
  }

  /** 追加一行（不带换行符；带了也认）。**永不抛** —— 日志设施不许拖垮业务。 */
  write(line: string): void {
    if (this.closed) return;
    this.enqueue(line);
  }

  /** 轮转做完、`pending` 放干之后 resolve。测试与优雅退出用。 */
  whenIdle(): Promise<void> {
    if (!this.rotating && this.pending.length === 0) return Promise.resolve();
    return new Promise<void>((resolve) => this.idleWaiters.push(resolve));
  }

  /** 收流。等在途轮转做完，避免把 `pending` 里的行丢在门口。 */
  async close(): Promise<void> {
    await this.whenIdle();
    this.closed = true;
    const ws = this.ws;
    this.ws = null;
    if (!ws) return;
    await new Promise<void>((resolve) => ws.end(resolve));
  }

  // ── 内部 ──────────────────────────────────────────────────────────────────

  private enqueue(line: string): void {
    // ⚠️ 轮转窗口：此刻没有可写的流，缓冲下来等重放。删掉这三行 = 静默丢行。
    if (this.rotating) {
      this.pending.push(line);
      return;
    }
    const chunk = line.endsWith('\n') ? line : `${line}\n`;
    const bytes = Buffer.byteLength(chunk);
    if (this.size > 0 && this.size + bytes > this.maxBytes) {
      this.beginRotate();
      // 触发轮转的这一行属于**新**文件，跟着 pending 一起重放。
      this.pending.push(line);
      return;
    }
    this.ws?.write(chunk);
    this.size += bytes;
  }

  private beginRotate(): void {
    const old = this.ws;
    this.ws = null;
    this.rotating = true;
    if (!old) {
      this.finishRotate();
      return;
    }
    // ⛔ 顺序不可换：先 end()，rename 只能发生在它的 callback 里。见类注释。
    old.end(() => this.finishRotate());
  }

  private finishRotate(): void {
    try {
      this.shiftFiles();
      this.openStream();
    } catch (err) {
      // 这里跑在 `end()` 的 callback 里 —— 抛出去就是**未捕获异常 ⇒ 进程退出**。
      // 与 stream 的 'error' handler 同一条纪律:停止落盘、说一句、把平台留下。
      this.disable(err instanceof Error ? err.message : String(err));
      return;
    }
    this.rotating = false;
    this.flushPending();
    this.notifyIdle();
  }

  /** 降级:不再落盘。stdout/stderr 那条出口仍在(两条出口并存的另一半价值)。 */
  private disable(reason: string): void {
    this.ws = null;
    this.closed = true;
    this.rotating = false;
    this.pending = [];
    process.stderr.write(`[RuntimeLogWriter] file logging disabled: ${reason}\n`);
    this.notifyIdle();
  }

  /** `runtime.log.(N-1) → .N`（最旧的那份先删），最后 `runtime.log → runtime.log.1`。 */
  private shiftFiles(): void {
    const keepRotated = this.maxFiles - 1;
    if (keepRotated <= 0) {
      if (existsSync(this.currentPath)) unlinkSync(this.currentPath);
      return;
    }
    const oldest = this.rotatedPath(keepRotated);
    if (existsSync(oldest)) unlinkSync(oldest);
    for (let i = keepRotated - 1; i >= 1; i--) {
      const from = this.rotatedPath(i);
      if (existsSync(from)) renameSync(from, this.rotatedPath(i + 1));
    }
    if (existsSync(this.currentPath)) renameSync(this.currentPath, this.rotatedPath(1));
  }

  private flushPending(): void {
    const buffered = this.pending;
    this.pending = [];
    // 重放期间可能再次触发轮转 —— 那之后的行会被 enqueue 重新推回 this.pending，
    // 顺序不乱（buffered 是本地快照，pending 已换成新数组）。
    for (const line of buffered) this.enqueue(line);
  }

  private openStream(): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const path = this.currentPath;
    // `createWriteStream` 的 fd 是**异步**打开的，紧跟其后 chmod 会 ENOENT；
    // 而 `mode` 选项只在创建时生效、还会被 umask 削掉。先同步建好文件再 chmod，
    // 才真的落到 0600（同 .master.key / platform.db，shared/11 §1.2 权限对齐）。
    closeSync(openSync(path, 'a', 0o600));
    chmodSync(path, 0o600);
    this.size = statSync(path).size;
    const ws = createWriteStream(path, { flags: 'a', mode: 0o600 });
    // ⚠️ 没有这个 handler,一次写失败(磁盘满、目录被删、权限被改)就是一个
    // **未捕获的 'error' 事件 ⇒ 进程退出**。日志是观察设施,绝不许它把平台带走。
    // 降级路径:停止落盘、往 stderr 说一次为什么 —— stdout/stderr 那条出口还在
    //(落盘与 stdout 并存的另一半价值,shared/11 §1.2.1)。
    ws.on('error', (err: Error) => this.disable(err.message));
    this.ws = ws;
  }

  private notifyIdle(): void {
    if (this.rotating || this.pending.length > 0) return;
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const resolve of waiters) resolve();
  }
}
