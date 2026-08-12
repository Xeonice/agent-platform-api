import type Database from 'better-sqlite3';
import { UnitOfWorkBase } from '@platform/shared-kernel';

/**
 * SYNCHRONOUS UnitOfWork over better-sqlite3 (P0-2 / 24 R-1 / 28 §7.3).
 *
 * It implements ONLY the `runInTransaction` primitive; the base class owns Tx
 * minting and hands a fresh token to the callback (P2-1) — this adapter can
 * neither forge nor observe the token. better-sqlite3 transactions are
 * synchronous, so every statement issued on the connection between BEGIN and
 * COMMIT is part of the transaction.
 */
export class SqliteUnitOfWork extends UnitOfWorkBase {
  constructor(private readonly sqlite: Database.Database) {
    super();
  }

  protected runInTransaction<T>(work: () => T): T {
    return this.sqlite.transaction(work)();
  }
}
