import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { fromEpochMs } from '@platform/shared-kernel';
import {
  coordinatorWriterControl,
  fenceCoordinatorConnection,
} from '../../../apps/api/src/platform/persistence/coordinator-lease';
import { withBusinessWriterEpoch } from '../../../apps/api/src/platform/persistence/business-writer-context';
import { deferred, useEnv } from '../../support/strict-ports';
const cleanup: (() => void)[] = [];
afterEach(() =>
  cleanup
    .splice(0)
    .reverse()
    .forEach((fn) => fn()),
);
describe('REQ-UPG-006/007 — actual SQLite single writer and retained operation epoch', () => {
  it('rechecks the writer after BEGIN when a second real connection transfers it between admission and transaction', () => {
    const dir = mkdtempSync(join(tmpdir(), 'upg-writer-begin-race-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const filename = join(dir, 'state.db'),
      rawA = new Database(filename),
      rawB = new Database(filename);
    cleanup.push(
      () => rawB.close(),
      () => rawA.close(),
    );
    cleanup.push(
      useEnv({ COORDINATOR_GENERATION: undefined, COORDINATOR_WRITER_FENCE_VALID: undefined }),
    );
    rawA.exec('CREATE TABLE app_effects(value TEXT)');
    let armed = false;
    const database = new Proxy(rawA, {
      get(target, property): unknown {
        if (property === 'transaction')
          return (work: (...args: unknown[]) => unknown) => {
            const transaction = target.transaction(work);
            return Object.assign((...args: unknown[]) => transaction(...args), {
              immediate: (...args: unknown[]) => {
                if (armed) {
                  armed = false;
                  rawB
                    .prepare(
                      "UPDATE platform_role_leases SET holder_id='second-connection',generation=generation+1,fence=fence+1 WHERE role='state-coordinator'",
                    )
                    .run();
                }
                return transaction.immediate(...args);
              },
              deferred: transaction.deferred,
              exclusive: transaction.exclusive,
            });
          };
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const writer = fenceCoordinatorConnection(
      database,
      'writer-begin-race',
      { now: () => fromEpochMs(1791763200000) },
      { next: randomUUID },
    );
    armed = true;
    expect(() => writer.prepare("INSERT INTO app_effects VALUES('stale-writer')").run()).toThrow(
      'COORDINATOR_WRITER_FENCE_EXPIRED',
    );
    expect(rawB.prepare('SELECT count(*) n FROM app_effects').get()).toEqual({ n: 0 });
  });
  it('rejects a late original async operation after A→B→the same retained A, while fresh A operations can write', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'upg-writer-epoch-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const filename = join(dir, 'state.db'),
      rawA = new Database(filename),
      rawB = new Database(filename);
    cleanup.push(
      () => rawB.close(),
      () => rawA.close(),
    );
    cleanup.push(
      useEnv({ COORDINATOR_GENERATION: undefined, COORDINATOR_WRITER_FENCE_VALID: undefined }),
    );
    rawA.exec('CREATE TABLE app_effects(id TEXT PRIMARY KEY, value TEXT)');
    const clock = { now: () => fromEpochMs(1791763200000) },
      ids = { next: () => randomUUID() };
    const a = fenceCoordinatorConnection(rawA, 'actual-writer-test', clock, ids),
      aControl = coordinatorWriterControl(a);
    const gate = deferred<void>();
    const old = withBusinessWriterEpoch(
      { instanceId: 'actual-writer-test', generation: aControl.generation, fence: aControl.fence },
      async () => {
        await gate.promise;
        a.prepare('INSERT INTO app_effects VALUES(?,?)').run('late-original', 'old');
      },
    );
    aControl.release();
    const b = fenceCoordinatorConnection(rawB, 'actual-writer-test', clock, ids),
      bControl = coordinatorWriterControl(b);
    b.prepare('INSERT INTO app_effects VALUES(?,?)').run('new-writer', 'new');
    bControl.release();
    aControl.reacquire();
    const failure = expect(old).rejects.toThrow('COORDINATOR_OPERATION_EPOCH_SUPERSEDED');
    gate.resolve();
    await failure;
    withBusinessWriterEpoch(
      { instanceId: 'actual-writer-test', generation: aControl.generation, fence: aControl.fence },
      () => a.prepare('INSERT INTO app_effects VALUES(?,?)').run('fresh-retained', 'fresh'),
    );
    expect(a.prepare('SELECT id,value FROM app_effects ORDER BY id').all()).toEqual([
      { id: 'fresh-retained', value: 'fresh' },
      { id: 'new-writer', value: 'new' },
    ]);
    expect(aControl.generation).toBe(3);
    expect(() =>
      a.prepare("INSERT INTO app_effects VALUES('lazy','bad') RETURNING id").iterate(),
    ).toThrow('MUTATING_ITERATOR_NOT_SUPPORTED');
    expect(a.prepare('SELECT count(*) n FROM app_effects').get()).toEqual({ n: 2 });
    aControl.release();
  });
});
