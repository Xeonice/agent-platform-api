import { posix } from 'node:path';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { SandboxProviderError, SandboxProviderErrorCode, toExecFn } from '@platform/contracts';
import type { SandboxExecFn, SandboxHandle, SandboxProvider } from '@platform/contracts';
import { HelperUnavailableError } from '../../domain/ports/auth-helper.port';
import type {
  AuthHelper,
  AuthHelperSession,
  HelperSeedFile,
} from '../../domain/ports/auth-helper.port';
import { HelperContainerSession } from './helper-container.session';
import type { HelperContainerAccess } from './helper-container.session';
import { TIMED_OUT, within } from './within';

/**
 * provider 报出来的、**可能指向 helper 实例本身**的错 —— 而不是命令的结论。
 *
 * ⚠️ 光凭错误码分不清，所以**一律先确认、再作废**（{@link ContainerAuthHelper.dropIfBroken}）：
 *    在同一个实例上跑一条 `true`，仍抛这几类错、或执行通道断了 ⇒ 实例坏了，作废；跑得通 ⇒
 *    实例还活着，⛔ 不作废。误判的代价不对称：作废之后下一次使用会 force remove 这个实例，而
 *    同一个 helper 里可能还挂着别的登录会话（最多 `AUTH_SESSION_MAX` 个 PTY）和一次刷新。
 *   · NOT_FOUND —— 实例已不在，**也可能只是命令不在**：BoxLite 把「可执行文件找不到」报成
 *     `… not found …`，provider 照样映射成 NOT_FOUND（例如 helper 镜像里没装某个 runtime 的 CLI）。
 *   · INVALID_STATE —— 实例不在能执行的状态（例如 boxlite 拒绝对停掉的 helper 做 exec）。
 *   · INTERNAL —— boxlite `toProviderError` 的兜底码：BoxLite 0.9.7 对「记录还是 running、VM 已死」
 *     报的 `invalid state: Box process is no longer running …`、执行通道塌掉的报错都落在这里，
 *     但任何认不出来的报错同样落在这里。
 *   · PROVIDER_UNAVAILABLE —— 运行时一时够不着。
 * ⚠️ guest 里命令跑完、退出码非 0 是**命令**的结论，不是实例的，⛔ 不在此列。
 */
const INSTANCE_FAILURES: ReadonlySet<SandboxProviderErrorCode> = new Set([
  SandboxProviderErrorCode.NOT_FOUND,
  SandboxProviderErrorCode.INVALID_STATE,
  SandboxProviderErrorCode.INTERNAL,
  SandboxProviderErrorCode.PROVIDER_UNAVAILABLE,
]);

/**
 * 这个错是不是「helper 实例可能坏了」。
 * ⚠️ 导出给 provider 的用例：它把 BoxLite 真实报错映射出来的错误码钉在这个判断上 ——
 *    两边各抄一份码表的话，provider 改了映射、这里照样全绿，自愈却悄悄失效。
 */
export function isInstanceFailure(e: unknown): e is SandboxProviderError {
  return e instanceof SandboxProviderError && INSTANCE_FAILURES.has(e.code);
}

/**
 * 确认命令的预算。⚠️ 到点**不算**坏 —— 与存活复核同一条纪律：误判失效的代价（杀掉同一个
 * helper 里的其它会话）比让这一次失败更大。
 */
const CONFIRM_TIMEOUT_MS = 10_000;

/**
 * 一次性命令**没有退出码**（`toExecFn` 把 `null` 记成 -1）：执行通道断了 —— 微 VM 没了或 SDK
 * 抛错（`BoxliteExecStream` 的 `settle(null)`）。那是实例的事，⛔ 不是命令的结论。
 */
function channelLost(step: string): SandboxProviderError {
  return new SandboxProviderError(
    SandboxProviderErrorCode.INTERNAL,
    `auth helper 的执行通道断了（${step}的命令没有退出码）`,
  );
}

function msgOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

type Helper = { provider: SandboxProvider; handle: SandboxHandle };

/** 一次 `openSession` 的落脚点：哪个 helper、怎么在里面跑命令、建好的那个 HOME。 */
interface OpenedHome extends Helper {
  exec: SandboxExecFn;
  homeDir: string;
}

