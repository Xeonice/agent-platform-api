import { posix } from 'node:path';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { toExecFn } from '@platform/contracts';
import type { SandboxExecFn } from '@platform/contracts';
import type {
  AuthHelper,
  AuthHelperSession,
  HelperSeedFile,
} from '../../domain/ports/auth-helper.port';
import { HelperContainerSession } from './helper-container.session';
import type { HelperContainerAccess } from './helper-container.session';

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
  //    helper 只用得上 `require()`，其余生命周期的事与它无关。
  constructor(@Inject(HelperContainerSession) private readonly session: HelperContainerAccess) {}

  async openSession(
    cmd: string[],
    seed: HelperSeedFile[] = [],
    configDirEnvNames: readonly string[] = [],
  ): Promise<AuthHelperSession> {
    const { provider, handle } = await this.session.require();
    const exec = toExecFn(provider, handle);

    const homeDir = await this.mintHome(exec);
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
          await pty.kill().catch(() => undefined);
          // ⚠️ 即便容器整个没了这里也不该抛 —— `dispose` 跑在 `finally` 里，
          //    它自己失败会盖掉真正的那个错。
          await exec(['rm', '-rf', homeDir]).catch((e: unknown) =>
            this.logger.warn(`helper 内临时 HOME 未能删除 ${homeDir}：${msgOf(e)}`),
          );
        },
      };
    } catch (e) {
      // 建了 HOME 之后任何一步失败，都要把它清掉再往外抛 —— 否则就是 §1.1 诊断项
      // 专门在找的那种「`finally` 漏删的泄漏」。
      await exec(['rm', '-rf', homeDir]).catch(() => undefined);
      throw e;
    }
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
    if (r.exitCode !== 0) {
      // ⛔ 不回显内容（那是凭证），也不回显整条 argv —— 只说哪个相对路径没写成。
      throw new Error(`helper 容器里写不进种子文件 '${f.relPath}'（exit=${String(r.exitCode)}）`);
    }
  }
}

function msgOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
