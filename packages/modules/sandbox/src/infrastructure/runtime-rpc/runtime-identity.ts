import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { SandboxHandle, SandboxRuntimeStatus } from '@platform/contracts';

/** Physical start evidence, never an identity invented from a provider handle. */
export async function runtimeStartIdentity(
  handle: SandboxHandle,
  status: SandboxRuntimeStatus,
): Promise<string | null> {
  if (status.lifecycleState !== 'instance_running') return null;
  if (handle.provider === 'boxlite') {
    const home = process.env.BOXLITE_HOME;
    if (!home || !isAbsolute(home) || !/^[A-Za-z0-9_-]{1,128}$/.test(handle.providerSandboxId))
      return null;
    try {
      const [pidText = '', birth = ''] = (
        await readFile(join(home, 'boxes', handle.providerSandboxId, 'shim.pid'), 'utf8')
      )
        .trim()
        .split('\n');
      if (!/^\d+$/.test(pidText) || !/^\d+$/.test(birth)) return null;
      const pid = Number(pidText);
      if (!Number.isSafeInteger(pid) || pid < 1) return null;
      const stat = await readFile(join('/proc', pidText, 'stat'), 'utf8');
      const close = stat.lastIndexOf(')');
      if (close < 0) return null;
      const fields = stat
        .slice(close + 1)
        .trim()
        .split(/\s+/);
      if (fields[19] !== birth || ['Z', 'X'].includes(fields[0] ?? '')) return null;
      return `boxlite:${handle.providerSandboxId}:shim:${pidText}:${birth}`;
    } catch {
      return null;
    }
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
        return `aio:${handle.providerSandboxId}:pid:${pid}:start:${started}`;
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
