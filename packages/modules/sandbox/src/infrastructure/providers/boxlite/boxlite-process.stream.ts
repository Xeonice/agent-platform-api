import {
  SandboxProviderError,
  SandboxProviderErrorCode,
  type ProcessSpec,
  type ProcessStream,
} from '@platform/contracts';
import { toEnvTuples } from './boxlite-guest-shell';
import type { BoxliteExecution, ExecCapableBox } from './boxlite-runtime';

/**
 * `spawn()` 的两个 native 实现（04 §2.2 映射表 boxlite 列）。
 *
 *   tty:false → `BoxliteExecStream`  = `box.exec(..., tty=false)` + `wait()`
 *   tty:true  → `BoxlitePtyStream`   = `box.exec(..., tty=true)` + `stdin()` + `resizeTty()`
 *
 * ── 与 aio 侧的差别，逐条都是**实测**出来的，不是从文档推的 ────────────────────
 *  · `ProcessSpec.user`：aio 侧抛 `UNSUPPORTED_CAPABILITY`（agent API 没有这个参数），
 *    native 侧是**原生参数**（`box.exec(cmd,args,env,tty,user,...)`）。实测
 *    `user:'root'` 正常、`user:'nosuchuser'` 抛 `spawn_failed: User 'nosuchuser' not
 *    found in .../etc/passwd` ⇒ 这一档真的支持，不再是「静默丢弃」也不是「显式拒绝」。
 *  · `kill()`：aio 的 PTY 没有信号通道，只能往终端里写 ETX + `exit\n`；native 有
 *    `signal(n)`，是**真信号**（实测 `signal(15)` ⇒ `exitCode:-15`，`kill()` ⇒ -9）。
 *  · `timeoutMs`：native `timeoutSecs` 在**微 VM 内**真杀（实测 `sleep 5` + 1s ⇒
 *    1013ms 返回 -15），平台侧那层只负责把它翻成 124。
 *  · **运行身份是 `uid=0(root)`、`$HOME=/root`**（实测 `id`），而沙箱内 agent 那条路
 *    是 `gem` / `/home/gem`。所以 04 §2.1★ 那条「凭证物化按运行时 `$HOME` 展开、
 *    不硬编码」在这一档从「好习惯」变成了**必须**：两条通道的 HOME 现在真的不一样。
 */

/** 默认的交互 shell —— `ProcessSpec.cmd` 为空时用它（06 §3 的终端会话）。 */
const DEFAULT_PTY_COMMAND = ['/bin/bash', '-i'];

/**
 * PTY 的兜底 `TERM`。
 *
 * ⚠️ 不给的话终端是**半残**的：实测 `tput cols` 直接报
 * `tput: No value for $TERM and no -T specified`，前端 xterm.js 那侧的重绘、颜色、
 * 光标控制全都建立在这个变量上。沙箱内 agent 的 ws 终端由 agent 自己设好了它，
 * native 这条路没人设 —— 这就是「换实现会掉的那类东西」，所以在这里补上。
 * 调用方传了自己的 `TERM` 就用调用方的（下面是 `{TERM, ...spec.env}` 的顺序）。
 */
const DEFAULT_TERM = 'xterm-256color';

/** SIGTERM → 宽限 → SIGKILL 的宽限窗（03 §8.3 两阶段 kill）。 */
export const BOXLITE_KILL_GRACE_MS = 5_000;

/** 平台对「到点被强杀」的统一口径（03 §8.3），与 aio 侧同一个数字。 */
const TIMEOUT_EXIT_CODE = 124;

const SIGNAL_NUMBERS: Partial<Record<NodeJS.Signals, number>> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGKILL: 9,
  SIGTERM: 15,
};

/** POSIX 信号名 → 号。认不出来的按 SIGTERM 投递（与 aio 的降级口径一致）。 */
export function toSignalNumber(signal?: NodeJS.Signals): number {
  if (signal === undefined) return 15;
  return SIGNAL_NUMBERS[signal] ?? 15;
}

