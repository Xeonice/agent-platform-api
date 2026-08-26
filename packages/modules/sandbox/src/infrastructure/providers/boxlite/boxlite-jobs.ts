import { randomBytes } from 'node:crypto';
import {
  SandboxProviderError,
  SandboxProviderErrorCode,
  type JobChunk,
  type JobCursor,
  type JobHandle,
  type JobReadOptions,
  type JobSpec,
  type JobStatus,
  type SandboxHandle,
  type SandboxJobs,
} from '@platform/contracts';
import { expectOk, runGuestScript } from './boxlite-guest-shell';
import type { BoxFor } from './boxlite-box-ref';
import type { ExecCapableBox } from './boxlite-runtime';

/**
 * 作业面（04 §2.6 `SandboxJobs`）的 native 实现：**`setsid` 起进程 + 输出落 box 内
 * 文件 + 游标 seek 读**。
 *
 * ══ 为什么不是「照抄 aio 的 session 方案」 ═══════════════════════════════════
 * native 没有 session 这个概念，这一次是**好事**。aio 那条路上，契约里那段
 * 「生存义务」注释记着两个默认就会违约的坑：agent 的 session 有 IDLE TTL（默认
 * 3600s，读输出**不会**刷新它的时钟）、还有 session 上限（默认 50，新建会**淘汰最老
 * 的**）；再加上 streaming socket 一断就销毁它创建的 session、连输出带命令一起杀，
 * 所以那边要靠「先建 session、再 exec、最后才 attach」的顺序硬绕，还要在 create 时
 * 提前把 `BASH_SESSION_TIMEOUT` / `MAX_BASH_SESSIONS` 拉高。
 *
 * 文件方案把这些**从「小心翼翼地遵守」变成「结构上不存在」**：
 *  · 进程由 `setsid` 放进**自己的 session**，与启动它的那次 execution 解耦——
 *    实测：launcher exec 193ms 就返回，3.5s 后后台进程仍在往日志里写。
 *  · 输出写在 box 的 rootfs 文件里，没有任何一方「持有」它；平台重启后照样续读，
 *    因为游标是一个字节偏移量，而不是某个活对象。
 *  · 没有 session ⇒ 没有 TTL、没有淘汰、没有「读它就能续命」这种反直觉规则。
 *    ⇒ **生存义务在这一档是结构性满足的**，不需要 create 时预埋任何 env。
 *
 * ══ box 内的布局（`<dir>` = `/var/tmp/.platform-job-<128bit hex>`）══════════
 *   run.sh   真正的 runner（**命令写在文件里**，不在 launcher 的 argv 里）
 *   stdout   作业 stdout（唯一真相源，游标按字节走）
 *   stderr   作业 stderr（与 stdout **分开**——04 §2.6 裁决 3：合并会把 codex 的
 *            干净 JSONL 拌进 tracing 行，`parseOutput` 就从 `JSON.parse` 退化成猜格式）
 *   stdin    可选 payload（经 stdin 投喂，**从不进 argv**，05 §7 #3）
 *   pgid     进程组 id —— kill 与「还活着吗」都靠它
 *   exit     退出码，`mv` 原子落盘（有它 = 一定跑完了）
 *
 * ⚠️ **为什么是 `/var/tmp` 而不是 `/tmp`**：实测 `/tmp` 在这个镜像里是 **tmpfs**
 * （RAM），一个跑几十分钟、输出上百 MB 的 Task 会直接吃掉微 VM 的内存；`/var/tmp`
 * 落在 rootfs 上，还能跨 `stop()→start()` 存活（实测）。
 */

/** 作业 scratch 根目录。见文件头「为什么是 /var/tmp」。 */
const JOB_ROOT = '/var/tmp';

/** 找不到作业目录（已 release / 从来没有过）。 */
const EXIT_NO_JOB_DIR = 66;
/** 镜像里没有 `timeout(1)` ⇒ 兑现不了 `JobSpec.timeoutMs`。 */
const EXIT_NO_TIMEOUT_BINARY = 67;

