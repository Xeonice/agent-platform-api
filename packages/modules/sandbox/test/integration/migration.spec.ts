import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';

/**
 * Migration test (docs/backend/25): the committed drizzle migrations apply cleanly
 * and create the expected tables with their CHECK constraints.
 */
describe('drizzle sqlite migrations', () => {
  it('applies and creates the sandbox tables', () => {
    const sqlite = new Database(':memory:');
    const db = drizzle(sqlite);
    migrate(db, { migrationsFolder: resolve(process.cwd(), 'drizzle') });

    const tables = sqlite
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
      .all()
      .map((r) => (r as { name: string }).name);

    expect(tables).toContain('sandboxes');
    expect(tables).toContain('sandbox_state_transitions');
  });
});

/**
 * The 0007 rebuild against a NON-EMPTY database (S5).
 *
 * SQLite cannot add a CHECK-carrying column, so drizzle-kit rewrites `sandboxes`
 * whole — and it generates the copy statement selecting the NEW column list from the
 * OLD table, which fails with `no such column: name` the moment a row exists. The
 * committed 0007 is hand-edited to select those columns as NULL instead. An
 * empty-database migration test CANNOT catch that regression, so this one seeds a row
 * with the pre-S5 column set first and only then applies the S5 migrations.
 */
describe('drizzle migrations survive a NON-EMPTY sandboxes table (0007 rebuild)', () => {
  const PRE_S5 = '0006';

  function applyUpTo(sqlite: Database.Database, lastPrefix: string | null): string[] {
    const dir = resolve(process.cwd(), 'drizzle');
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    const applied: string[] = [];
    for (const file of files) {
      if (lastPrefix !== null && file.slice(0, 4) > lastPrefix) continue;
      if (lastPrefix === null && file.slice(0, 4) <= PRE_S5) continue;
      for (const stmt of readFileSync(resolve(dir, file), 'utf8').split(
        '--> statement-breakpoint',
      )) {
        if (stmt.trim()) sqlite.exec(stmt);
      }
      applied.push(file);
    }
    return applied;
  }

  it('copies an existing row through the rebuild, leaving the new columns NULL', () => {
    const sqlite = new Database(':memory:');
    applyUpTo(sqlite, PRE_S5); // the schema as it stood BEFORE S5

    sqlite
      .prepare(
        `INSERT INTO sandboxes (id, project_id, runtime, provider, status, headless,
           timeout_minutes, idle_timeout_sec, version, created_at, updated_at)
         VALUES ('sbx-legacy', 'prj-1', 'codex', 'aio', 'running', 0, NULL, 1800, 0, 1, 1)`,
      )
      .run();

    // …now the S5 migrations. Without the hand-edit this throws `no such column: name`.
    expect(() => applyUpTo(sqlite, null)).not.toThrow();

    const row = sqlite.prepare('SELECT * FROM sandboxes WHERE id = ?').get('sbx-legacy') as Record<
      string,
      unknown
    >;
    // the pre-existing row survived intact…
    expect(row.project_id).toBe('prj-1');
    expect(row.status).toBe('running');
    // …and the S5 columns are NULL, which is their correct value for a pre-S5 sandbox.
    for (const col of [
      'name',
      'image_ref',
      'initial_prompt',
      'initial_prompt_consumed_at',
      'failure_code',
      'failure_reason',
    ]) {
      expect(row[col], `${col} should be NULL on a legacy row`).toBeNull();
    }
  });
});
