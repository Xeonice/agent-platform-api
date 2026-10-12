import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { SystemClock } from '../time/system-clock';
import { UuidIdGenerator } from '../time/uuid-id-generator';
import { createConnection, type Connection } from './drizzle.connection';
import { fenceCoordinatorConnection } from './coordinator-lease';
import { requireUpgrade } from '../upgrade/upgrade-trust';
import { finishBusinessTransaction } from './business-transaction-hooks';

/** Providers retain this connection proxy across the single-writer adoption. */
export function preparedConnection(
  filename: string,
  instanceId: string,
): { connection: Connection; activate(): number } {
  requireUpgrade(filename !== ':memory:', 'PREPARED_DATABASE_MUST_EXIST');
  let target: Database.Database = new Database(filename, { readonly: true, fileMustExist: true });
  let activated = false;
  const proxy = new Proxy(target, {
    get(_unused, property) {
      if (property === 'prepare')
        return (source: string) => {
          let current = target,
            statement = target.prepare(source);
          const configuration: { method: string; args: unknown[] }[] = [];
          const routed = new Proxy(statement, {
            get(_unusedStatement, member) {
              if (current !== target) {
                current = target;
                statement = target.prepare(source);
                for (const c of configuration)
                  Reflect.apply(
                    Reflect.get(statement, c.method) as (...args: unknown[]) => unknown,
                    statement,
                    c.args,
                  );
              }
              const value: unknown = Reflect.get(statement, member, statement);
              if (typeof value !== 'function') return value;
              return (...args: unknown[]) => {
                if (['bind', 'pluck', 'expand', 'raw', 'safeIntegers'].includes(String(member)))
                  configuration.push({ method: String(member), args });
                if (
                  ['run', 'get', 'all'].includes(String(member)) &&
                  !statement.readonly &&
                  !target.inTransaction
                )
                  return target
                    .transaction(() => {
                      const result: unknown = Reflect.apply(value, statement, args);
                      finishBusinessTransaction(proxy);
                      return result;
                    })
                    .immediate();
                const result: unknown = Reflect.apply(value, statement, args);
                return result === statement ? routed : result;
              };
            },
          });
          return routed;
        };
      if (property === 'transaction')
        return (work: (...args: unknown[]) => unknown) => {
          const guarded = (...args: unknown[]) => {
            const result: unknown = work(...args);
            finishBusinessTransaction(proxy);
            return result;
          };
          const transaction = (...args: unknown[]) => target.transaction(guarded)(...args);
          for (const mode of ['immediate', 'deferred', 'exclusive'] as const)
            Object.defineProperty(transaction, mode, {
              value: (...args: unknown[]) => target.transaction(guarded)[mode](...args),
            });
          return transaction;
        };
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function'
        ? (...args: unknown[]) => Reflect.apply(value, target, args)
        : value;
    },
  });
  return {
    connection: { sqlite: proxy, db: drizzle(proxy) },
    activate: () => {
      requireUpgrade(!activated, 'PREPARED_COORDINATOR_ALREADY_ADOPTED');
      const readonly = target;
      const writable = createConnection(filename);
      try {
        target = fenceCoordinatorConnection(
          writable.sqlite,
          instanceId,
          new SystemClock(),
          new UuidIdGenerator(),
        );
      } catch (error) {
        writable.sqlite.close();
        throw error;
      }
      activated = true;
      readonly.close();
      return Number(process.env.COORDINATOR_GENERATION);
    },
  };
}
