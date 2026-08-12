import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';

export type Db = BetterSQLite3Database<Record<string, never>>;

export interface Connection {
  sqlite: Database.Database;
  db: Db;
}

/** Resolve the committed migrations folder (drizzle-kit output). */
export function migrationsDir(): string {
  return process.env.MIGRATIONS_DIR ?? resolve(process.cwd(), 'drizzle');
}

/** Open a better-sqlite3 connection wrapped by Drizzle. `:memory:` for tests. */
export function createConnection(filename: string): Connection {
  if (filename !== ':memory:') {
    mkdirSync(dirname(filename), { recursive: true });
  }
  const sqlite = new Database(filename);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite);
  return { sqlite, db };
}

/** Apply all committed migrations (drizzle-orm better-sqlite3 migrator). */
export function runMigrations(db: Db): void {
  migrate(db, { migrationsFolder: migrationsDir() });
}