/** `spawn()` 的入口：按 `spec.tty` 分流到两个 native 实现。 */
export async function spawnNative(box: ExecCapableBox, spec: ProcessSpec): Promise<ProcessStream> {
  return spec.tty ? openPty(box, spec) : startExec(box, spec);
}

async function startExec(box: ExecCapableBox, spec: ProcessSpec): Promise<ProcessStream> {
  const argv = requireArgv(spec);
  const timeoutSecs = spec.timeoutMs === undefined ? null : Math.ceil(spec.timeoutMs / 1000);
  const execution = await box.exec(
    argv[0],
    argv.slice(1),
    toEnvTuples(spec.env),
    false,
    spec.user ?? null,
    timeoutSecs,
    spec.cwd ?? null,
  );
  return new BoxliteExecStream(execution, { stdin: spec.stdin, timeoutMs: spec.timeoutMs });
}

async function openPty(box: ExecCapableBox, spec: ProcessSpec): Promise<ProcessStream> {
  const argv = spec.cmd.length > 0 ? spec.cmd : DEFAULT_PTY_COMMAND;
  const execution = await box.exec(
    argv[0],
    argv.slice(1),
    toEnvTuples({ TERM: DEFAULT_TERM, ...(spec.env ?? {}) }),
    true,
    spec.user ?? null,
    // ⚠️ 交互终端**不设** `timeoutSecs`：那是「到点强杀」，对一个用户正在里面敲命令的
    // 终端来说等于随机断线。终端的生命周期由网关（detach）和 `stop()/destroy()` 管。
    null,
    spec.cwd ?? null,
  );
  const stream = new BoxlitePtyStream(execution);
  // 先落初始窗口大小再交出去：xterm.js 第一帧就按它排版，晚一步就会先画一屏 80x24
  // 再跳一次。⚠️ 参数序是 (rows, cols)，与 `ProcessStream.resize(cols, rows)` 相反 ——
  // 实测 `resizeTty(30,100)` 之后 guest 里 `tput cols` 是 100。
  if (spec.cols !== undefined && spec.rows !== undefined) stream.resize(spec.cols, spec.rows);
  return stream;
}

function requireArgv(spec: ProcessSpec): string[] {
  if (spec.cmd.length === 0) {
    throw new SandboxProviderError(
      SandboxProviderErrorCode.INVALID_STATE,
      'ProcessSpec.cmd is empty — a one-shot exec needs at least the program name',
    );
  }
  return spec.cmd;
}

/**
 * 两个 stream 共用的回调簿记。抽出来不是为了省行数，是为了让「detach 只松手、
 * 绝不碰对面进程」这条语义**只有一个实现**——两份拷贝就是两次写错的机会。
 */
abstract class BoxliteStreamBase implements ProcessStream {
  abstract readonly ref: string;
  protected dataCbs: ((chunk: Buffer) => void)[] = [];
  protected exitCbs: ((code: number | null) => void)[] = [];
  protected exited = false;
  protected exitCode: number | null = null;
  /** detach 之后仍然抽干输出，但一个字节都不再往上派发。理由见 `detach()`。 */
  protected detached = false;

  /**
   * ⚠️ **detach 之后注册的回调一律不收**（两个方法都是）。
   *
   * 只在 `detach()` 里清空数组是不够的：`onExit` 会把新回调 push 进去，而
   * `if (this.exited) cb(...)` 会立刻补发一次「进程已退出」——对一个**已经松手**的流
   * 来说，那既是无中生有，也把 detach 的语义（我不再关心这条流了）撕开一个口子。
   * 网关侧的 `?socketSessionKey=` 复用路径正好会在同一个流上二次注册。
   */
  onData(cb: (chunk: Buffer) => void): void {
    if (this.detached) return;
    this.dataCbs.push(cb);
  }

  onExit(cb: (code: number | null) => void): void {
    if (this.detached) return;
    this.exitCbs.push(cb);
    if (this.exited) cb(this.exitCode);
  }

