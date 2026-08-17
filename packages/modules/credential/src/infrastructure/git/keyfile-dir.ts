import { resolve } from 'node:path';

/**
 * Base directory that holds per-clone temporary SSH keyfile dirs (03 §7.3 F). Kept
 * under DATA_ROOT (platform-private) so the boot sweeper can wipe the whole base on
 * startup — the crash fallback for `dispose()` not running under SIGKILL/OOM.
 */
export function gitKeysBaseDir(): string {
  const dataRoot = process.env.DATA_ROOT ?? resolve(process.cwd(), 'data');
  return resolve(dataRoot, '.gitkeys');
}
