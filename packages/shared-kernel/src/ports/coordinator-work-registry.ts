import { AsyncLocalStorage } from 'node:async_hooks';

type Stop = () => void | Promise<void>;
interface WorkToken {
  active: boolean;
  worker: CoordinatorWorker;
}
export interface CoordinatorWorkSnapshot {
  state: 'starting' | 'running' | 'draining' | 'drained' | 'unknown';
  sealed: boolean;
  workers: { id: string; active: number; queued: number; userQueued: number; stopped: boolean }[];
  active: number;
  queued: number;
  userQueued: number;
  stopFailures: number;
  stopPending: number;
  coverageComplete: boolean;
}

const scope = new AsyncLocalStorage<WorkToken>();
const validId = (id: string): boolean => /^[a-z][a-z0-9.-]{1,99}$/.test(id);
function closed(): Error {
  return Object.assign(new Error('Coordinator worker admission closed'), {
    code: 'COORDINATOR_WORKER_DRAINING',
    retryable: false,
  });
}

/** Tracks the original Promise, including work that survives an HTTP abort.
 * Cancellation only removes work that has not started. It never decrements a
 * running Promise or attempts to stop a sandbox/Owner process. */
export class CoordinatorWorker {
  private active = 0;
  private stopped = false;
  private stopPromise: Promise<void> | null = null;
  private readonly timers = new Map<NodeJS.Timeout, () => void>();
  private readonly intervals = new Set<NodeJS.Timeout>();
  private readonly queued = new Set<() => void>();
  private readonly immediates = new Set<NodeJS.Immediate>();
  constructor(
    readonly id: string,
    private readonly stopAdmission: Stop = () => undefined,
    private readonly changed: () => void = () => undefined,
  ) {}

  private admitted(): boolean {
    const parent = scope.getStore();
    return !this.stopped || (parent?.active === true && parent.worker === this);
  }
  async run<T>(work: () => Promise<T>): Promise<T> {
    if (!this.admitted()) throw closed();
    this.active++;
    this.changed();
    const token: WorkToken = { worker: this, active: true };
    try {
      return await scope.run(token, work);
    } finally {
      token.active = false;
      this.active--;
      this.changed();
    }
  }
  async *iterate<T>(work: () => AsyncIterable<T>): AsyncGenerator<T> {
    if (!this.admitted()) throw closed();
    this.active++;
    this.changed();
    const token: WorkToken = { worker: this, active: true };
    let iterator: AsyncIterator<T>;
    try {
      iterator = work()[Symbol.asyncIterator]();
    } catch (error) {
      token.active = false;
      this.active--;
      this.changed();
      throw error;
    }
    let complete = false;
    try {
      for (;;) {
        const item = await scope.run(token, () => iterator.next());
        if (item.done) {
          complete = true;
          return;
        }
        yield item.value;
      }
    } finally {
      try {
        if (!complete && iterator.return) await scope.run(token, () => iterator.return?.());
      } finally {
        token.active = false;
        this.active--;
        this.changed();
      }
    }
  }
  /** The callback must return all asynchronous work started by this tick. */
  interval(
    ms: number,
    work: () => Promise<unknown>,
    onError: (error: unknown) => void = () => undefined,
  ): NodeJS.Timeout {
    if (this.stopped) throw closed();
    const timer = setInterval(() => {
      void this.run(work).catch(onError);
    }, ms);
    this.timers.set(timer, () => {
      clearInterval(timer);
    });
    this.intervals.add(timer);
    return timer;
  }
  timeout(
    ms: number,
    work: () => Promise<unknown>,
    onError: (error: unknown) => void = () => undefined,
  ): NodeJS.Timeout {
    if (this.stopped) throw closed();
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      void this.run(work).catch(onError);
    }, ms);
    this.timers.set(timer, () => {
      clearTimeout(timer);
    });
    return timer;
  }
  cancel(timer: NodeJS.Timeout | null | undefined): void {
    if (timer) {
      this.timers.get(timer)?.();
      this.timers.delete(timer);
      this.intervals.delete(timer);
    }
  }
  /** Own an existing repeating timer while preserving its callback semantics. */
  ownInterval(timer: NodeJS.Timeout): NodeJS.Timeout {
    if (this.stopped) {
      clearInterval(timer);
      throw closed();
    }
    this.timers.set(timer, () => {
      clearInterval(timer);
    });
    this.intervals.add(timer);
    return timer;
  }
  /** A canceled queued callback never starts; an already started callback is
   * retained by run() until its original Promise settles. */
  queue(work: () => unknown, onError: (error: unknown) => void = () => undefined): void {
    if (this.stopped) return;
    let pending = true;
    const cancel = (): void => {
      pending = false;
    };
    this.queued.add(cancel);
    queueMicrotask(() => {
      this.queued.delete(cancel);
      if (pending)
        void this.run(async () => {
          return await work();
        }).catch(onError);
    });
  }
  immediate(
    work: () => unknown,
    onError: (error: unknown) => void = () => undefined,
  ): NodeJS.Immediate {
    if (this.stopped) throw closed();
    const handle = setImmediate(() => {
      this.immediates.delete(handle);
      void this.run(async () => {
        return await work();
      }).catch(onError);
    });
    this.immediates.add(handle);
    return handle;
  }
  snapshot(): { id: string; active: number; queued: number; userQueued: number; stopped: boolean } {
    return {
      id: this.id,
      active: this.active,
      queued: this.timers.size + this.queued.size + this.immediates.size,
      userQueued: this.timers.size - this.intervals.size + this.queued.size + this.immediates.size,
      stopped: this.stopped,
    };
  }
  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopped = true;
    for (const cancel of this.timers.values()) cancel();
    this.timers.clear();
    this.intervals.clear();
    for (const cancel of this.queued) cancel();
    this.queued.clear();
    for (const handle of this.immediates) clearImmediate(handle);
    this.immediates.clear();
    this.changed();
    this.stopPromise = Promise.resolve().then(() => this.stopAdmission());
    return this.stopPromise;
  }
}

