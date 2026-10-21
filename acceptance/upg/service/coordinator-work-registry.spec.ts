import { describe, expect, it } from 'vitest';
import { CoordinatorWorkRegistry } from '../../../packages/shared-kernel/src/ports/coordinator-work-registry';

function gate() {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe('Coordinator actual worker retirement registry', () => {
  it('restores the actual count when a generator factory throws synchronously', async () => {
    const registry = new CoordinatorWorkRegistry(),
      worker = registry.register('test.generator');
    registry.seal(['test.generator']);
    const iterator = worker.iterate(() => {
      throw new Error('FIXTURE_ITERATOR_FACTORY_FAILURE');
    });
    await expect(iterator.next()).rejects.toThrow('FIXTURE_ITERATOR_FACTORY_FAILURE');
    expect(registry.snapshot().active).toBe(0);
    await registry.stop();
    expect(registry.snapshot().state).toBe('drained');
  });
  it('keeps coverage unknown during a real prepared adoption lifecycle and refuses transitions after retirement', async () => {
    const registry = new CoordinatorWorkRegistry();
    registry.register('test.prepared');
    registry.seal(['test.prepared']);
    registry.beginLifecycleTransition();
    expect(registry.snapshot()).toMatchObject({
      sealed: false,
      coverageComplete: false,
      state: 'starting',
    });
    registry.register('test.real-writer');
    registry.seal(['test.prepared', 'test.real-writer']);
    expect(registry.snapshot().coverageComplete).toBe(true);
    await registry.stop();
    expect(() => registry.beginLifecycleTransition()).toThrow(
      'Coordinator worker admission closed',
    );
  });
  it('keeps the original async job referenced after stopping timers and until its Promise settles', async () => {
    const registry = new CoordinatorWorkRegistry(),
      worker = registry.register('test.loop');
    registry.seal(['test.loop']);
    const entered = gate(),
      finish = gate();
    worker.interval(1, async () => {
      entered.release();
      await finish.promise;
    });
    await entered.promise;
    const stopping = registry.stop();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(registry.snapshot()).toMatchObject({
      state: 'draining',
      active: 1,
      queued: 0,
      coverageComplete: true,
    });
    await expect(worker.run(async () => undefined)).rejects.toMatchObject({
      code: 'COORDINATOR_WORKER_DRAINING',
    });
    finish.release();
    await stopping;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(registry.snapshot()).toMatchObject({ state: 'drained', active: 0, queued: 0 });
  });
  it('waits for actual asynchronous stop work and never derives zero from a close signal', async () => {
    const finish = gate(),
      registry = new CoordinatorWorkRegistry();
    registry.register('test.stop', () => finish.promise);
    registry.seal(['test.stop']);
    const stopping = registry.stop();
    expect(registry.snapshot()).toMatchObject({ state: 'draining', stopPending: 1 });
    finish.release();
    await stopping;
    expect(registry.snapshot()).toMatchObject({ state: 'drained', stopPending: 0 });
  });
  it('tracks nested continuations but rejects a detached stale context after its parent has settled', async () => {
    const registry = new CoordinatorWorkRegistry(),
      worker = registry.register('test.nested');
    registry.seal(['test.nested']);
    const finish = gate(),
      entered = gate();
    let late: Promise<unknown> = Promise.resolve();
    const task = worker.run(async () => {
      entered.release();
      await finish.promise;
      return worker.run(async () => 42);
    });
    await entered.promise;
    const stopping = registry.stop();
    finish.release();
    expect(await task).toBe(42);
    await stopping;
    const other = new CoordinatorWorkRegistry(),
      detached = other.register('test.detached');
    other.seal(['test.detached']);
    await detached.run(async () => {
      late = new Promise((resolve) =>
        setImmediate(() => resolve(detached.run(async () => 1).catch((error) => error))),
      );
    });
    await other.stop();
    expect(await late).toMatchObject({ code: 'COORDINATOR_WORKER_DRAINING' });
    expect(registry.snapshot()).toMatchObject({ state: 'drained', active: 0 });
  });
  it('cancels queued ticks before start without pretending a running retry has ended', async () => {
    const registry = new CoordinatorWorkRegistry(),
      worker = registry.register('test.retry');
    registry.seal(['test.retry']);
    let calls = 0;
    worker.timeout(10000, async () => {
      calls++;
    });
    expect(registry.snapshot().queued).toBe(1);
    await registry.stop();
    expect(calls).toBe(0);
    expect(registry.snapshot()).toMatchObject({ state: 'drained', queued: 0 });
  });
  it('keeps missing, extra, duplicate, late or failed-stop coverage unknown', async () => {
    const missing = new CoordinatorWorkRegistry();
    missing.register('test.one');
    missing.seal(['test.one', 'test.two']);
    await missing.stop();
    expect(missing.snapshot()).toMatchObject({ state: 'unknown', coverageComplete: false });
    const extra = new CoordinatorWorkRegistry();
    extra.register('test.one');
    extra.seal([]);
    expect(extra.snapshot().state).toBe('unknown');
    const duplicate = new CoordinatorWorkRegistry();
    duplicate.register('test.one');
    expect(() => duplicate.register('test.one')).toThrow('COORDINATOR_WORKER_REGISTRATION_INVALID');
    duplicate.seal(['test.one']);
    expect(duplicate.snapshot().coverageComplete).toBe(false);
    const late = new CoordinatorWorkRegistry();
    late.seal([]);
    expect(() => late.register('test.late')).toThrow('COORDINATOR_WORKER_REGISTRATION_INVALID');
    const failed = new CoordinatorWorkRegistry();
    failed.register('test.failure', () => {
      throw new Error('synthetic');
    });
    failed.seal(['test.failure']);
    await failed.stop();
    expect(failed.snapshot()).toMatchObject({ state: 'unknown', stopFailures: 1 });
  });
});
