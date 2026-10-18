import type Database from 'better-sqlite3';

const hooks = new WeakMap<object, () => void>();
const running = new WeakSet();
/** A single Coordinator registers its deterministic projection/outbox hook. */
export function registerBusinessTransactionHook(sqlite: Database.Database, hook: () => void): void {
  hooks.set(sqlite, hook);
}
export function finishBusinessTransaction(sqlite: Database.Database): void {
  if (running.has(sqlite)) return;
  const hook = hooks.get(sqlite);
  if (!hook) return;
  running.add(sqlite);
  try {
    hook();
  } finally {
    running.delete(sqlite);
  }
}
