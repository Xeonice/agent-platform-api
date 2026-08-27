import { SandboxProviderError, SandboxProviderErrorCode } from '@platform/contracts';
import type { BoxliteExecution, ExecCapableBox } from './boxlite-runtime';

/**
 * BoxLite native exec 的**最低层**封装：跑一段 guest 内的 `/bin/sh` 脚本，收齐
 * stdout / stderr / exit code。文件面与作业面都建在它上面。
 *
 * ── 为什么这里不用 `AioSandboxAgentClient` 的任何东西（SANDBOX-RUNTIME-DECISIONS 决策 A 修订）
 * boxlite 的数据面**整条**换成了 native `Box.exec`。共用实现保证的是「两边一样」，
 * 而它一旦对某个 provider 不适用，「一样」就变成**一起错** —— 这次就是：同一个 box、
 * 同一条 `codex --version`，走沙箱内 HTTP agent 是 500 且 agent 此后永久挂死，
 * 走 native 是 `exit=0` 拿到版本号。所以本目录下的代码**不 import `../aio/` 的任何模块**，
 * 两档的一致性交给契约测试 `runSandboxProviderContractTests`。
 *
 * ── 三条实测出来的、决定了这层长什么样的事实（2026-08-26，本机 M9 / boxlite 0.9.7）
 *  ① **`e.stdout()` 本身返回 Promise**，不 await 的话 `.next` 不是函数。
 *  ② **stdout / stderr 必须并发抽干**。SDK 自己的 `SimpleBox.exec` 就写着理由：
 *     顺序读会在「进程写满一条管道、而我们正阻塞在读另一条」时死锁。
 *  ③ **chunk 不是按行切的**。实测 `printf a; printf b; printf "c\n"; printf tail`
 *     一次 `next()` 就返回 `"abc\nno-newline-tail"` —— 所以任何「一次 next 就是一行」
 *     的假设都是错的，需要行语义的地方（作业面）自己按字节切。
 */
export const GUEST_SHELL = '/bin/sh';

export interface GuestResult {
  /** 进程退出码。被信号杀死时是**负数**（实测：SIGTERM ⇒ -15，SIGKILL ⇒ -9）。 */
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface GuestScriptOptions {
  /** 经真 fd 0 投喂，写完立刻 `close()` ⇒ 命令能读到**真 EOF**（实测 `cat` 正常退出）。 */
  readonly stdin?: string;
  readonly env?: Record<string, string>;
  /** guest 内**真杀**（实测 `sleep 5` + 1s ⇒ 1013ms 返回 `exitCode:-15`）。 */
  readonly timeoutSecs?: number;
  readonly cwd?: string;
}

/**
 * 跑一段 guest 脚本。
 *
 * ⚠️ **路径一律走位置参数，不要拼进脚本文本。** `sh -c '<script>' platform "$@"` 里
 * 脚本看到的是 `$1` / `$2`，于是「路径里有空格 / 引号 / `$(...)`」根本没有落脚点 ——
 * 比自己写一遍 POSIX 引用安全，也比它短。（实测：`/workspace/.agent-artifacts/we ird.txt`
 * 这种名字原样通过。）`$0` 占位成 `platform`，只为了让 guest 的报错前缀可读。
 */
export async function runGuestScript(
  box: ExecCapableBox,
  script: string,
  args: string[] = [],
  opts: GuestScriptOptions = {},
): Promise<GuestResult> {
  const execution = await box.exec(
    GUEST_SHELL,
    ['-c', script, 'platform', ...args],
    toEnvTuples(opts.env),
    false,
    null,
    opts.timeoutSecs ?? null,
    opts.cwd ?? null,
  );
  return collectExecution(execution, opts.stdin);
}

/** 抽干一次 execution 的两条输出流并等它结束。见文件头 ①②。 */
export async function collectExecution(
  execution: BoxliteExecution,
  stdin?: string,
): Promise<GuestResult> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  await Promise.all([
    pumpInto(execution.stdout(), stdout),
    pumpInto(execution.stderr(), stderr),
    feedStdin(execution, stdin),
  ]);
  const result = await execution.wait();
  return { code: result.exitCode, stdout: stdout.join(''), stderr: stderr.join('') };
}

/**
 * 投喂 stdin 并**总是**关闭它。
 *
 * ⚠️ 没有 payload 也要关：不关的话 fd 0 是一根永远不会 EOF 的管道，任何「读到 EOF 才
 * 动作」的命令（`cat`、`codex login --with-access-token`）会在沙箱里挂死，而调用方
 * 只看到「这条命令怎么不返回」。关掉的代价是 0 —— 一次性 exec 本来就没有 stdin 上行。
 */
async function feedStdin(execution: BoxliteExecution, stdin?: string): Promise<void> {
  try {
    const handle = await execution.stdin();
    if (stdin !== undefined && stdin !== '') await handle.writeString(stdin);
    await handle.close();
  } catch {
    // 进程可能已经退出（短命令常见）；stdin 关不上不是错误。
  }
}

async function pumpInto(
  streamPromise: Promise<{ next(): Promise<string | null> }>,
  sink: string[],
) {
  let stream: { next(): Promise<string | null> };
  try {
    stream = await streamPromise;
  } catch {
    return; // 某些命令没有这条流，SDK 自己也是这么兜的
  }
  try {
    for (;;) {
      const chunk = await stream.next();
      if (chunk === null) return;
      sink.push(chunk);
    }
  } catch {
    // 流提前结束 ⇒ 已收到的就是全部
  }
}

export function toEnvTuples(env?: Record<string, string>): [string, string][] | null {
  if (env === undefined) return null;
  const tuples = Object.entries(env);
  return tuples.length === 0 ? null : tuples;
}

/**
 * 要求脚本以 0 退出，否则抛 INTERNAL —— 文件面/作业面里那些「不该失败」的一步
 * （建目录、落脚本、发信号）用它，免得每处写一遍 if。
 */
export function expectOk(what: string, r: GuestResult): GuestResult {
  if (r.code !== 0) {
    throw new SandboxProviderError(
      SandboxProviderErrorCode.INTERNAL,
      `boxlite guest step failed (${what}): exit=${r.code} ${r.stderr.trim() || r.stdout.trim()}`.trim(),
    );
  }
  return r;
}
