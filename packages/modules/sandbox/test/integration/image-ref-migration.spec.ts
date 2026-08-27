import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';

/**
 * The `sandboxes.image_ref` SEMANTIC MIGRATION (13 §2.1 / §2.4, 0010).
 *
 * This is a BREAKING change dressed as a schema tweak: the column keeps its name and
 * its type while what it MEANS flips from 「repository coordinate」 to
 * 「`image_manifests.id`」. 04 §7 ⚠️ says the two values 「碰巧是同一个字符串」 today and
 * 「必然分叉」 the day the image slice lands — so the migration has to leave nothing
 * behind that would still read as the old meaning.
 *
 * It also has to leave everything ELSE alone, and that half is easy to get wrong:
 * SQLite cannot add a foreign key without rebuilding the table, and a rebuild with FK
 * enforcement ON silently CASCADE-deletes `agent_tasks` and
 * `credential_sandbox_bindings` through the implicit DELETE inside `DROP TABLE`.
 */
const DRIZZLE = resolve(process.cwd(), 'drizzle');
const FILES = readdirSync(DRIZZLE)
  .filter((f) => f.endsWith('.sql'))
  .sort();

function apply(db: Database.Database, file: string): void {
  const text = readFileSync(resolve(DRIZZLE, file), 'utf8');
  db.exec('BEGIN');
  for (const stmt of text.split('--> statement-breakpoint')) {
    const q = stmt.trim();
    if (q) db.exec(q);
  }
  db.exec('COMMIT');
}

/** Everything up to (but not including) the image migration = 「the old world」. */
function legacyDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  for (const f of FILES.filter((f) => f < '0010')) apply(db, f);
  return db;
}

function seedLegacy(db: Database.Database): void {
  db.prepare(
    `INSERT INTO sandboxes (id, project_id, runtime, image_ref, headless, created_at, updated_at)
     VALUES ('sbx-old','prj-1','codex','alpine:3.20',0,1,1)`,
  ).run();
  db.prepare(
    `INSERT INTO agent_tasks (id, sandbox_id, runtime, job_handle, log_path, timeout_ms, started_at)
     VALUES ('task-old','sbx-old','codex','{}','/tmp/x',1800000,1)`,
  ).run();
  db.prepare(
    `INSERT INTO credentials (id, kind, runtime_id, masked_identifier, encryption_key_id,
       obtained_via, mode, issued_at)
     VALUES ('cred-1','runtime','codex','sk-…ab12','k1','api-key','api-key',1)`,
  ).run();
  db.prepare(
    `INSERT INTO credential_sandbox_bindings (id, credential_id, sandbox_id, injected_at)
     VALUES ('csb-1','cred-1','sbx-old',1)`,
  ).run();
}

describe('0010 turns image_ref into a foreign key without eating the history', () => {
  it('the legacy row keeps existing, with its now-meaningless coordinate cleared', () => {
    const db = legacyDb();
    seedLegacy(db);
    expect(db.prepare('SELECT image_ref FROM sandboxes').get()).toEqual({
      image_ref: 'alpine:3.20',
    });

    db.pragma('foreign_keys = OFF');
    apply(db, '0010_cuddly_screwball.sql');
    db.pragma('foreign_keys = ON');

    // ⚠️ NULL, NOT THE OLD STRING. Leaving `alpine:3.20` there would mean the column
    // holds a coordinate in some rows and a manifest id in others, and NOTHING would
    // tell the two apart at read time — 「同一个列名，在两个阶段指的是两个东西」 with
    // both阶段 alive at once. It also could not satisfy the FK.
    expect(db.prepare('SELECT id, image_ref FROM sandboxes').all()).toEqual([
      { id: 'sbx-old', image_ref: null },
    ]);
  });

  it('does NOT cascade-delete the sandbox’s children during the table rebuild', () => {
    // ⚠️ THIS IS THE ONE THAT WOULD HAVE LOST DATA SILENTLY. `DROP TABLE sandboxes`
    // with `foreign_keys=ON` performs an implicit `DELETE FROM`, firing every
    // `ON DELETE CASCADE` pointing at it. Both counts below go to 0 if the pragma is
    // not turned off around the migration — and the migration still "succeeds".
    const db = legacyDb();
    seedLegacy(db);
    db.pragma('foreign_keys = OFF');
    apply(db, '0010_cuddly_screwball.sql');
    db.pragma('foreign_keys = ON');

    expect(db.prepare('SELECT count(*) AS n FROM agent_tasks').get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT count(*) AS n FROM credential_sandbox_bindings').get()).toEqual({
      n: 1,
    });
    // The children must still REFERENCE `sandboxes`, not the scratch table: renaming
    // with FKs on rewrites other tables' REFERENCES clauses to the temporary name.
    const childDdl = db.prepare("SELECT sql FROM sqlite_master WHERE name='agent_tasks'").get() as {
      sql: string;
    };
    expect(childDdl.sql).toMatch(/REFERENCES `sandboxes`/);
    expect(childDdl.sql).not.toMatch(/__new_/);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  it('re-creates every index the old table had, plus the new image_ref one', () => {
    const db = legacyDb();
    db.pragma('foreign_keys = OFF');
    apply(db, '0010_cuddly_screwball.sql');
    db.pragma('foreign_keys = ON');
    const names = (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='sandboxes' AND sql IS NOT NULL",
        )
        .all() as { name: string }[]
    ).map((r) => r.name);
    // A rebuild DROPs the table and its indexes with it; forgetting to re-create them
    // is invisible until a table scan shows up in production.
    expect(new Set(names)).toEqual(
      new Set([
        'idx_sandboxes_project_status',
        'idx_sandboxes_status',
        'idx_sandboxes_provider_handle',
        'idx_sandboxes_image_ref',
      ]),
    );
  });
});
