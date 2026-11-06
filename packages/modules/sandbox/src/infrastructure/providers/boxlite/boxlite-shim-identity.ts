import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { boxliteHome } from './boxlite-runtime';
import { readDarwinProcessStart, type DarwinProcessStart } from './darwin-process-start';

export interface ShimIdentityIo {
  platform: NodeJS.Platform;
  home(): string;
  readFile(path: string): Promise<string>;
  darwinProcessStart(pid: number): Promise<DarwinProcessStart | null>;
}

const HOST_IO: ShimIdentityIo = {
  platform: process.platform,
  home: () => boxliteHome(),
  readFile: (path) => readFile(path, 'utf8'),
  darwinProcessStart: readDarwinProcessStart,
};

/** A recorded PID is insufficient: its physical kernel start time must match. */
export async function boxliteShimIdentity(
  boxId: string,
  io: ShimIdentityIo = HOST_IO,
): Promise<string | null> {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(boxId)) return null;
  try {
    const home = io.home();
    if (!isAbsolute(home)) return null;
    const path = join(home, 'boxes', boxId, 'shim.pid');
    const record = await io.readFile(path);
    const [pidText = '', birth = ''] = record.trim().split('\n');
    if (!/^\d+$/.test(pidText) || !/^[1-9]\d{0,19}$/.test(birth)) return null;
    const pid = Number(pidText);
    if (!Number.isSafeInteger(pid) || pid < 1 || pid > 0x7fffffff) return null;
    if (io.platform === 'darwin') {
      const actual = await io.darwinProcessStart(pid);
      if (actual?.pid !== pid || actual.startTime !== birth) return null;
    } else if (io.platform === 'linux') {
      const stat = await io.readFile(join('/proc', pidText, 'stat'));
      const close = stat.lastIndexOf(')');
      if (close < 0 || !stat.startsWith(`${pidText} (`)) return null;
      const fields = stat
        .slice(close + 1)
        .trim()
        .split(/\s+/);
      if (fields[19] !== birth || ['Z', 'X'].includes(fields[0] ?? '')) return null;
    } else return null;
    // A concurrent restart may replace the record while the kernel read is pending.
    if ((await io.readFile(path)) !== record) return null;
    return `boxlite:${boxId}:shim:${pidText}:${birth}`;
  } catch {
    return null;
  }
}