  /**
   * 断传输、**不碰进程**（契约原文：leave whatever is running exactly as it is）。
   *
   * ── native 下「断传输」是什么意思，以及为什么仍然要继续抽干 ──────────────────
   * aio 那侧 detach 是关一条 websocket，沙箱里的进程与我们之间还隔着一个 agent；
   * native 这侧**没有中间人**：`JsExecution` 就是那个进程的 stdin/stdout/stderr。
   * 所以这里能做的只有「不再派发、不再理会」，而不能关掉什么。
   *
   * ⚠️ 那么「停止读 stdout」会不会把对面写满管道卡死？**实测：不会。**
   * 让 guest 往 stdout 灌 81MB（`head -c 60000000 /dev/zero | base64`）而宿主一个
   * 字节都不读，exec 仍然 1061ms 正常 `exit=0`，并且命令后半段的副作用照常发生。
   * ⇒ 继续抽干**不是为了活性，是为了内存**：不读的话那些字节要么堆在 Rust 侧，
   * 要么白白搬运；抽干让它们在拿到就丢掉。循环随进程结束而结束，不会永远悬着。
   *
   * 这里**不 synthExit**：进程并没有退出，合成一个 exit 等于对上层撒谎（06 §6.6
   * 「WS 断开 = detach」，被断开的只是网关侧那条连接，agent 会话原样活着）。
   */
  detach(): void {
    this.detached = true;
    this.dataCbs = [];
    this.exitCbs = [];
  }

  abstract write(data: string | Buffer): void;
  abstract resize(cols: number, rows: number): void;
  abstract kill(signal?: NodeJS.Signals): Promise<void>;

  protected emit(chunk: Buffer): void {
    if (this.detached) return;
    for (const cb of this.dataCbs) cb(chunk);
  }

  /**
   * ⚠️ 这里**没有** `if (this.detached) return`，那不是漏了：detach 已经把两个数组清空、
   * 并且 `onData`/`onExit` 之后一律拒收，所以 detached 状态下这两个循环本来就是空转。
   * 多写一道守卫看着稳妥，实际是**没有任何变异能杀死**的死代码——那种代码只会让人
   * 以为语义落在这里，下次改错地方。语义只有一个落点：注册入口 + `detach()`。
   */
  protected settle(code: number | null): void {
    if (this.exited) return;
    this.exited = true;
    this.exitCode = code;
    for (const cb of this.exitCbs) cb(code);
  }

  /**
   * 两阶段 kill（03 §8.3）：先按调用方要的信号投递，宽限窗内没死就 SIGKILL。
   * 与 aio 侧唯一的差别是这里是**真信号**（`execution.signal(n)`），不是往 tty 里写
   * 控制字符 —— 所以「忽略 SIGINT 的进程活下来」那条限制在这一档不存在。
   */
  protected async killVia(execution: BoxliteExecution, signal?: NodeJS.Signals): Promise<void> {
    if (this.exited) return;
    const requested = toSignalNumber(signal);
    await execution.signal(requested).catch(() => undefined);
    if (requested === 9) return;
    if (await this.waitExited(BOXLITE_KILL_GRACE_MS)) return;
    await execution.signal(9).catch(() => undefined);
  }

  /** 宽限窗轮询（tick 计数，不读挂钟——01 §3 禁 `Date.now()`）。 */
  private async waitExited(ms: number): Promise<boolean> {
    const ticks = Math.max(1, Math.round(ms / KILL_POLL_MS));
    for (let i = 0; i < ticks; i++) {
      if (this.exited) return true;
      await sleep(KILL_POLL_MS);
    }
    return this.exited;
  }
}

const KILL_POLL_MS = 250;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/**
 * 一次性 exec 包成 `ProcessStream`。
 *
 * ⚠️ **回调无论注册早晚都拿到完整输出**，这一点是刻意与 `AioExecProcessStream` 对齐的：
 * `spawn()` 返回之后调用方才有机会 `onData`，而 native 的第一块字节可能在那之前就到了。
 * 若按「真流式」派发，同一段代码在 aio 上拿得到全部输出、在 boxlite 上偶发丢头几行 ——
 * 那正是契约测试要挡的 provider 间漂移。一次性 exec 的调用方（安装探测、凭证物化、
 * `toExecFn`）本来就是「收到 EOF 再一起看」，流式对它们没有收益。
 */
