import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Injectable, Logger } from '@nestjs/common';
import type { ProcessStream } from '@platform/contracts';
import type { IPty } from '@lydell/node-pty';
import type {
  AuthHelper,
  AuthHelperSession,
  HelperSeedFile,
} from '../../domain/ports/auth-helper.port';

/**
 * Host-form AuthHelper (docs/backend/11 §1.1 form ②): runs the login CLI directly via
 * `child_process`. The default production form is the AIO helper CONTAINER via
 * `SandboxProvider.spawn({tty:true})` — swapped by DI without touching the app layer.
 *
 * Per-op isolation (P1-3,照搬 git-auth.materializer): each session gets a FRESH
 * `mkdtemp` HOME wired as HOME = CLAUDE_CONFIG_DIR = CODEX_HOME so concurrent
 * logins/refreshes never cross credential dirs; `dispose()` kills the process and
 * `rm -rf`s the temp HOME (the `finally` must-delete).
 *
 * ══ 2026-09-07：它必须是**真 PTY**，此前是管道 ═══════════════════════════════
 *
 * ⛔ 这里原来是 `child_process.spawn(..., stdio: ['pipe','pipe','pipe'])`，而本文件
 *    自己的注释就写着「this host form is not a real TTY; the setup-token/device-auth
 *    CLIs detect TTY」—— **那不是一句免责声明，那是一个 bug 的自述**：
 *
 *      claude setup-token 走管道  ⇒ **0 字节输出**（实测 25s）
 *      claude setup-token 走 PTY  ⇒ 3654 字节 / **5 个 OSC-8 超链接** / 授权 URL（实测秒级）
 *
 *    而 `parseClaudeAuthUrl` 认的正是 OSC-8。于是 `readUntil` 空等满 120s 的
 *    `BEGIN_TIMEOUT_MS`，用户看到的是一个不解释任何事的 **HTTP 500**（实测复现）。
 *
 * ⚠️ **codex 能用纯属输出格式的运气**：`codex login --device-auth` 在管道下照样打印纯文本
 *    设备码，而 codex 的解析器用的正是纯文本正则（它的注释写着「Plain-text regex is
 *    robust here (unlike claude's OSC-8)」）。同一条链路，一个通一个不通 —— 那种
 *    「一半功能能用」最容易被当成配置问题查上很久。
 *
 * ⚠️ 注释里说的「CONTAINER form (real pty) is the production path」**在代码里不存在**：
 *    全仓只有这一个 `implements AuthHelper`，而 `runtime.module.ts` 把它硬接上了。
 *    ⇒ 文档（shared/11 §1.1）里那个默认形态（复用 AIO 镜像的常驻 helper 容器，
 *    经 `SandboxProvider.spawn({tty:true})` 拿 PTY）**仍然待实现**；本次修的是
 *    「宿主形态从来就不该是管道」这件事，它让裸机部署真正可用。
 *
 * ⚠️ 为什么不绕开 CLI 自己走 OAuth：Claude Code 只有 Authorization Code + PKCE，
 *    **没有 device flow**（RFC 8628 仍是 open feature request），自己拼它的 client_id
 *    等于逆向一个私有 OAuth 客户端。驱动官方 CLI 才是被支持的那条路。
 */
@Injectable()
export class HostAuthHelper implements AuthHelper {
  private readonly logger = new Logger('HostAuthHelper');

  async openSession(
    cmd: string[],
    seed: HelperSeedFile[] = [],
    configDirEnvNames: readonly string[] = [],
  ): Promise<AuthHelperSession> {
    // ⛔ **必须绝对路径。** `DATA_ROOT` 通常是相对的（`.env.example` 出厂 `./data`），
    //    于是 homeDir 也是相对的 —— 而它会被当作 `HOME` / `CODEX_HOME` /
    //    `CLAUDE_CONFIG_DIR` 交给子进程。**任何改变 cwd 的一方都会让它指向别处**：
    //    2026-09-07 实测，给子进程设了 `cwd: homeDir` 之后，codex 立刻退出并说
    //    `CODEX_HOME points to "data/auth-helper/h-XXXX", but that path does not exist`
    //    —— 它按新 cwd 又解析了一遍那个相对路径。claude 不校验这个目录，于是**同一个
    //    bug 只打挂一半的 runtime**，看起来像「codex 坏了」而不是「路径是相对的」。
    const base = resolve(process.env.DATA_ROOT ?? tmpdir(), 'auth-helper');
    await mkdir(base, { recursive: true, mode: 0o700 });
    const homeDir = await mkdtemp(join(base, 'h-'));
    for (const f of seed) {
      // ⚠️ `relPath` may be nested (`.config/acme/auth.json`) — the adapter declares it,
      // so the helper cannot assume a flat name. Without the mkdir the write throws
      // ENOENT and the refresh dies with a message about a path nobody chose by hand.
      const target = join(homeDir, f.relPath);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, f.content, { mode: f.mode ?? 0o600 });
    }
    // node-pty 只接受 `string` 值；`process.env` 的值是 `string | undefined`。
    const env: Record<string, string> = { TERM: 'xterm-256color' };
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
    // ⚠️ **每个名字都指向这个一次性 HOME，而名字来自 adapter 申报**（04 §3 ★3z）。
    //    这里原来是写死的 `{ HOME, CLAUDE_CONFIG_DIR, CODEX_HOME }` —— 两个内置 CLI 的
    //    变量名躺在平台代码里。第三方 CLI 认自己的 `$ACME_CONFIG_DIR`，于是登录凭证落进
    //    **后端进程的真 HOME**：`dispose()` 的 `rm -rf` 清不到，且并发登录互相串。
    // ⛔ `HOME` 永远设 —— 它不是某个 runtime 的事实，而是这条隔离纪律本身（P1-3）。
    //    ⚠️ 顺带收紧了一件事：现在只设**这个 runtime 用得上的**变量，不再无差别地把
    //    两个内置名一起塞给每一条会话。
    env.HOME = homeDir;
    for (const name of configDirEnvNames) env[name] = homeDir;

