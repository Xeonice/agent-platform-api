import type Database from 'better-sqlite3';
import type { UnitOfWork, Tx } from '@platform/shared-kernel';
import type { Db } from './drizzle.connection';

/**
 * SYNCHRONOUS UnitOfWork over better-sqlite3 (P0-2 / 24 R-1 / 28 §7.3).
 *
 * better-sqlite3 transactions are synchronous: every statement issued on the
 * connection between BEGIN and COMMIT is part of the transaction. We therefore
 * pass the same Drizzle db (cast to the opaque `Tx`) into the callback; the
 * callback is a plain `(tx) => T` (NOT async), which — combined with the `void`
 * return of `saveSync` — makes `await` inside the critical section a type error.
 */
export class SqliteUnitOfWork implements UnitOfWork {
  constructor(
    private readonly sqlite: Database.Database,
    private readonly db: Db,
  ) {}

  run<T>(fn: (tx: Tx) => T): T {
    const txHandle = this.db as unknown as Tx;
    const runner = this.sqlite.transaction(() => fn(txHandle));
    return runner();
  }
}