class BoxliteExecStream extends BoxliteStreamBase {
  readonly ref = 'boxlite-exec';
  private readonly chunks: Buffer[] = [];
  /** settle 之后留着，好让**迟到**的 `onData` 也拿到全量（与 aio 侧同语义）。 */
  private output: Buffer | null = null;

  override onData(cb: (chunk: Buffer) => void): void {
    const before = this.dataCbs.length;
    super.onData(cb);
    // 基类在 detached 时会拒收 —— 拒收了就不补发。用「有没有真的加进去」判断，
    // 而不是再抄一遍 `!this.detached`：同一条规则写两遍，改一处就漏一处。
    if (this.dataCbs.length > before && this.output !== null) cb(this.output);
  }
  /**
   * 「是不是被 `timeoutSecs` 干掉的」。
   *
   * ⚠️ 非要一个本地标志，是因为 **native 分不出来**：实测超时杀掉的进程报的是
   * `exitCode:-15`，跟一次普通的 SIGTERM 一模一样，`errorMessage` 也是空的。
   * 而平台上游（03 §8.3）靠 124 区分「到点了」和「被人杀了」。计时器用 tick，
   * 不读挂钟（01 §3）。
   */
  private timedOut = false;

  constructor(
    private readonly execution: BoxliteExecution,
    opts: { stdin?: string; timeoutMs?: number },
  ) {
    super();
    if (opts.timeoutMs !== undefined) {
      const timer = setTimeout(() => {
        this.timedOut = true;
      }, opts.timeoutMs);
      timer.unref?.();
    }
    void this.run(opts.stdin);
  }

  private async run(stdin?: string): Promise<void> {
    try {
      await Promise.all([
        this.pump(this.execution.stdout()),
        this.pump(this.execution.stderr()),
        this.feedStdin(stdin),
      ]);
      const result = await this.execution.wait();
      this.flush();
      this.settle(this.mapExit(result.exitCode, result.errorMessage));
    } catch {
      // 通道本身塌了（微 VM 没了 / SDK 抛错）：退出码不可知 ⇒ `null`。契约里
      // `onExit(code: number | null)` 就是为这种情况留的口子（SP-09）。
      this.flush();
      this.settle(null);
    }
  }

  /**
   * native 报的退出码 → 平台口径。
   *   · 超时（本地标志命中，或 SDK 自己说了 timeout）⇒ **124**（03 §8.3）
   *   · 其余原样透传，**含负数**：`-15`/`-9` 表示被信号杀死，与 aio 侧
   *     `/v1/bash/kill` 返回 `exit_code:-15` 的口径一致，上层不用学两套。
   */
  private mapExit(code: number, errorMessage?: string): number {
    if (this.timedOut) return TIMEOUT_EXIT_CODE;
    if (errorMessage !== undefined && /timed?\s*out|timeout/i.test(errorMessage)) {
      return TIMEOUT_EXIT_CODE;
    }
    return code;
  }

  private async feedStdin(stdin?: string): Promise<void> {
    // 见 `boxlite-guest-shell.ts` 的 `feedStdin`：没有 payload 也要关，否则 fd 0 是一根
    // 永不 EOF 的管道，`cat` / `codex login --with-access-token` 这类命令会挂死。
    try {
      const handle = await this.execution.stdin();
      if (stdin !== undefined && stdin !== '') await handle.writeString(stdin);
      await handle.close();
    } catch {
      /* 进程可能已退出 */
    }
  }

  private async pump(streamPromise: Promise<{ next(): Promise<string | null> }>): Promise<void> {
    let stream: { next(): Promise<string | null> };
    try {
      stream = await streamPromise;
    } catch {
      return;
    }
    for (;;) {
      let chunk: string | null;
      try {
        chunk = await stream.next();
      } catch {
        return;
      }
      if (chunk === null) return;
      // detach 之后照样抽干、只是不再留存（见 `detach()` 的注释：为内存，不为活性）。
      if (!this.detached) this.chunks.push(Buffer.from(chunk, 'utf8'));
    }
  }

