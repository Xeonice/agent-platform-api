import type { SandboxHandle, SandboxRuntimeStatus } from '@platform/contracts';
import { boxliteShimIdentity } from '../providers/boxlite/boxlite-shim-identity';

/** Physical start evidence, never an identity invented from a provider handle. */
export async function runtimeStartIdentity(
  handle: SandboxHandle,
  status: SandboxRuntimeStatus,
): Promise<string | null> {
  if (status.lifecycleState !== 'instance_running') return null;
  if (handle.provider === 'boxlite') {
    return boxliteShimIdentity(handle.providerSandboxId);
  }
  if (handle.provider === 'aio' && typeof status.raw === 'object' && status.raw !== null) {
    const raw = status.raw;
    if ('Pid' in raw && 'StartedAt' in raw && 'Running' in raw && raw.Running === true) {
      const pid = raw.Pid;
      const started = raw.StartedAt;
      if (
        typeof pid === 'number' &&
        Number.isSafeInteger(pid) &&
        pid > 0 &&
        typeof started === 'string' &&
        Number.isFinite(Date.parse(started))
      )
        return `aio:${handle.providerSandboxId}:pid:${String(pid)}:start:${started}`;
    }
  }
  // A provider may supply a verified native start identity. An ordinary id/PID
  // without its start time does not prove continuity and remains unconfirmed.
  if (typeof status.raw === 'object' && status.raw !== null && 'runtimeIdentity' in status.raw) {
    const value = status.raw.runtimeIdentity;
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}
