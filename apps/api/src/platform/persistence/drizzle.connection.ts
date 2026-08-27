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

/**
 * Apply all committed migrations (drizzle-orm better-sqlite3 migrator).
 *
 * ⚠️ FOREIGN KEYS ARE OFF FOR THE DURATION, AND THAT IS REQUIRED, NOT AN OPTIMISATION.
 * SQLite cannot `ALTER TABLE ... ADD CONSTRAINT`, so adding an FK (0010 puts one on
 * `sandboxes.image_ref`) means the 12-step rebuild: create `__new_x`, copy, DROP the
 * old table, rename. With enforcement ON, two things go wrong and BOTH lose data
 * silently:
 *   · `DROP TABLE sandboxes` performs an implicit `DELETE FROM`, which fires
 *     `ON DELETE CASCADE` on `agent_tasks` and `credential_sandbox_bindings` —
 *     every task history and injection ledger row would be deleted;
 *   · `ALTER TABLE __new_sandboxes RENAME TO sandboxes` REWRITES the `REFERENCES`
 *     clauses of other tables while FKs are on, so those children would end up
 *     pointing at a table name that no longer exists.
 * `PRAGMA foreign_keys` is a NO-OP inside a transaction and the migrator wraps every
 * run in `BEGIN…COMMIT`, so the toggle cannot live in the migration file (which is
 * exactly why drizzle-kit's own `PRAGMA foreign_keys=OFF;` header does nothing) — it
 * has to be here, around the call.
 *
 * `foreign_key_check` afterwards is the other half: turning enforcement off means
 * nothing verified the copied rows, so we verify them ourselves and fail LOUDLY. A
 * migration that leaves dangling references must not boot the app.
 */
export function runMigrations(db: Db, sqlite?: Database.Database): void {
  sqlite?.pragma('foreign_keys = OFF');
  try {
    migrate(db, { migrationsFolder: migrationsDir() });
  } finally {
    sqlite?.pragma('foreign_keys = ON');
  }
  if (!sqlite) return;
  const violations = sqlite.pragma('foreign_key_check') as unknown[];
  if (violations.length > 0) {
    throw new Error(
      `migrations left ${String(violations.length)} dangling foreign key reference(s): ` +
        `${JSON.stringify(violations.slice(0, 5))}`,
    );
  }
}
