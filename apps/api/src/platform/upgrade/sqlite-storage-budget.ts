import type Database from 'better-sqlite3';
import { lstat, realpath, statfs } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { requireUpgrade } from './upgrade-trust';

/** Observe the opened business database's storage, never a role's unmounted parent. */
export async function sqliteStorageObservation(sqlite: Database.Database): Promise<{
  availableBytes: number;
  walBytes: number;
}> {
  const databases = sqlite.pragma('database_list') as { name: string; file: string }[];
  const main = databases.filter((database) => database.name === 'main');
  requireUpgrade(
    main.length === 1 && typeof main[0].file === 'string' && isAbsolute(main[0].file),
    'SQLITE_STORAGE_LOCATION_UNCONFIRMED',
  );
  const databasePath = await realpath(main[0].file);
  const physical = await lstat(databasePath);
  const directory = dirname(databasePath);
  const parent = await lstat(directory);
  requireUpgrade(
    physical.isFile() && parent.isDirectory() && parent.dev === physical.dev,
    'SQLITE_STORAGE_LOCATION_UNCONFIRMED',
  );
  const capacity = await statfs(directory);
  const wal = await lstat(databasePath + '-wal').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  requireUpgrade(
    !wal || (wal.isFile() && !wal.isSymbolicLink() && wal.dev === physical.dev),
    'SQLITE_WAL_LOCATION_UNCONFIRMED',
  );
  return {
    availableBytes: Number(capacity.bavail) * Number(capacity.bsize),
    walBytes: wal?.size ?? 0,
  };
}