/** Explicit manifest coverage is required. An unregistered/missing/late worker
 * keeps retirement unknown, even if all currently observed counts are zero. */
export class CoordinatorWorkRegistry {
  private readonly workers = new Map<string, CoordinatorWorker>();
  private readonly finalizers = new Set<string>();
  private readonly idleWaiters = new Set<() => void>();
  private state: CoordinatorWorkSnapshot['state'] = 'starting';
  private sealed = false;
  private coverageComplete = false;
  private stopFailures = 0;
  private stopPending = 0;
  private stopCompleted = false;
  private stopping: Promise<void> | null = null;
  invalidateCoverage(): void {
    this.state = 'unknown';
    this.coverageComplete = false;
  }
  /** A prepared role may begin its one real adoption lifecycle. Coverage is
   * unknown throughout initialization and must be sealed again after listen. */
  beginLifecycleTransition(): void {
    if (this.stopping || !['starting', 'running'].includes(this.state)) throw closed();
    this.sealed = false;
    this.coverageComplete = false;
    this.state = 'starting';
  }
  register(id: string, stopAdmission?: Stop): CoordinatorWorker {
    if (!validId(id) || this.workers.has(id) || this.sealed) {
      this.state = 'unknown';
      this.coverageComplete = false;
      throw new Error('COORDINATOR_WORKER_REGISTRATION_INVALID');
    }
    const worker = new CoordinatorWorker(id, stopAdmission, () => {
      this.notifyIdle();
    });
    this.workers.set(id, worker);
    return worker;
  }
  registerFinalizer(id: string, close: Stop): CoordinatorWorker {
    const worker = this.register(id, close);
    this.finalizers.add(id);
    return worker;
  }
  private idle(): boolean {
    return [...this.workers.values()]
      .filter((worker) => !this.finalizers.has(worker.id))
      .every((worker) => {
        const value = worker.snapshot();
        return value.stopped && value.active === 0 && value.queued === 0;
      });
  }
  private notifyIdle(): void {
    if (this.idle()) {
      for (const resolve of this.idleWaiters) resolve();
      this.idleWaiters.clear();
    }
  }
  seal(expected: readonly string[]): void {
    const unique = new Set(expected);
    this.sealed = true;
    this.coverageComplete =
      this.state !== 'unknown' &&
      unique.size === expected.length &&
      expected.every(validId) &&
      unique.size === this.workers.size &&
      [...unique].every((id) => this.workers.has(id));
    this.state = this.coverageComplete ? 'running' : 'unknown';
  }
  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    if (this.state !== 'unknown') this.state = 'draining';
    // Stop every admission synchronously before awaiting any async stop hook.
    this.stopPending = this.workers.size;
    const stops = [...this.workers.values()]
      .filter((worker) => !this.finalizers.has(worker.id))
      .map((worker) =>
        worker.stop().finally(() => {
          this.stopPending--;
        }),
      );
    this.stopping = Promise.allSettled(stops).then(async (results) => {
      if (!this.idle())
        await new Promise<void>((resolve) => {
          this.idleWaiters.add(resolve);
        });
      const final = await Promise.allSettled(
        [...this.workers.values()]
          .filter((worker) => this.finalizers.has(worker.id))
          .map((worker) =>
            worker.stop().finally(() => {
              this.stopPending--;
            }),
          ),
      );
      this.stopFailures = [...results, ...final].filter(
        (result) => result.status === 'rejected',
      ).length;
      if (this.stopFailures) this.state = 'unknown';
      this.stopCompleted = true;
    });
    return this.stopping;
  }
  snapshot(): CoordinatorWorkSnapshot {
    const workers = [...this.workers.values()]
      .map((worker) => worker.snapshot())
      .sort((a, b) => a.id.localeCompare(b.id));
    const active = workers.reduce((sum, worker) => sum + worker.active, 0);
    const queued = workers.reduce((sum, worker) => sum + worker.queued, 0);
    const userQueued = workers.reduce((sum, worker) => sum + worker.userQueued, 0);
    const drained =
      this.state === 'draining' &&
      this.stopCompleted &&
      this.stopFailures === 0 &&
      this.stopPending === 0 &&
      workers.every((worker) => worker.stopped) &&
      active === 0 &&
      queued === 0;
    return {
      state: drained ? 'drained' : this.state,
      sealed: this.sealed,
      workers,
      active,
      queued,
      userQueued,
      stopFailures: this.stopFailures,
      stopPending: this.stopPending,
      coverageComplete: this.coverageComplete,
    };
  }
}

let installed: CoordinatorWorkRegistry | null = null;
/** Called by the role composition root before constructing providers. */
export function installCoordinatorWorkRegistry(registry: CoordinatorWorkRegistry): void {
  if (installed && installed !== registry)
    throw new Error('COORDINATOR_WORKER_REGISTRY_ALREADY_INSTALLED');
  installed = registry;
}
/** Non-Coordinator roles retain their existing lifecycle; they cannot produce a
 * retirement certificate because no registry is installed in their process. */
export function coordinatorWorker(id: string, stopAdmission?: Stop): CoordinatorWorker {
  return installed?.register(id, stopAdmission) ?? new CoordinatorWorker(id, stopAdmission);
}
export function currentCoordinatorWorkRegistry(): CoordinatorWorkRegistry | null {
  return installed;
}