  private flush(): void {
    this.output = Buffer.concat(this.chunks);
    this.chunks.length = 0;
    if (this.output.length > 0) this.emit(this.output);
  }

  /**
   * 一次性 exec 没有 stdin 上行：payload 在 `ProcessSpec.stdin` 里一次交付，随后 fd 0
   * 就被关掉换 EOF 了（见 `feedStdin`）。与 `AioExecProcessStream.write()` 同为 no-op。
   */
  write(): void {}

  resize(): void {
    /* 不是 pty */
  }

  async kill(signal?: NodeJS.Signals): Promise<void> {
    await this.killVia(this.execution, signal);
  }
}

/**
 * 交互终端包成 `ProcessStream`（06 §3 的 `PtyStream` 就是它）。
 *
 * 真 PTY，逐项实测过：`tty` 在 guest 里返回 `/dev/pts/N`；`resizeTty(30,100)` 之后
 * `tput cols` 是 100；stdin 交互与退出码都正常。
 */
class BoxlitePtyStream extends BoxliteStreamBase {
  readonly ref = 'boxlite-pty';
  /**
   * 写入串行化。
   *
   * ⚠️ 契约的 `write(data)` 是**同步返回**的，而 native 的 `stdin.write*()` 是
   * Promise。直接各写各的，两次快速击键（或「一行命令 + 回车」被拆成两帧）就可能
   * 乱序落进 tty —— 那是「偶尔吞一个字符」这类最难查的终端 bug。串成一条链，
   * 顺序就由链保证，调用方仍然是同步语义。
   */
  private writeChain: Promise<unknown> = Promise.resolve();
  private stdin: Promise<{ writeString(text: string): Promise<void> }> | null = null;

  constructor(private readonly execution: BoxliteExecution) {
    super();
    void this.run();
  }

  private async run(): Promise<void> {
    try {
      await Promise.all([this.pump(this.execution.stdout()), this.pump(this.execution.stderr())]);
      const result = await this.execution.wait();
      this.settle(result.exitCode);
    } catch {
      this.settle(null);
    }
  }

  private async pump(streamPromise: Promise<{ next(): Promise<string | null> }>): Promise<void> {
    let stream: { next(): Promise<string | null> };
    try {
      stream = await streamPromise;
    } catch {
      return; // tty 模式下 stderr 通常已经并进 pty，拿不到是正常的
    }
    for (;;) {
      let chunk: string | null;
      try {
        chunk = await stream.next();
      } catch {
        return;
      }
      if (chunk === null) return;
      this.emit(Buffer.from(chunk, 'utf8'));
    }
  }

  write(data: string | Buffer): void {
    const text = typeof data === 'string' ? data : data.toString('utf8');
    this.stdin ??= this.execution.stdin();
    this.writeChain = this.writeChain
      .then(() => this.stdin)
      .then((handle) => handle?.writeString(text))
      .catch(() => undefined);
  }

  /** ⚠️ native 的参数序是 (rows, cols)，与契约的 `resize(cols, rows)` 相反。 */
  resize(cols: number, rows: number): void {
    void this.execution.resizeTty(rows, cols).catch(() => undefined);
  }

  /**
   * 真信号（`signal(n)`），不是往终端里写 ETX。
   *
   * 这解决了 aio 侧记在案上的两条：① 忽略 SIGINT 的进程杀不掉；② 只能靠
   * `destroy()/stop()` 兜底。默认两阶段 SIGTERM→SIGKILL；显式传 `SIGINT` 就只投
   * SIGINT（「中断前台命令、留下 shell」）——`killVia` 对非 9 的信号会升级，
   * 所以这里对 SIGINT 单独走一条不升级的路。
   */
  async kill(signal?: NodeJS.Signals): Promise<void> {
    if (signal === 'SIGINT') {
      await this.execution.signal(2).catch(() => undefined);
      return;
    }
    await this.killVia(this.execution, signal);
  }
}
