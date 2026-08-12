import type { Tx } from '../types/branded';

/**
 * UnitOfWork — SYNCHRONOUS transaction boundary (docs/backend P0-2 / 24 R-1 / 28 §7.3).
 *
 * `run` takes a NON-async callback `(tx: Tx) => T` and returns `T` synchronously.
 * Repository writes inside a transaction are `saveSync(tx, agg): void` (return `void`,
 * not `Promise<void>`) so the type system forbids `await` inside the critical section.
 * This matches better-sqlite3's synchronous transaction semantics and removes a whole
 * class of "half-committed across an await" bugs.
 */
export interface UnitOfWork {
  run<T>(fn: (tx: Tx) => T): T;
}

export const UNIT_OF_WORK = Symbol('UnitOfWork');
