import type { ResolvedImageSpec, RuntimeInstallPlan, SandboxExecFn } from '@platform/contracts';
import { AdapterAuthError } from '../../domain/errors/adapter-auth.error';

/**
 * Shared install helpers for the two built-in, npm-distributed agent CLIs. This is
 * NOT platform-generic logic sneaking back in — it is two adapters that happen to
 * share a package manager reusing a helper INSIDE the adapter layer. Anything
 * runtime-specific (which package, which binary, which image preinstalls it, the
 * inner-sandbox flags) stays in each adapter (04 §3 ★2).
 */

/** How long a single install command may run (a cold claude-code took 753s). */
const INSTALL_CMD_TIMEOUT_MS = 30 * 60_000;
/**
 * ⚠️ **60s → 120s（2026-08-26，boxlite 数据面换 native 时按实测重算）。**
 * 这条预算原先是按**容器**定的：docker 里 `codex --version` 44ms，60s 看着奢侈。
 * 微 VM 不是那个量级——同一条命令在 BoxLite microVM 里实测 **18.6 秒**（420×，
 * COW qcow2 + virtiofs 的代价，与数据面实现无关，SANDBOX-RUNTIME-DECISIONS 决策 A
 * 修订记着这个数）。60s 只剩 3.2× 余量，而这条超时一旦误触发，表现是
 * 「CLI 明明装着却被判定为没装」，接着白跑一次十几分钟的安装。
 * 120s ≈ 6.5× 实测值；它只影响**故障时多等多久**，不影响正常路径的任何一毫秒。
 */
const PROBE_TIMEOUT_MS = 120_000;

/**
 * Does this image DECLARE that it preinstalls `runtimeId` (04 §3 ★1)?
 *
 * The verdict is only a HINT about strategy and duration — correctness never rests on
 * it, because `ensureRuntimeInstalled` always runs a live `isInstalled` probe and a
 * `preinstalled` claim the probe disproves is a LOUD failure, not a silent install.
 *
 * ⚠️ IT USED TO REGEX THE REF STRING, AND THAT WAS A REGISTERED, UNFIXED DEFECT
 * (04 §7 ★ 第 3 条). The whole implementation was:
 *
 *     const PREINSTALLED: Record<string, RegExp[]> = {
 *       codex: [/agent-infra\/sandbox/i, /cap-boxlite-sandbox/i],
 *       'claude-code': [/cap-boxlite-sandbox/i],
 *     };
 *     imagePreinstalls(imageRef, runtimeId) =>
 *       (PREINSTALLED[runtimeId] ?? []).some((re) => re.test(imageRef));
 *
 * A pattern over a NAME cannot answer a question about BITS: it says 「no」 for the
 * platform's own mirror (`localhost:5001/platform/sandbox:v1`), it keeps saying 「yes」
 * after the tag is re-pushed with different contents, and it knows nothing whatsoever
 * about a user-registered image. It never caused an incident only because the live
 * probe caught it every time — 「被别的机制兜住的错，不是没错」, and the day that
 * fallback is optimised away it becomes one.
 *
 * Now it reads what the image itself declared (`platform.supportedRuntimes`, frozen on
 * the manifest row at registration and carried on `ResolvedImageSpec`). An image that
 * declares nothing degrades to 现装 — the safe direction, and the same answer the old
 * table gave for every image it had never heard of.
 */
export function imagePreinstalls(image: ResolvedImageSpec, runtimeId: string): boolean {
  return (image.supportedRuntimes ?? []).includes(runtimeId);
}

/** Assemble the npm-global install plan for one CLI. */
export function npmInstallPlan(input: {
  packageName: string;
  binary: string;
  preinstalled: boolean;
  estimatedInstallSec: number;
}): RuntimeInstallPlan {
  return {
    strategy: input.preinstalled ? 'preinstalled' : 'install-on-start',
    packageManagerCmds: input.preinstalled ? [] : [`npm install -g ${input.packageName}`],
    requiredBinaries: [input.binary],
    envRequirements: [],
    estimatedInstallSec: input.preinstalled ? 0 : input.estimatedInstallSec,
  };
}

/**
 * The ONLY sanctioned "is it installed" test (RA-01 / 04 §2.1★): PATH lookup, then a
 * real `--version`. `command -v` alone is not enough — a dangling shim resolves but
 * does not run — and a hard-coded path is wrong on both built-in providers.
 */
export async function probeOnPath(exec: SandboxExecFn, binary: string): Promise<boolean> {
  const found = await exec(['sh', '-c', `command -v ${binary}`], { timeoutMs: PROBE_TIMEOUT_MS });
  if (found.exitCode !== 0) return false;
  const version = await exec([binary, '--version'], { timeoutMs: PROBE_TIMEOUT_MS });
  return version.exitCode === 0;
}

/** Run the plan's commands in order; the first failure aborts with INSTALL_FAILED. */
export async function runInstallCommands(exec: SandboxExecFn, cmds: string[]): Promise<void> {
  for (const cmd of cmds) {
    const r = await exec(['sh', '-c', cmd], { timeoutMs: INSTALL_CMD_TIMEOUT_MS });
    if (r.exitCode !== 0) {
      throw new AdapterAuthError(
        'INSTALL_FAILED',
        `'${cmd}' exited ${r.exitCode}: ${tail(r.stdout)}`,
      );
    }
  }
}

/** Keep the last few lines of output for the failure reason; never the whole log. */
function tail(output: string): string {
  return output.split('\n').filter(Boolean).slice(-3).join(' / ').slice(0, 500);
}
