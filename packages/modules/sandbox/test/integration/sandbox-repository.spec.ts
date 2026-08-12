import { resolve } from 'node:path';
import { beforeEach, describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { asProjectId, asSandboxId } from '@platform/shared-kernel';
import type { Tx, UnitOfWork } from '@platform/shared-kernel';
import { Sandbox } from '../../src/domain/entities/sandbox.entity';
import { SqliteSandboxRepository } from '../../src/infrastructure/persistence/sqlite/sandbox.repository.impl';

/**
 * Integration test (docs/backend/25): real better-sqlite3 + Drizzle + committed
 * migrations. Proves the SYNCHRONOUS UnitOfWork + saveSync path writes and reads
 * back (P0-2). No mocks of the DB.
 */
function makeHarness() {
  const sqlite = new Database(':memory:');
  const db = drizzle(sqlite) as BetterSQLite3Database<Record<string, never>>;
  migrate(db, { migrationsFolder: resolve(process.cwd(), 'drizzle') });
  const repo = new SqliteSandboxRepository(db);
  const uow: UnitOfWork = {
    run<T>(fn: (tx: Tx) => T): T {
      let result!: T;
      sqlite.transaction(() => {
        result = fn(db as unknown as Tx);
      })();
      return result;
    },
  };
  return { sqlite, db, repo, uow };
}

describe('SqliteSandboxRepository saveSync roundtrip', () => {
  const now = new Date('2026-08-12T00:00:00.000Z');
  let harness: ReturnType<typeof makeHarness>;

  beforeEach(() => {
    harness = makeHarness();
  });

  it('persists a new sandbox synchronously and reads it back', async () => {
    const sandbox = Sandbox.create({
      id: asSandboxId('sbx-int-1'),
      projectId: asProjectId('prj-int-1'),
      runtime: 'codex',
      headless: true,
      timeoutMinutes: 60,
      idleTimeoutSec: 1800,
      now,
    });

    harness.uow.run((tx) => harness.repo.saveSync(tx, sandbox));

    const loaded = await harness.repo.findById(asSandboxId('sbx-int-1'));
    expect(loaded).not.toBeNull();
    expect(loaded!.status).toBe('pending');
    expect(loaded!.runtime).toBe('codex');
    expect(loaded!.headless).toBe(true);
    expect(loaded!.timeoutMinutes).toBe(60);
    expect(loaded!.transitions).toHaveLength(1);
    expect(loaded!.transitions[0]).toMatchObject({ from: null, to: 'pending' });
  });

  it('persists a subsequent legal transition and appends history', async () => {
    const sandbox = Sandbox.create({
      id: asSandboxId('sbx-int-2'),
      projectId: asProjectId('prj-int-1'),
      runtime: 'codex',
      headless: false,
      timeoutMinutes: null,
      idleTimeoutSec: 1800,
      now,
    });
    harness.uow.run((tx) => harness.repo.saveSync(tx, sandbox));

    sandbox.transitionTo('scheduling', 'scheduler', now);
    harness.uow.run((tx) => harness.repo.saveSync(tx, sandbox));

    const loaded = await harness.repo.findById(asSandboxId('sbx-int-2'));
    expect(loaded!.status).toBe('scheduling');
    expect(loaded!.transitions.map((t) => t.to)).toEqual(['pending', 'scheduling']);

    const byProject = await harness.repo.findByProject(asProjectId('prj-int-1'));
    expect(byProject).toHaveLength(1);
  });

  it('rejects an out-of-enum status at the DB CHECK boundary', () => {
    // driving the raw insert past the aggregate proves the CHECK constraint exists
    expect(() =>
      harness.sqlite
        .prepare(
          `INSERT INTO sandboxes (id, project_id, runtime, status, headless, idle_timeout_sec, version, created_at, updated_at)
           VALUES ('x','p','codex','waiting-input',0,1800,0,0,0)`,
        )
        .run(),
    ).toThrow(/CHECK constraint failed/i);
  });
});
