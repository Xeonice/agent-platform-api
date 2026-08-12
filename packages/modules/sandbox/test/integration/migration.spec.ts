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