/** SIGTERM → 宽限 → SIGKILL（03 §8.3）。与 `ProcessStream.kill` 同一个窗口。 */
export const BOXLITE_JOB_KILL_GRACE_MS = 5_000;
/** 宽限窗内的轮询节拍（tick 计数，不读挂钟——01 §3）。 */
const KILL_POLL_MS = 250;
/** guest 内等待新字节的轮询节拍，秒。0.2s 实测有效（`sleep 0.2` ⇒ 201ms）。 */
const GUEST_WAIT_TICK_SECONDS = 0.2;
/** `timeout -k N`：SIGTERM 之后再等这么久才 SIGKILL，与平台两阶段口径一致。 */
const TIMEOUT_KILL_AFTER_SECONDS = 5;

/**
 * 建目录 + 落 runner。`cat` 收的是 runner 脚本本体 ⇒ **作业命令不出现在 launcher 的
 * argv 里**（它仍会出现在作业自己进程的 argv 里，那是没法避免的，也不是本条防的）。
 * 带 `timeoutMs` 时先验镜像里有没有 `timeout(1)`：兑现不了就**当场拒绝**，而不是
 * 收下作业再让它中途消失（契约：`UNSUPPORTED_CAPABILITY`）。
 */
const SETUP_SCRIPT =
  `d=$1; need_timeout=$2\n` +
  `if [ "$need_timeout" = 1 ] && ! command -v timeout >/dev/null 2>&1; then exit ${EXIT_NO_TIMEOUT_BINARY}; fi\n` +
  `rm -rf -- "$d" && mkdir -m 700 -p -- "$d" && : > "$d/stdout" && : > "$d/stderr" && cat > "$d/run.sh"`;

/** payload 走 stdin，只有路径进 argv（05 §7 #3）。 */
const WRITE_STDIN_SCRIPT = `exec base64 -d > "$1/stdin"`;

/**
 * 起进程。
 *
 * `setsid` 让 runner 成为**新 session 的 leader**，于是它的 pid 就是新进程组的
 * pgid —— 实测 launcher 侧的 `$!` 与 runner 内的 `$$` 是同一个数（996/996），
 * 所以这里直接记 `$!`，读作业状态时就不用等 runner 自己汇报。
 *
 * `< /dev/null > /dev/null 2>&1` 把 runner 与 launcher 的三条流彻底切断：不切的话
 * launcher 这次 execution 会因为「还有人持有写端」而迟迟收不到 EOF，`startJob` 就
 * 不是「立刻返回」了。
 */
const LAUNCH_SCRIPT = `setsid sh "$1/run.sh" < /dev/null > /dev/null 2>&1 & printf %s "$!" > "$1/pgid"`;

/**
 * 一次 read = 一次 exec。三样东西各走一条通道，互不污染：
 *   stdout ← 第一行状态 + 第二行 stdout 增量的 base64
 *   stderr ← stderr 增量的 base64（经 fd 3，见下）
 *   exit   ← 66 表示作业目录没了
 *
 * ⚠️ **`exec 3>&2 2>/dev/null` 是承重的**：脚本自己的任何诊断（`tail: cannot open`
 * 之类）若落到 stderr，就会拌进 stderr 增量的 base64 里，解出来是垃圾。把真 stderr
 * 复制到 fd 3、把 fd 2 扔掉，之后只有我们自己 `>&3` 的那份 base64 能出去。
 *
 * ⚠️ **状态必须在读数据之前定**（`st=` 这一段在两个 `tail` 之前）。反过来的话：
 * 先读数据、再看状态，两步之间作业可能刚好写完并退出，于是我们既报了 `exited`
 * 又没带上那几个字节——而调用方看到 exited 就不再轮询了，那几行永远丢。
 * 现在的顺序最坏只是「多轮询一次」：这一轮报 running，下一轮看到 exit 文件之后
 * 才去读，那时该写的都写完了。
 *
 * 状态三态：`running` / `gone`（进程组没了但没留下 exit 文件 —— 被 SIGKILL 掉的
 * runner 就是这样）/ 一个数字（真退出码）。
 */
const STATUS_SNIPPET =
  `if [ -f "$d/exit" ]; then st=$(cat "$d/exit")\n` +
  `elif [ -f "$d/pgid" ] && ! kill -0 -"$(cat "$d/pgid")" 2>/dev/null; then st=gone\n` +
  `else st=running; fi`;

