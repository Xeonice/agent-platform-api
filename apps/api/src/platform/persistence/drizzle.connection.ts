import { resolve } from 'node:path';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
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

/**
 * `platform.db` 及其 WAL 边车必须是 **0600** —— shared/11 §1.2 一直这么写着，而实现
 * 从来没做（2026-08-30 全新 `DATA_ROOT` 实测：三个文件都是 **0644**）。
 *
 * ⚠️ **「必须」写在文档里而实现没做，是最容易被当成已完成的那一类**。这次的处置是
 * **改实现，不是改文档**：这个库与 `.master.key`（早就是 0600）放在同一个 `DATA_ROOT`
 * 里，里面装着任务历史、prompt、仓库地址与**加密后的凭证密文**。同机的其他本地用户
 * 读得到密文，就等于拿到了一份可以离线慢慢啃的材料 —— 而把钥匙锁好、把锁着的箱子
 * 摊在桌上，是一种自欺。
 *
 * ⚠️ **`-wal` / `-shm` 必须一起管**：它们装的是尚未 checkpoint 的**同一批数据**，
 * 只锁主库等于没锁。SQLite 建这两个文件时会照抄主库的权限位，所以顺序是
 * 「建库 → 先 chmod 主库 → 再开 WAL」；已经存在的（本次改动之前建出来的那批 0644）
 * 由后面两次 chmod 补上。
 *
 * ⚠️ better-sqlite3 按 umask 建文件，没有 mode 参数可给 —— 这也是它一直是 0644 的原因，
 * 与 `runtime-log-writer.ts` 里那条「`createWriteStream` 的 mode 会被 umask 削掉」同源。
 */
export function hardenDatabaseFiles(filename: string): void {
  if (filename === ':memory:') return;
  for (const p of [filename, `${filename}-wal`, `${filename}-shm`]) {
    if (existsSync(p)) chmodSync(p, 0o600);
  }
}

/** Open a better-sqlite3 connection wrapped by Drizzle. `:memory:` for tests. */
export function createConnection(filename: string): Connection {
  if (filename !== ':memory:') {
    mkdirSync(dirname(filename), { recursive: true });
  }
  const sqlite = new Database(filename);
  // ⚠️ **在开 WAL 之前**收紧主库权限：SQLite 建 `-wal`/`-shm` 时照抄主库的权限位，
  // 顺序反了那两个边车就会带着 umask 的 0644 出生（见 `hardenDatabaseFiles`）。
  hardenDatabaseFiles(filename);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  hardenDatabaseFiles(filename); // 边车此刻才存在；顺带修掉本次改动之前留下的 0644。
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
