import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';

/**
 * Migration test (docs/backend/25, 13 §2.5.1): the committed migration creates the
 * `credentials` table with its CHECK constraints and the two partial unique indexes.
 */
function freshDb() {
  const sqlite = new Database(':memory:');
  migrate(drizzle(sqlite), { migrationsFolder: resolve(process.cwd(), 'drizzle') });
  return sqlite;
}

const GIT_ROW = (id: string, via: string) =>
  `INSERT INTO credentials (id, kind, masked_identifier, encryption_key_id, obtained_via, allowed_hosts, issued_at)
   VALUES ('${id}','git','m','k','${via}','["github.com"]',0)`;

describe('credentials migration (13 §2.5.1)', () => {
  it('creates the table + partial unique indexes', () => {
    const db = freshDb();
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table'`)
      .all()
      .map((r) => (r as { name: string }).name);
    expect(tables).toContain('credentials');
    const idx = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='index'`)
      .all()
      .map((r) => (r as { name: string }).name);
    expect(idx).toContain('uq_cred_runtime_active');
    expect(idx).toContain('uq_cred_git_active');
  });

  it('CHECK: a git row may not carry a runtime_id (I-CRD-1)', () => {
    const db = freshDb();
    expect(() =>
      db
        .prepare(
          `INSERT INTO credentials (id, kind, runtime_id, masked_identifier, encryption_key_id, obtained_via, allowed_hosts, issued_at)
           VALUES ('x','git','rt-1','m','k','git-https-token','["h"]',0)`,
        )
        .run(),
    ).toThrow(/CHECK constraint failed/i);
  });

  it('CHECK: git-https-token requires allowed_hosts (I-CRD-8)', () => {
    const db = freshDb();
    expect(() =>
      db
        .prepare(
          `INSERT INTO credentials (id, kind, masked_identifier, encryption_key_id, obtained_via, issued_at)
           VALUES ('x','git','m','k','git-https-token',0)`,
        )
        .run(),
    ).toThrow(/CHECK constraint failed/i);
  });

  it('partial unique index: two active git creds of the same obtained_via collide (I-CRD-5)', () => {
    const db = freshDb();
    db.prepare(GIT_ROW('a', 'git-https-token')).run();
    expect(() => db.prepare(GIT_ROW('b', 'git-https-token')).run()).toThrow(
      /UNIQUE constraint failed/i,
    );
  });

  it('CHECK: revoked row must have wiped ciphertext (I-CRD-3)', () => {
    const db = freshDb();
    expect(() =>
      db
        .prepare(
          `INSERT INTO credentials (id, kind, masked_identifier, encrypted_blob, encryption_key_id, obtained_via, allowed_hosts, issued_at, revoked_at)
           VALUES ('x','git','m','still-here','k','git-https-token','["h"]',0,1)`,
        )
        .run(),
    ).toThrow(/CHECK constraint failed/i);
  });
});