const READ_SCRIPT =
  `d=$1; n1=$2; n2=$3; ticks=$4\n` +
  `[ -d "$d" ] || exit ${EXIT_NO_JOB_DIR}\n` +
  `exec 3>&2 2>/dev/null\n` +
  `i=0\n` +
  `while [ "$i" -lt "$ticks" ] && [ ! -f "$d/exit" ] ` +
  `&& [ "$(wc -c < "$d/stdout")" -le "$n1" ] && [ "$(wc -c < "$d/stderr")" -le "$n2" ]; do\n` +
  `  sleep ${GUEST_WAIT_TICK_SECONDS}; i=$((i+1))\n` +
  `done\n` +
  `${STATUS_SNIPPET}\n` +
  `printf '%s\\n' "$st"\n` +
  `tail -c +$((n1+1)) -- "$d/stdout" | base64 -w0\n` +
  `tail -c +$((n2+1)) -- "$d/stderr" | base64 -w0 >&3`;

/**
 * 只问状态、**一个字节的输出都不搬**。
 *
 * ⚠️ 单独一条脚本而不是「用 `READ_SCRIPT` 传 ticks=0」：那样 `tail -c +1` 会把整份
 * stdout 重新 base64 一遍再丢掉——对一个跑了半小时、日志上百 MB 的 Task，杀掉它的
 * 宽限窗里会反复搬运几百 MB。
 */
const STATUS_SCRIPT =
  `d=$1\n` + `[ -d "$d" ] || exit ${EXIT_NO_JOB_DIR}\n` + `${STATUS_SNIPPET}\n` + `printf %s "$st"`;

/**
 * 往整个进程组投信号。
 *
 * ⚠️ `kill -TERM -- -<pgid>` 在 dash 里**报错**（`kill: Illegal number: -`），
 * 必须写成 `kill -TERM -<pgid>`。这条是实测踩出来的，不是风格问题。
 * 已经死掉的进程组回非 0，这里吞掉——kill 是幂等的。
 */
const KILL_SCRIPT =
  `d=$1; sig=$2\n` +
  `[ -f "$d/pgid" ] || exit 0\n` +
  `p=$(cat "$d/pgid")\n` +
  `[ -n "$p" ] || exit 0\n` +
  `kill -"$sig" -"$p" 2>/dev/null || true`;

const RELEASE_SCRIPT = `rm -rf -- "$1"`;

export class BoxliteSandboxJobs implements SandboxJobs {
  constructor(
    private readonly providerName: string,
    private readonly boxFor: BoxFor,
  ) {}

  async startJob(handle: SandboxHandle, spec: JobSpec): Promise<JobHandle> {
    const box = await this.box(handle);
    if (spec.cmd.length === 0) {
      throw new SandboxProviderError(
        SandboxProviderErrorCode.INVALID_STATE,
        'JobSpec.cmd is empty — a job needs at least the program name',
      );
    }
    const dir = `${JOB_ROOT}/.platform-job-${randomBytes(16).toString('hex')}`;
    const needTimeout = spec.timeoutMs !== undefined;

    const setup = await runGuestScript(box, SETUP_SCRIPT, [dir, needTimeout ? '1' : '0'], {
      stdin: runnerScript(dir, spec),
    });
    if (setup.code === EXIT_NO_TIMEOUT_BINARY) {
      throw new SandboxProviderError(
        SandboxProviderErrorCode.UNSUPPORTED_CAPABILITY,
        `this sandbox image has no timeout(1), so a job's ${spec.timeoutMs}ms sandbox-side ` +
          'deadline cannot be honoured. Refusing the job up front rather than accepting it and ' +
          'letting it run unbounded (04 §2.6 JobSpec.timeoutMs).',
      );
    }
    expectOk('job setup', setup);

    if (spec.stdin !== undefined) {
      expectOk(
        'job stdin',
        await runGuestScript(box, WRITE_STDIN_SCRIPT, [dir], {
          stdin: Buffer.from(spec.stdin, 'utf8').toString('base64'),
        }),
      );
    }

    // env 挂在 launcher 这次 exec 上，经 setsid 一路继承给作业本身；native 的 env 是
    // 独立参数，**不经过任何 shell 拼接** ⇒ 不会像 aio 那样进 `bash -c` 的 argv。
    // cwd 同理走 native `workingDir`：目录不存在时 exec 当场失败，比 runner 里 `cd ||
    // exit 127` 更早、更响。
    expectOk(
      'job launch',
      await runGuestScript(box, LAUNCH_SCRIPT, [dir], { env: spec.env, cwd: spec.cwd }),
    );
    return { provider: this.providerName, jobId: encodeJobId(dir) };
  }

