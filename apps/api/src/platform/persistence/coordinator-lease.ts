import { isRecord } from '@platform/shared-kernel';
import type Database from 'better-sqlite3';
import type { Clock, IdGenerator } from '@platform/shared-kernel';
import { UpgradeError } from '../upgrade/upgrade-trust';
import { finishBusinessTransaction } from './business-transaction-hooks';
import { currentBusinessWriterEpoch, withBusinessWriterEpoch } from './business-writer-context';
import {
  assertRecoveryBusinessAdmission,
  withoutUpgradeRecovery,
} from './upgrade-recovery-context';
import { assertContractBusinessAdmission } from './upgrade-contract-context';
import { assertBusinessActionMutation } from '../upgrade/upgrade-business-action';
export const COORDINATOR_WRITER_CONTROL = Symbol('CoordinatorWriterControl');
export interface CoordinatorWriterControl {
  readonly instanceId: string;
  assert(): void;
  release(): void;
  reacquire(): number;
  generation: number;
  fence: number;
}
function assertWriterControl(value: unknown): asserts value is CoordinatorWriterControl {
  if (
    !isRecord(value) ||
    typeof value.instanceId !== 'string' ||
    typeof value.generation !== 'number' ||
    !Number.isSafeInteger(value.generation) ||
    value.generation < 1 ||
    typeof value.fence !== 'number' ||
    !Number.isSafeInteger(value.fence) ||
    value.fence < 1 ||
    typeof value.assert !== 'function' ||
    typeof value.release !== 'function' ||
    typeof value.reacquire !== 'function'
  )
    throw new UpgradeError('COORDINATOR_WRITER_CONTROL_REQUIRED');
}
/** Capture one actual admitted application epoch, not the process ENV label.
 * The legacy application mode has no role control; production role assembly
 * must provide it and fails closed if it is absent. */
export function withCoordinatorBusinessEpoch<T>(sqlite: Database.Database, work: () => T): T {
  const actual: unknown = Reflect.get(sqlite, COORDINATOR_WRITER_CONTROL);
  if (!actual || typeof actual !== 'object') {
    if (['coordinator', 'coordinator-prepared'].includes(process.env.PLATFORM_PROCESS_ROLE ?? ''))
      throw new UpgradeError('COORDINATOR_WRITER_CONTROL_REQUIRED');
    return work();
  }
  assertWriterControl(actual);
  const control = actual;
  control.assert();
  return withBusinessWriterEpoch(
    { instanceId: control.instanceId, generation: control.generation, fence: control.fence },
    work,
  );
}
export function coordinatorWriterControl(sqlite: Database.Database): CoordinatorWriterControl {
  const control: unknown = Reflect.get(sqlite, COORDINATOR_WRITER_CONTROL);
  if (!control || typeof control !== 'object')
    throw new UpgradeError('COORDINATOR_WRITER_CONTROL_REQUIRED');
  assertWriterControl(control);
  return control;
}

