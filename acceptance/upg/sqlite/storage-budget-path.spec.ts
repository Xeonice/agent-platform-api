import Database from 'better-sqlite3';
import {
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  statfs,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sqliteStorageObservation } from '../../../apps/api/src/platform/upgrade/sqlite-storage-budget';
import { useEnv } from '../../support/strict-ports';

// Real SQLite files, SQLite-created WAL and real filesystem metadata only.
// This storage-helper boundary does not prove Docker role isolation or native
// upgrade qualification. Consumer budgets are also exercised by the real
// UpgradeOnlineMigration suite, including low-WAL/disk rejection before DDL.
describe('REQ-UPG-006/007/008 — storage budget belongs to the opened SQLite database', () => {
  let root: string;
  const connections: Database.Database[] = [];
  const restores: (() => void)[] = [];
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'upg-storage-path-'));
  });
  afterEach(async () => {
    for (const sqlite of connections.splice(0)) sqlite.close();
    for (const restore of restores.splice(0)) restore();
    await rm(root, { recursive: true, force: true });
  });
  function opened(filename: string, wal = false) {
    const sqlite = new Database(filename);
    connections.push(sqlite);
    if (wal) {
      expect(sqlite.pragma('journal_mode=WAL', { simple: true })).toBe('wal');
      sqlite.pragma('wal_autocheckpoint=0');
    }
    sqlite.exec('CREATE TABLE storage_items(id INTEGER PRIMARY KEY, payload BLOB NOT NULL)');
    return sqlite;
  }
  function mainFile(sqlite: Database.Database) {
    return (sqlite.pragma('database_list') as { name: string; file: string }[]).find(
      (row) => row.name === 'main',
    )!.file;
  }
  async function physicalObservation(sqlite: Database.Database) {
    const physicalFile = await realpath(mainFile(sqlite));
    const capacity = await statfs(dirname(physicalFile));
    const observation = await sqliteStorageObservation(sqlite);
    expect(Number.isSafeInteger(observation.availableBytes)).toBe(true);
    expect(observation.availableBytes).toBeGreaterThan(0);
    expect(observation.availableBytes % Number(capacity.bsize)).toBe(0);
    expect(observation.availableBytes).toBeLessThanOrEqual(
      Number(capacity.blocks) * Number(capacity.bsize),
    );
    return observation;
  }

  it('observes the actual database and WAL even when installer/data/database env point to nonexistent paths', async () => {
    const directory = join(root, 'real-business');
    await mkdir(directory);
    const sqlite = opened(join(directory, 'platform.sqlite'), true);
    restores.push(
      useEnv({
        UPGRADE_INSTALLER_ROOT: join(root, 'missing-installer'),
        DATA_ROOT: join(root, 'missing-data'),
        DATABASE_URL: join(root, 'missing-business', 'other.sqlite'),
      }),
    );
    const observation = await physicalObservation(sqlite);
    const actualWal = await lstat(mainFile(sqlite) + '-wal');
    expect(observation.walBytes).toBe(actualWal.size);
    expect(observation.walBytes).toBeGreaterThan(0);
  });

  it('resolves a relative SQLite filename to its actual opened absolute location', async () => {
    const sqlite = opened(relative(process.cwd(), join(root, 'relative.sqlite')), true);
    expect(mainFile(sqlite)).toBe(await realpath(join(root, 'relative.sqlite')));
    expect((await physicalObservation(sqlite)).walBytes).toBe(
      (await lstat(join(root, 'relative.sqlite-wal'))).size,
    );
  });

  it('keeps a directory alias and the real database WAL on the same filesystem', async () => {
    const directory = join(root, 'physical-business');
    await mkdir(directory);
    await symlink(directory, join(root, 'business-alias'));
    const sqlite = opened(join(root, 'business-alias', 'platform.sqlite'), true);
    const observation = await physicalObservation(sqlite);
    expect(observation.walBytes).toBe((await lstat(join(directory, 'platform.sqlite-wal'))).size);
    expect(observation.walBytes).toBeGreaterThan(0);
  });

  it('keeps a symlink to the database file consistent with the WAL SQLite really created', async () => {
    const physicalFile = join(root, 'physical.sqlite');
    const original = new Database(physicalFile);
    original.close();
    const alias = join(root, 'alias.sqlite');
    await symlink(physicalFile, alias);
    const sqlite = opened(alias, true);
    const observation = await physicalObservation(sqlite);
    const actualWal = await lstat(mainFile(sqlite) + '-wal');
    expect(observation.walBytes).toBe(actualWal.size);
    expect(observation.walBytes).toBeGreaterThan(0);
  });

  it('reports the actual growing SQLite WAL without checkpointing it or substituting zero', async () => {
    const sqlite = opened(join(root, 'growing.sqlite'), true);
    const before = await sqliteStorageObservation(sqlite);
    const insert = sqlite.prepare('INSERT INTO storage_items(payload) VALUES(?)');
    for (let i = 0; i < 8; i++) insert.run(Buffer.alloc(8192, i));
    const walBeforeObservation = await lstat(mainFile(sqlite) + '-wal');
    const after = await sqliteStorageObservation(sqlite);
    expect(after.walBytes).toBe(walBeforeObservation.size);
    expect(after.walBytes).toBeGreaterThan(before.walBytes);
    expect((await lstat(mainFile(sqlite) + '-wal')).size).toBe(walBeforeObservation.size);
    expect(
      (sqlite.prepare('SELECT count(*) AS n FROM storage_items').get() as { n: number }).n,
    ).toBe(8);
  });

  it('reports zero WAL only when the actual sidecar does not exist', async () => {
    const sqlite = opened(join(root, 'no-wal.sqlite'));
    await expect(lstat(mainFile(sqlite) + '-wal')).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await physicalObservation(sqlite)).walBytes).toBe(0);
  });

  it.each([':memory:', ''])('refuses unlocatable main database %j', async (filename) => {
    const sqlite = opened(filename);
    expect(mainFile(sqlite)).toBe('');
    await expect(sqliteStorageObservation(sqlite)).rejects.toThrow(
      'SQLITE_STORAGE_LOCATION_UNCONFIRMED',
    );
  });

  it('does not report a capacity or zero WAL when the opened main file has disappeared', async () => {
    const filename = join(root, 'removed.sqlite');
    const sqlite = opened(filename);
    await rm(filename);
    await expect(sqliteStorageObservation(sqlite)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves a real filesystem resolution error instead of treating it as an absent WAL', async () => {
    const filename = join(root, 'loop.sqlite');
    const sqlite = opened(filename);
    await rename(filename, join(root, 'original.sqlite'));
    await symlink('loop.sqlite', filename);
    await expect(sqliteStorageObservation(sqlite)).rejects.toMatchObject({ code: 'ELOOP' });
  });

  it('refuses a nonregular file at the exact physical WAL location', async () => {
    const sqlite = opened(join(root, 'directory-wal.sqlite'));
    await mkdir(mainFile(sqlite) + '-wal');
    await expect(sqliteStorageObservation(sqlite)).rejects.toThrow(
      'SQLITE_WAL_LOCATION_UNCONFIRMED',
    );
  });

  it('refuses a symlink at the exact physical WAL location', async () => {
    const sqlite = opened(join(root, 'symlink-wal.sqlite'));
    const otherFile = join(root, 'unrelated-bytes');
    await writeFile(otherFile, Buffer.alloc(1024));
    await symlink(otherFile, mainFile(sqlite) + '-wal');
    await expect(sqliteStorageObservation(sqlite)).rejects.toThrow(
      'SQLITE_WAL_LOCATION_UNCONFIRMED',
    );
  });

  it('measures main rather than an attached database with its own real WAL', async () => {
    const sqlite = opened(join(root, 'main.sqlite'));
    const attached = join(root, 'auxiliary.sqlite');
    sqlite.prepare('ATTACH DATABASE ? AS auxiliary').run(attached);
    sqlite.pragma('auxiliary.journal_mode=WAL');
    sqlite.exec('CREATE TABLE auxiliary.items(id INTEGER PRIMARY KEY)');
    expect((await lstat(attached + '-wal')).size).toBeGreaterThan(0);
    expect((await sqliteStorageObservation(sqlite)).walBytes).toBe(0);
  });

  it('does not use a locatable attached database to invent storage authority for an in-memory main', async () => {
    const sqlite = opened(':memory:');
    sqlite.prepare('ATTACH DATABASE ? AS auxiliary').run(join(root, 'attached.sqlite'));
    sqlite.exec('CREATE TABLE auxiliary.items(id INTEGER PRIMARY KEY)');
    await expect(sqliteStorageObservation(sqlite)).rejects.toThrow(
      'SQLITE_STORAGE_LOCATION_UNCONFIRMED',
    );
  });
});