  async readJob(
    handle: SandboxHandle,
    job: JobHandle,
    cursor?: JobCursor,
    opts?: JobReadOptions,
  ): Promise<JobChunk> {
    const box = await this.box(handle, job);
    const dir = decodeJobId(job.jobId);
    const at = decodeCursor(cursor);
    const budgetMs = opts?.waitMs ?? 0;
    const ticks = Math.ceil(budgetMs / (GUEST_WAIT_TICK_SECONDS * 1000));

    const r = await runGuestScript(
      box,
      READ_SCRIPT,
      [dir, String(at.stdout), String(at.stderr), String(ticks)],
      // 传输层兜底：guest 侧最多等 `budgetMs`，再给它一点余量。没有这层的话，
      // 一个卡住的微 VM 会把调用方钉死在这里。
      { timeoutSecs: Math.ceil(budgetMs / 1000) + GUEST_READ_SLACK_SECONDS },
    );
    if (r.code === EXIT_NO_JOB_DIR) {
      // 比「空 chunk + still running」响得多：那会让调用方永远轮询下去。
      throw new SandboxProviderError(
        SandboxProviderErrorCode.NOT_FOUND,
        `boxlite no longer has job scratch dir ${dir} — its output and exit status are gone ` +
          '(already released, or the sandbox was recreated)',
      );
    }
    if (r.code !== 0) {
      throw new SandboxProviderError(
        SandboxProviderErrorCode.INTERNAL,
        `boxlite job read failed: exit=${r.code} ${r.stderr.trim()}`.trim(),
      );
    }

    const newline = r.stdout.indexOf('\n');
    const statusWord = (newline < 0 ? r.stdout : r.stdout.slice(0, newline)).trim();
    const stdoutB64 = newline < 0 ? '' : r.stdout.slice(newline + 1);
    const state = parseStatus(statusWord);

    // 只交完整的行，尾巴留在**游标后面**下次再读（而不是留在内存里——内存活不过
    // 平台重启，游标能）。作业已经结束时把残行也刷出去：不会再有东西来补全它了。
    const stdout = trimToLineBoundary(Buffer.from(stdoutB64, 'base64'), state.status === 'exited');
    // ⚠️ stderr **不做**行对齐——与 aio 侧 `readStderrIncrement` 一致：那边是整文件
    // 切片、不看换行。stderr 不喂 `parseOutput`（04 §2.6 裁决 3 的分流就是为了这个），
    // 半行只会让日志里少一个字符，而按行截会在「作业一直不退出且最后一行没写完」时
    // 把那行**无限期扣住**——对一条本来就是给人看的诊断流，那是更坏的失败。
    const stderr = Buffer.from(r.stderr, 'base64');
    return {
      stdout: stdout.toString('utf8'),
      stderr: stderr.toString('utf8'),
      // ⚠️ 游标按**字节**推进，而且只推进到换行为止 —— 换行是 0x0A，UTF-8 多字节
      // 序列里不可能出现这个字节，所以游标永远落在字符边界上，下一次 `tail -c +N`
      // 不会从半个字符中间切开。
      cursor: encodeCursor({
        stdout: at.stdout + stdout.length,
        stderr: at.stderr + stderr.length,
      }),
      status: state.status,
      ...(state.exitCode === undefined ? {} : { exitCode: state.exitCode }),
    };
  }

