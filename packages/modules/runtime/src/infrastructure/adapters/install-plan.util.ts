import type { RuntimeInstallPlan, SandboxExecFn } from '@platform/contracts';
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
const PROBE_TIMEOUT_MS = 60_000;

/**
 * Images known to SHIP a given CLI (04 §3 ★1 measurements):
 *   - `agent-infra/sandbox` (the AIO default) ships codex, NOT claude-code;
 *   - `cap-boxlite-sandbox` ships both.
 * The verdict is only a HINT about strategy and duration — correctness never rests
 * on it, because `ensureRuntimeInstalled` always runs a live `isInstalled` probe and
 * a `preinstalled` claim the probe disproves is a LOUD failure, not a silent install.
 */
const PREINSTALLED: Record<string, RegExp[]> = {
  codex: [/agent-infra\/sandbox/i, /cap-boxlite-sandbox/i],
  'claude-code': [/cap-boxlite-sandbox/i],
};

export function imagePreinstalls(imageRef: string, runtimeId: string): boolean {
  return (PREINSTALLED[runtimeId] ?? []).some((re) => re.test(imageRef));
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
