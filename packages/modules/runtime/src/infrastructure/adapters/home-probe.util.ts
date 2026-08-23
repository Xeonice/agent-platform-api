import type { SandboxExecFn } from '@platform/contracts';

const HOME_PROBE_CMD = ['sh', '-c', 'printf %s "$HOME"'];
const HOME_PROBE_TIMEOUT_MS = 15_000;

/** 落盘类 exec 的统一超时（写一个小文件，30s 足够且不至于把 provision 吊死）。 */
export const SEED_WRITE_TIMEOUT_MS = 30_000;

/**
 * 解析**这个沙箱**的 `$HOME`（05 §4.3 裁决 D-19）。
 *
 * 每次都经调用方的 `exec` 现探，既不写死也不跨沙箱缓存：两个内建 provider 今天碰巧
 * 都是 `/home/gem`，但 04 §7 明说 **HOME 不属于镜像契约** —— 第三方镜像或基础镜像
 * 升一版就能让任何常量失效，而 `/root`（早先那个猜测）在两个 provider 上都是错的。
 *
 * 抽成共用是因为 codex 与 claude 都要往 HOME 里落启动文件；上面这条理由值得只写一份。
 */
export async function probeSandboxHome(
  exec: SandboxExecFn,
  onFailure: (message: string) => Error,
): Promise<string> {
  const r = await exec(HOME_PROBE_CMD, { timeoutMs: HOME_PROBE_TIMEOUT_MS });
  const home = r.stdout.trim();
  if (r.exitCode !== 0 || !home.startsWith('/')) {
    throw onFailure(`could not resolve $HOME inside the sandbox (exit ${r.exitCode})`);
  }
  return home.endsWith('/') ? home.slice(0, -1) : home;
}