/**
 * 容器形态的 AuthHelper（11 §1.1 形态①，文档里的默认形态）—— 登录 CLI 跑在平台
 * 自己那张预制镜像的常驻 helper 容器里，与任务 sandbox 彻底解耦（05 §2 决策 A）。
 *
 * 与 {@link HostAuthHelper} 是同一个端口的两个实现，按 `AUTH_HELPER_MODE` 二选一。
 * 两者的隔离纪律逐条对齐（P1-3）：**每次操作一个全新的 HOME，`dispose` 必删**。
 * 差别只在那个 HOME 建在哪 —— 宿主形态在 api 进程的文件系统上，本形态**在容器里**，
 * 因为 CLI 就在容器里跑。
 *
 * ⚠️⚠️ **种子文件走 stdin，⛔ 永不进 argv。** `ProcessSpec.stdin` 的注释把理由写死了：
 * 「the lowest-exposure channel for feeding a short-lived secret … Kept OUT of argv/env
 * so it never reaches `/proc/<pid>/cmdline`」。刷新扫描器 seed 进去的正是**当前那份
 * 凭证明文**（05 §5.1），拼进命令行等于把它挂到容器里任何一个进程都读得到的地方。
 *
 * ⚠️ 为什么 HOME 用 `mktemp -d` 而不是平台拼一个名字：并发的登录/刷新必须互不串目录
 * （05 §4.1 `CLAUDE_CONFIG_DIR` 重定向风险），而唯一性由**容器内的**内核保证才算数 ——
 * 平台侧生成的随机名在容器里没有原子性可言。
 */
@Injectable()
export class ContainerAuthHelper implements AuthHelper {
  private readonly logger = new Logger('ContainerAuthHelper');

  // ⚠️ 注入的是具体类（Nest 要一个运行期 token），但**类型收成窄口子** ——
  //    helper 只用得上 `require()` / `invalidate()`，其余生命周期的事与它无关。
  constructor(@Inject(HelperContainerSession) private readonly session: HelperContainerAccess) {}

  async openSession(
    cmd: string[],
    seed: HelperSeedFile[] = [],
    configDirEnvNames: readonly string[] = [],
  ): Promise<AuthHelperSession> {
    const { provider, handle, exec, homeDir } = await this.openHome();
    try {
      for (const f of seed) await this.seedOne(exec, homeDir, f);

      // ⚠️ 与宿主形态**同一条纪律**：`HOME` 永远设（那是隔离本身，不是某个 runtime 的
      //    事实），另外只设这个 runtime 申报的那几个名字（04 §3 ★3z）。
      // ⛔ 不要在这里写死 `CLAUDE_CONFIG_DIR` / `CODEX_HOME` —— 第三方 CLI 认自己的名字，
      //    写死就意味着它的凭证落进容器默认 HOME，`dispose` 清不到。
      const env: Record<string, string> = { TERM: 'xterm-256color', HOME: homeDir };
      for (const name of configDirEnvNames) env[name] = homeDir;

      const pty = await provider.spawn(handle, {
        cmd,
        tty: true,
        // 与宿主形态取同一档列宽：`parseClaudeSetupToken` 要把折行拼回去，宽一点少折几次。
        cols: 120,
        rows: 30,
        cwd: homeDir,
        env,
      });

      return {
        pty,
        homeDir,
        readFile: (relPath) => this.readOne(exec, homeDir, relPath),
        dispose: async () => {
          // ⚠️ 即便容器整个没了这里也不该抛 —— `dispose` 跑在 `finally` 里，它自己失败
          //    会盖掉真正的那个错，刷新流程还会因此白记一次失败。与宿主形态同一条纪律：
          //    kill 失败 = 进程已经不在；rm 失败只记 warn。
          try {
            await pty.kill('SIGKILL');
          } catch {
            /* already gone */
          }
          await exec(['rm', '-rf', homeDir]).catch((e: unknown) =>
            this.logger.warn(`failed to remove helper HOME ${homeDir}: ${msgOf(e)}`),
          );
        },
      };
    } catch (e) {
      // 建了 HOME 之后任何一步失败，都要把它清掉再往外抛 —— 否则就是 §1.1 诊断项
      // 专门在找的那种「`finally` 漏删的泄漏」。
      await exec(['rm', '-rf', homeDir]).catch(() => undefined);
      // ⚠️ 写种子、起登录命令时 provider 报了实例级的错，而确认下来实例确实坏了（例如别的会话
      //    触发重建、把这个 helper 删了，或 VM 在会话途中死掉）：那是 helper 的故障，⛔ 不是这份
      //    凭证的 —— 抛 {@link HelperUnavailableError}，刷新扫描器据此不记到凭证头上。
      //    实例还能执行命令（例如镜像里没装这个 runtime 的 CLI）⇒ 那是这条命令的事，原样抛。
      // ⛔ 不在这里再重试一轮：凭证明文已经写过一次，让这一次干净地结束（HOME 已删），
      //    下一轮扫描 / 下一次点击会从 `require()` 重来。
      if (isInstanceFailure(e) && (await this.dropIfBroken({ provider, handle }, e, '起会话'))) {
        throw new HelperUnavailableError(`auth helper 在会话建立途中出了故障：${msgOf(e)}`, {
          cause: e,
        });
      }
      throw e;
    }
  }

