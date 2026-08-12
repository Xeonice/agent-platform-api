/**
 * UnitOfWork — SYNCHRONOUS transaction boundary (docs/backend P0-2 / 24 R-1 / 28 §7.3).
 *
 * `run` takes a NON-async callback `(tx: Tx) => T` and returns `T` synchronously.
 * Repository writes inside a transaction are `saveSync(tx, agg): void` (return `void`,
 * not `Promise<void>`) so the type system forbids `await` inside the critical section.
 */

/**
 * Opaque transaction token. The brand symbol is module-private and there is NO
 * public factory — the ONLY way to obtain a `Tx` is to be handed one inside
 * `UnitOfWork.run`. Therefore "holding a Tx" provably means "currently inside a
 * synchronous transaction" (P2-1): it cannot be forged by callers.
 */
const TX_BRAND = Symbol('Tx');
export interface Tx {
  readonly [TX_BRAND]: true;
}

export interface UnitOfWork {
  run<T>(fn: (tx: Tx) => T): T;
}

/**
 * Base class that OWNS Tx minting. Concrete adapters (e.g. SqliteUnitOfWork)
 * implement only `runInTransaction` — the primitive "execute this synchronously
 * inside a real transaction". They never see the brand and cannot mint a Tx
 * themselves; `run` injects a fresh token per transaction.
 */
export abstract class UnitOfWorkBase implements UnitOfWork {
  private static mint(): Tx {
    return { [TX_BRAND]: true };
  }

  run<T>(fn: (tx: Tx) => T): T {
    return this.runInTransaction(() => fn(UnitOfWorkBase.mint()));
  }

  protected abstract runInTransaction<T>(work: () => T): T;
}

export const UNIT_OF_WORK = Symbol('UnitOfWork');