    let child: IPty;
    try {
      // ⚠️ **动态 import**：node-pty 是原生模块。装不上/平台不支持时，只有真正用到登录流的
      //    请求该失败 —— ⛔ 不该让整个平台起不来（诊断、镜像、任务都与它无关）。
      //    这里抛出的错误会被 `RuntimeApplicationService.beginAuth` 包成
      //    `PROVIDER_UNAVAILABLE`（24 §「helper 容器缺失」指定的码），而不是一个哑巴 500。
      // ⚠️ 用 `@lydell/node-pty` 而不是 `node-pty`，两个理由都实测过：
      //    ① 微软那版的 darwin 预编译产物里 `spawn-helper` 是 **644**（上游 #850），
      //       而 pnpm 保留原权限 ⇒ `posix_spawnp failed.`，且**对任何命令都失败**
      //       （实测 `/bin/echo` 一样炸），第一眼极容易误判成「PATH 里没有那个 CLI」。
      //       这一版发布时就是 755。
      //    ② 微软那版**没有 linux 预编译产物** ⇒ CI 与每台 Linux 部署机都要现场
      //       node-gyp 编译；这一版带 linux-x64 / linux-arm64，安装期从不编译。
      const { spawn: ptySpawn } = await import('@lydell/node-pty');
      child = ptySpawn(cmd[0], cmd.slice(1), {
        name: 'xterm-256color',
        // ⚠️ 列宽影响 CLI 折行，而 `parseClaudeSetupToken` 要把折行拼回去。给足够宽的一档，
        //    减少折行；解析器仍然按「能折」处理，不依赖这个数。
        cols: 120,
        rows: 30,
        cwd: homeDir,
        env,
      });
    } catch (e) {
      await rm(homeDir, { recursive: true, force: true }).catch(() => undefined);
      throw new Error(
        `无法为登录 CLI 分配伪终端（${cmd.join(' ')}）：${(e as Error).message}。` +
          '登录 CLI 会检测 TTY —— 没有伪终端时 `claude setup-token` 一个字节都不输出。',
      );
    }

    const pty = new PtyProcessStream(child);
    return {
      pty,
      homeDir,
      dispose: async () => {
        try {
          child.kill();
        } catch {
          /* already gone */
        }
        await rm(homeDir, { recursive: true, force: true }).catch((e) =>
          this.logger.warn(`failed to remove helper HOME ${homeDir}: ${(e as Error).message}`),
        );
      },
    };
  }
}

/**
 * Wraps a node-pty terminal as the neutral `ProcessStream` (04 §2.4).
 *
 * ⚠️ node-pty 的 `onData` 给的是**已按 utf8 解码的 string**，而 `ProcessStream` 的契约是
 * `Buffer`（`readUntil` 会把它们拼起来再交给解析器）。这里转回 Buffer —— OSC-8 转义序列
 * 在 utf8 往返中无损，`stripAnsi` / `extractOsc8Urls` 拿到的与 CLI 写出的逐字节相同。
 *
 * ⚠️ PTY 把 stdout 与 stderr **合流**（本来就是一个终端），所以不再有两个 `on('data')`。
 */
class PtyProcessStream implements ProcessStream {
  readonly ref: string;
  constructor(private readonly term: IPty) {
    this.ref = `helper-${String(term.pid)}`;
  }
  onData(cb: (chunk: Buffer) => void): void {
    this.term.onData((s) => cb(Buffer.from(s, 'utf8')));
  }
  write(data: string | Buffer): void {
    this.term.write(typeof data === 'string' ? data : data.toString('utf8'));
  }
  /** ⚠️ 真 PTY 之后这是**真的能改**了 —— 此前宿主形态只能空转。 */
  resize(cols: number, rows: number): void {
    this.term.resize(cols, rows);
  }
  onExit(cb: (code: number | null) => void): void {
    this.term.onExit(({ exitCode }) => cb(exitCode));
  }
  async kill(signal?: NodeJS.Signals): Promise<void> {
    this.term.kill(signal);
  }

  /**
   * 松手但不发信号（detach ≠ kill）。
   *
   * ⚠️ node-pty 没有 `unref()`：它的读循环挂在原生层。这里去掉监听器就算松手 ——
   * 进程仍按自己的节奏结束，只是我们不再关心它说什么。
   */
  detach(): void {
    this.term.onData(() => undefined);
  }
}