  /**
   * 两阶段 kill（03 §8.3）：按要的信号投给**整个进程组**，宽限窗内没停就 SIGKILL。
   *
   * 刻意**不** release：杀完之后调用方最想要的恰恰是退出码和输出的尾巴，而 release
   * 会把它们一起删掉（契约原文）。
   *
   * ⚠️ runner 自己装了 `trap`（见 `runnerScript`），所以 SIGTERM 这一档能留下
   * `exit=143`；升级到 SIGKILL 时 runner 也会被杀、来不及记账，那种情况由
   * `readJob` 的 `kill -0` 探测兜住（状态 `gone` ⇒ 已退出、无退出码，契约明写
   * 「被信号杀死的进程没有普通退出码」）。
   */
  async killJob(handle: SandboxHandle, job: JobHandle, signal?: NodeJS.Signals): Promise<void> {
    const box = await this.box(handle, job);
    const dir = decodeJobId(job.jobId);
    const requested = signal ?? 'SIGTERM';
    await runGuestScript(box, KILL_SCRIPT, [dir, requested.replace(/^SIG/, '')]);
    if (requested === 'SIGKILL') return;
    if (await this.waitExited(box, dir, BOXLITE_JOB_KILL_GRACE_MS)) return;
    await runGuestScript(box, KILL_SCRIPT, [dir, 'KILL']);
  }

  /** 幂等：目录早就没了也静默成功（与 `destroy` 同一条纪律）。 */
  async releaseJob(handle: SandboxHandle, job: JobHandle): Promise<void> {
    const box = await this.box(handle, job);
    await runGuestScript(box, RELEASE_SCRIPT, [decodeJobId(job.jobId)]);
  }

  /** 宽限窗轮询：只问状态，不取字节（`ticks=0` ⇒ guest 侧不等待）。 */
  private async waitExited(box: ExecCapableBox, dir: string, ms: number): Promise<boolean> {
    const rounds = Math.max(1, Math.round(ms / KILL_POLL_MS));
    for (let i = 0; i < rounds; i++) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, KILL_POLL_MS);
        timer.unref?.();
      });
      const r = await runGuestScript(box, STATUS_SCRIPT, [dir]).catch(() => null);
      if (r === null || r.code === EXIT_NO_JOB_DIR) return true;
      if (parseStatus(r.stdout.trim()).status === 'exited') return true;
    }
    return false;
  }

  private async box(handle: SandboxHandle, job?: JobHandle): Promise<ExecCapableBox> {
    if (handle.provider !== this.providerName) {
      throw new SandboxProviderError(
        SandboxProviderErrorCode.INVALID_STATE,
        `sandbox handle belongs to provider '${handle.provider}', not '${this.providerName}'`,
      );
    }
    if (job !== undefined && job.provider !== this.providerName) {
      throw new SandboxProviderError(
        SandboxProviderErrorCode.INVALID_STATE,
        `job handle belongs to provider '${job.provider}', not '${this.providerName}'`,
      );
    }
    return this.boxFor(handle);
  }
}

/** 读 exec 的传输层兜底比 guest 的等待预算多留这么多秒。 */
const GUEST_READ_SLACK_SECONDS = 20;

/**
 * 生成 runner 脚本。
 *
 * ⚠️ **`trap` 必须是一个真处理器，不能是 `trap '' TERM`（忽略）。** 实测踩过：
 * 设成忽略之后，`sh` 的子进程**继承 SIG_IGN**（POSIX 规定被忽略的处置跨 fork/exec
 * 继承），于是 `kill -TERM -<pgid>` 把整组打成了不死之身——作业根本杀不掉。
 * 换成真处理器：子进程拿到的是默认处置（被捕获的信号在子进程里会重置为默认），
 * 作业被杀、runner 活下来把 143 记进 `exit` 文件。实测 `kill -TERM -<pgid>` 之后
 * `exit` = 143、进程组消失。
 *
 * `timeout -k 5 N` 兑现 `JobSpec.timeoutMs`，而且**超时正好回 124** —— 那就是
 * 平台既有的超时口径（03 §8.3），不用再翻译一次。
 */