/** One durable business-writer epoch; checks guard every actual mutating statement. */
export function fenceCoordinatorConnection(
  sqlite: Database.Database,
  instanceId: string,
  clock: Clock,
  ids: IdGenerator,
): Database.Database {
  const priorSchema = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE name='platform_role_leases'")
    .get();
  const legacySchema = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE name='sandboxes'")
    .get();
  if (!priorSchema && legacySchema) {
    // A pre-bridge binary has no writer fencing. Never presume an idle snapshot
    // proves that it stopped owning the DB or its VM home.
    throw new UpgradeError('LEGACY_WRITER_HANDOFF_REQUIRED');
  }
  sqlite.exec(
    'CREATE TABLE IF NOT EXISTS platform_role_leases(role TEXT PRIMARY KEY NOT NULL,instance_id TEXT NOT NULL,holder_id TEXT NOT NULL,generation INTEGER NOT NULL,fence INTEGER NOT NULL,expires_at INTEGER NOT NULL)',
  );
  interface Lease {
    instance_id: string;
    holder_id: string;
    generation: number;
    fence: number;
    expires_at: number;
  }
  const read = sqlite.prepare<unknown[], Lease>(
    "SELECT * FROM platform_role_leases WHERE role='state-coordinator'",
  );
  const holder = ids.next();
  const lease = sqlite
    .transaction(() => {
      const previous = read.get();
      const now = clock.now().getTime();
      if (previous && (previous.instance_id !== instanceId || previous.expires_at > now))
        throw new UpgradeError('COORDINATOR_WRITER_ALREADY_ACTIVE');
      const generation = (previous?.generation ?? 0) + 1,
        fence = (previous?.fence ?? 0) + 1;
      sqlite
        .prepare(
          "INSERT INTO platform_role_leases(role,instance_id,holder_id,generation,fence,expires_at) VALUES('state-coordinator',?,?,?,?,?) ON CONFLICT(role) DO UPDATE SET instance_id=excluded.instance_id,holder_id=excluded.holder_id,generation=excluded.generation,fence=excluded.fence,expires_at=excluded.expires_at",
        )
        .run(instanceId, holder, generation, fence, now + 30_000);
      return { generation, fence };
    })
    .immediate();
  process.env.COORDINATOR_GENERATION = String(lease.generation);
  process.env.COORDINATOR_WRITER_FENCE_VALID = 'true';
  const assertWriter = (): void => {
    const admitted = currentBusinessWriterEpoch();
    if (
      admitted &&
      (admitted.instanceId !== instanceId ||
        admitted.generation !== lease.generation ||
        admitted.fence !== lease.fence)
    )
      throw new UpgradeError('COORDINATOR_OPERATION_EPOCH_SUPERSEDED');
    const current = read.get();
    if (
      current?.instance_id !== instanceId ||
      current.holder_id !== holder ||
      current.generation !== lease.generation ||
      current.fence !== lease.fence ||
      current.expires_at <= clock.now().getTime()
    ) {
      process.env.COORDINATOR_WRITER_FENCE_VALID = 'false';
      throw new UpgradeError('COORDINATOR_WRITER_FENCE_EXPIRED');
    }
  };
  const assertMutation = (): void => {
    assertBusinessActionMutation();
    assertRecoveryBusinessAdmission(sqlite);
    assertContractBusinessAdmission(sqlite);
    assertWriter();
  };
  let renewal: ReturnType<typeof setInterval>;
  const renew = () => {
    try {
      sqlite
        .transaction(() => {
          assertWriter();
          sqlite
            .prepare(
              "UPDATE platform_role_leases SET expires_at=? WHERE role='state-coordinator' AND holder_id=? AND generation=? AND fence=?",
            )
            .run(clock.now().getTime() + 30_000, holder, lease.generation, lease.fence);
        })
        .immediate();
    } catch {
      process.env.COORDINATOR_WRITER_FENCE_VALID = 'false';
      clearInterval(renewal);
    }
  };
  const startRenewal = () => {
    renewal = withoutUpgradeRecovery(() => setInterval(renew, 5000));
    renewal.unref();
  };
  startRenewal();
  const wrap = (statement: Database.Statement): Database.Statement =>
    new Proxy(statement, {
      get(target, property): unknown {
        const value: unknown = Reflect.get(target, property, target);
        if (typeof value !== 'function') return value;
        return (...args: unknown[]): unknown => {
          if (['run', 'get', 'all', 'iterate'].includes(String(property)) && !target.readonly) {
            assertMutation();
            // A lazy mutating iterator could execute its first SQLite step only
            // after this writer released its epoch. Business writes use bounded
            // run/get/all transactions, never a deferred write capability.
            if (property === 'iterate') throw new UpgradeError('MUTATING_ITERATOR_NOT_SUPPORTED');
            if (!sqlite.inTransaction && property !== 'iterate')
              return sqlite
                .transaction(() => {
                  // BEGIN may wait behind a lease transfer on another connection.
                  // Check again after acquiring the transaction, before the write.
                  assertMutation();
                  const result: unknown = Reflect.apply(value, target, args);
                  finishBusinessTransaction(proxy);
                  return result;
                })
                .immediate();
          }
          return Reflect.apply(value, target, args);
        };
      },
    });
  const proxy = new Proxy(sqlite, {
    get(target, property): unknown {
      if (property === COORDINATOR_WRITER_CONTROL)
        return {
          instanceId,
          get generation() {
            return lease.generation;
          },
          get fence() {
            return lease.fence;
          },
          assert: assertWriter,
          reacquire: () => {
            const next = sqlite
              .transaction(() => {
                assertRecoveryBusinessAdmission(sqlite);
                assertContractBusinessAdmission(sqlite);
                const previous = read.get();
                if (
                  previous?.instance_id !== instanceId ||
                  previous.expires_at > clock.now().getTime()
                )
                  throw new UpgradeError('COORDINATOR_WRITER_ALREADY_ACTIVE');
                const generation = previous.generation + 1,
                  fence = previous.fence + 1;
                sqlite
                  .prepare(
                    "UPDATE platform_role_leases SET holder_id=?,generation=?,fence=?,expires_at=? WHERE role='state-coordinator'",
                  )
                  .run(holder, generation, fence, clock.now().getTime() + 30_000);
                return { generation, fence };
              })
              .immediate();
            lease.generation = next.generation;
            lease.fence = next.fence;
            process.env.COORDINATOR_GENERATION = String(next.generation);
            process.env.COORDINATOR_WRITER_FENCE_VALID = 'true';
            clearInterval(renewal);
            startRenewal();
            return next.generation;
          },
          release: () => {
            assertMutation();
            sqlite
              .prepare(
                "UPDATE platform_role_leases SET expires_at=0 WHERE role='state-coordinator' AND holder_id=? AND generation=? AND fence=?",
              )
              .run(holder, lease.generation, lease.fence);
            process.env.COORDINATOR_WRITER_FENCE_VALID = 'false';
            clearInterval(renewal);
          },
        } satisfies CoordinatorWriterControl;
      if (property === 'prepare') return (source: string) => wrap(target.prepare(source));
      if (property === 'transaction')
        return (work: (...args: unknown[]) => unknown) => {
          const guarded = (...args: unknown[]) => {
            assertMutation();
            const result: unknown = work(...args);
            finishBusinessTransaction(proxy);
            return result;
          };
          return target.transaction(guarded);
        };
      if (property === 'exec')
        return (source: string) => {
          assertMutation();
          if (target.inTransaction) return target.exec(source);
          return target
            .transaction(() => {
              assertMutation();
              const result = target.exec(source);
              finishBusinessTransaction(proxy);
              return result;
            })
            .immediate();
        };
      if (property === 'close')
        return () => {
          process.env.COORDINATOR_WRITER_FENCE_VALID = 'false';
          clearInterval(renewal);
          try {
            sqlite
              .prepare(
                "UPDATE platform_role_leases SET expires_at=0 WHERE role='state-coordinator' AND holder_id=? AND generation=? AND fence=?",
              )
              .run(holder, lease.generation, lease.fence);
          } finally {
            return target.close();
          }
        };
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return proxy;
}