  /**
   * 拿 helper 并在里面建好隔离 HOME —— 建 HOME 是**第一次 exec**，helper 坏没坏在这里见分晓。
   *
   * ⚠️ `require()` 的 inspect 复核未必看得出 VM 已死（没有 procfs 的平台核不了 shim 进程）；
   *    第一次真正执行就撞上实例级的 provider 错误时，确认之后作废句柄（{@link dropIfBroken}），
   *    从 `require()` 重来**一次** —— 作废了就是新实例，没作废就是同一个实例再试一次。
   *    仍然失败 ⇒ 不再重试，抛 {@link HelperUnavailableError}：建 HOME 只是一条 `sh`，与凭证、
   *    与哪个 CLI 都无关，它两次都跑不成就是 helper 的故障（刷新扫描器据此不把它记到凭证头上），
   *    下一次使用再来。
   */
  private async openHome(): Promise<OpenedHome> {
    const first = await this.session.require();
    try {
      return await this.mintIn(first);
    } catch (e) {
      if (!isInstanceFailure(e)) throw e;
      await this.dropIfBroken(first, e, '建隔离 HOME');
    }
    const second = await this.session.require();
    try {
      return await this.mintIn(second);
    } catch (e) {
      if (!isInstanceFailure(e)) throw e;
      await this.dropIfBroken(second, e, '重试建隔离 HOME');
      throw new HelperUnavailableError(`auth helper 两次都执行不了命令：${msgOf(e)}`, {
        cause: e,
      });
    }
  }

  private async mintIn(helper: Helper): Promise<OpenedHome> {
    const exec = toExecFn(helper.provider, helper.handle);
    return { ...helper, exec, homeDir: await this.mintHome(exec) };
  }

  /**
   * 命令撞上实例级的 provider 错误之后：先确认实例是不是真坏了（见 {@link INSTANCE_FAILURES}），
   * 坏了才作废并返回 `true`。作废原因写明是哪一步、报了什么 —— 事后还原「box id 为什么变了」
   * 只能靠那一行。
   */
  private async dropIfBroken(
    helper: Helper,
    e: SandboxProviderError,
    step: string,
  ): Promise<boolean> {
    if (await this.stillAnswers(helper)) {
      this.logger.warn(
        `auth helper ${helper.handle.providerSandboxId} ${step}时报 ${e.code}（${e.message}），` +
          '但它仍能执行命令 —— 不作废',
      );
      return false;
    }
    this.session.invalidate(helper.handle, `${step}时 provider 报 ${e.code}：${e.message}`);
    return true;
  }

  /**
   * 在同一个实例上跑一条 `true`：跑完了（不论退出码）⇒ 实例还能执行命令。
   * 仍抛实例级的错、或没有退出码（通道断了）⇒ 答不上来。到点没答 ⇒ 按「还能」处理（见
   * {@link CONFIRM_TIMEOUT_MS}）。
   */
  private async stillAnswers(helper: Helper): Promise<boolean> {
    const probe = toExecFn(helper.provider, helper.handle)(['true'], {
      timeoutMs: CONFIRM_TIMEOUT_MS,
    }).then(
      (r) => r.exitCode !== -1,
      (err: unknown) => !isInstanceFailure(err),
    );
    const answered = await within(probe, CONFIRM_TIMEOUT_MS);
    return answered === TIMED_OUT || answered;
  }