function runnerScript(dir: string, spec: JobSpec): string {
  const d = shQuote(dir);
  const record = (code: string): string =>
    `printf %s ${code} > ${shQuote(`${dir}/exit.tmp`)}; mv -f ${shQuote(`${dir}/exit.tmp`)} ${shQuote(`${dir}/exit`)}`;
  const argv = spec.cmd.map(shQuote).join(' ');
  const command =
    spec.timeoutMs === undefined
      ? argv
      : `timeout -k ${TIMEOUT_KILL_AFTER_SECONDS} ${Math.ceil(spec.timeoutMs / 1000)} ${argv}`;
  const stdinSource = spec.stdin === undefined ? '/dev/null' : shQuote(`${dir}/stdin`);
  return (
    `trap '${record('143').replace(/'/g, `'\\''`)}; exit 143' INT TERM HUP\n` +
    `${command} < ${stdinSource} > ${d}/stdout 2> ${d}/stderr\n` +
    `${record('"$?"')}\n`
  );
}

/** POSIX 单引号包裹，让 guest 的 shell 逐字还原这个词。 */
function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function parseStatus(word: string): { status: JobStatus; exitCode?: number } {
  if (word === 'running') return { status: 'running' };
  // 进程组没了却没留下 exit 文件 ⇒ 已经结束，但**没有普通退出码**（被 SIGKILL）。
  // 契约允许 exitCode 缺席，并要求调用方按「非 0 退出」处理。
  if (word === 'gone' || word === '') return { status: 'exited' };
  const code = Number(word);
  return Number.isFinite(code) ? { status: 'exited', exitCode: code } : { status: 'exited' };
}

/**
 * 作业还活着时只交到最后一个换行为止；结束后整段刷出。
 * 半行交上去会让 `parseOutput` 拿到一个解不动的碎片，而残尾没有任何能扛住平台重启
 * 的内存位置可放 —— 所以把它留在**游标后面**，下次连着新字节一起读。
 */
function trimToLineBoundary(buf: Buffer, flush: boolean): Buffer {
  if (flush) return buf;
  const i = buf.lastIndexOf(0x0a);
  return i < 0 ? Buffer.alloc(0) : buf.subarray(0, i + 1);
}

/**
 * `JobHandle.jobId` 里装的东西。平台**从不解析**它（04 §2.6 裁决 1），只存、只还，
 * 所以编码怎么写都行——唯一硬要求是能原样过一趟数据库，「平台重启不丢正在跑的
 * Task」全靠这一点。这里只需要 scratch 目录：别的（pgid、退出码、游标起点）都能
 * 从目录里的文件推出来，多存一份就多一份对不上的机会。
 */
function encodeJobId(dir: string): string {
  return JSON.stringify({ d: dir });
}

function decodeJobId(jobId: string): string {
  let raw: unknown;
  try {
    raw = JSON.parse(jobId);
  } catch {
    raw = null;
  }
  const dir =
    typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>)['d'] : undefined;
  if (typeof dir !== 'string' || !dir.startsWith(`${JOB_ROOT}/.platform-job-`)) {
    throw new SandboxProviderError(
      SandboxProviderErrorCode.INVALID_STATE,
      'job handle was not minted by the boxlite provider (unreadable jobId)',
    );
  }
  return dir;
}

interface DecodedCursor {
  stdout: number;
  stderr: number;
}

function encodeCursor(c: DecodedCursor): JobCursor {
  return JSON.stringify({ o: c.stdout, e: c.stderr });
}

function decodeCursor(cursor?: JobCursor): DecodedCursor {
  if (cursor === undefined || cursor === '') return { stdout: 0, stderr: 0 };
  try {
    const raw: unknown = JSON.parse(cursor);
    if (typeof raw !== 'object' || raw === null) return { stdout: 0, stderr: 0 };
    const o = raw as Record<string, unknown>;
    const num = (v: unknown): number => (typeof v === 'number' && v >= 0 ? v : 0);
    return { stdout: num(o.o), stderr: num(o.e) };
  } catch {
    // 读不懂的游标从头读，而不是抛：重发输出是可恢复的（平台自己的 seq 会去重），
    // 把一个还在跑的作业剩下的输出丢掉不是。与 aio 侧同口径。
    return { stdout: 0, stderr: 0 };
  }
}
