import type { ProcessSpec, SandboxHandle, SandboxProvider } from './sandbox-provider.contract';
import type { SandboxExecFn } from './runtime-adapter.contract';

/**
 * `toExecFn(provider, handle)` — the platform-side convenience 04 §2.3 promises.
 *
 * `exec` is deliberately NOT a `SandboxProvider` method: it IS
 * `spawn({ tty:false })` plus "collect output to EOF", so making every provider
 * implement it a second time would only invite implementations where `exec`
 * honours `env`/`cwd` and the pty path does not. Adapter authors receive the
 * derived function; provider authors implement `spawn` once.
 *
 * ⚠️ The derivation is why an exec exists ONLY AFTER `provider.start()`: there is
 * no process to spawn into before then. Every step of the `starting` 段 that takes
 * a `SandboxExecFn` (install / credential injection / the tmux self-check) is
 * therefore pinned behind `start()` by physics, not by style (03 §4.3).
 *
 * STDOUT/STDERR: `ProcessStream` is a single DEMULTIPLEXED byte stream (04 §2.4), so
 * the split the `SandboxExecFn` result type carries cannot be reconstructed here —
 * everything the command wrote arrives on `stdout` and `stderr` stays empty. That is
 * the honest mapping of "collect output to EOF"; callers that must separate the two
 * redirect inside the command itself (`2>/dev/null`, `2>&1`, …).
 */
export function toExecFn(provider: SandboxProvider, handle: SandboxHandle): SandboxExecFn {
  return async (cmd, opts) => {
    const spec: ProcessSpec = { ...(opts ?? {}), cmd, tty: false };
    const stream = await provider.spawn(handle, spec);
    const chunks: Buffer[] = [];
    return new Promise((resolve) => {
      stream.onData((chunk) => chunks.push(chunk));
      stream.onExit((code) =>
        resolve({
          stdout: Buffer.concat(chunks).toString('utf8'),
          stderr: '',
          // a stream killed by a signal reports `null`; surface it as a non-zero
          // exit rather than silently passing for "no exit code" (SP-09).
          exitCode: code ?? -1,
        }),
      );
    });
  };
}