  /**
   * 从**容器内**的 HOME 读回一个文件。
   *
   * ⚠️⚠️ 这一半此前是缺的,而缺的后果不是「读不到」这么直白:2026-09-22 真机上
   * device login **走完了**、codex 也确实写出了 `auth.json`,平台却在
   * `readFile(join(ctx.homeDir, 'auth.json'))` 上拿到 ENOENT —— 那个路径在容器里。
   * ⛔ 而用户看到的是「对方拒绝了这次登录」,指向完全错误的方向。
   *
   * ⚠️ 用 `cat` 而不是 `docker cp`:后者在本仓不存在（runtime 层没有 exec 也没有 cp,
   * 一切都走镜像内的 agent）。⚠️ 路径经 `$1` 传入,⛔ 不拼进脚本。
   *
   * ⚠️ 这里读失败**刻意不归成** {@link HelperUnavailableError}，哪怕是 helper 在这一刻死了：
   *    读回发生在 CLI 已经跑过之后，refresh token 可能已经被厂商轮换、新的那份随 helper 一起
   *    没了 —— 平台手里那份旧凭证此后多半真的刷新不了。让这次失败照常记到凭证头上，才是如实
   *    反映；豁免它只会把同一个结论推迟到下一轮（拿旧 token 再刷一次、被厂商拒绝）。
   */
  private async readOne(exec: SandboxExecFn, homeDir: string, relPath: string): Promise<string> {
    const target = posix.join(homeDir, relPath);
    const r = await exec(['sh', '-c', 'cat "$1"', 'sh', target]);
    if (r.exitCode !== 0) {
      // ⛔ 不回显内容（可能是凭证）,只说哪个相对路径没读到。
      throw new Error(`helper 容器里读不到 '${relPath}'（exit=${String(r.exitCode)}）`);
    }
    return r.stdout;
  }

  /** 在**容器内**开一个一次性 HOME，返回绝对路径。 */
  private async mintHome(exec: SandboxExecFn): Promise<string> {
    // `umask 077` ⇒ 目录 0700。⚠️ 不能事后 chmod：那中间有一个窗口它是可读的。
    //
    // ⚠️⚠️ **建在 `$HOME` 下而不是 `/tmp`。** codex 会自己检查这件事，撞上就打印
    // `Refusing to create helper binaries under temporary dir "/tmp"` —— 它把临时目录
    // 当成不可信位置（那里的东西别人能换掉）。⛔ 而它只是**警告**、照样往下跑，所以
    // 这条不会让登录直接失败，只会让它在某个更深的地方坏掉。
    // `${HOME:-/tmp}` 的兜底是给「镜像里没设 HOME」那种情况留的：宁可回到旧行为，
    // 也不要 `mktemp` 拿到一个空路径。
    const r = await exec([
      'sh',
      '-c',
      'umask 077; d="${HOME:-/tmp}"; mkdir -p "$d" && mktemp -d "$d/auth-helper.XXXXXXXX"',
    ]);
    // 没有退出码 = 通道断了：那是实例的事，交给 `openHome` 的确认与重试，⛔ 不当成命令失败。
    if (r.exitCode === -1) throw channelLost('建隔离 HOME');
    const home = r.stdout.trim();
    // ⛔ **必须校验是绝对路径**，这不是防御性编程。宿主形态踩过一模一样的坑：homeDir
    //    是相对的时候，codex 会按自己的 cwd 再解析一遍然后直接退出，而 claude 不校验、
    //    照跑不误 —— **同一个 bug 只打挂一半 runtime**，看起来像「codex 坏了」。
    if (r.exitCode !== 0 || !home.startsWith('/')) {
      throw new Error(
        `helper 容器里建不出隔离 HOME（exit=${String(r.exitCode)}）：${home || '无输出'}`,
      );
    }
    return home;
  }

  /**
   * 把一个种子文件写进容器内的 HOME。
   *
   * ⚠️ `relPath` 可能是嵌套的（`.config/acme/auth.json`，由 adapter 申报），所以必须
   * 先 `mkdir -p`；少这一步会 ENOENT，而刷新流程死在一个没人手写过的路径上。
   */
  private async seedOne(exec: SandboxExecFn, homeDir: string, f: HelperSeedFile): Promise<void> {
    const target = posix.join(homeDir, f.relPath);
    const mode = (f.mode ?? 0o600).toString(8).padStart(3, '0');
    const r = await exec(
      [
        'sh',
        '-c',
        // ⚠️ 路径经 `$1` 传入而不是拼进脚本 —— 拼字符串就得自己处理引号转义，
        //    而 adapter 申报的 relPath 不受平台控制。
        // ⚠️ 内容经 **stdin**（见类抬头）：它是凭证明文，⛔ 绝不能进 argv。
        'set -e; mkdir -p "$(dirname "$1")"; umask 077; cat > "$1"; chmod "$2" "$1"',
        'sh',
        target,
        mode,
      ],
      { stdin: f.content },
    );
    if (r.exitCode === -1) throw channelLost(`写种子文件 '${f.relPath}'`);
    if (r.exitCode !== 0) {
      // ⛔ 不回显内容（那是凭证），也不回显整条 argv —— 只说哪个相对路径没写成。
      throw new Error(`helper 容器里写不进种子文件 '${f.relPath}'（exit=${String(r.exitCode)}）`);
    }
  }
}
