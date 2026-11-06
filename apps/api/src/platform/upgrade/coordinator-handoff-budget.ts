import type { Clock } from '@platform/shared-kernel';
import { requireUpgrade, UpgradeError } from './upgrade-trust';

/** One original quiesce deadline shared by all release/adopt work. A timeout
 * bounds the caller, but retains the original Promise in its owning worker. */
export class CoordinatorHandoffBudget {
  readonly signal: AbortSignal;
  private readonly monotonicDeadline: number;
  constructor(
    readonly deadline: number,
    private readonly clock: Clock,
    private readonly retain: <T>(work: () => Promise<T>) => Promise<T>,
  ) {
    const remaining = deadline - clock.now().getTime();
    requireUpgrade(
      Number.isSafeInteger(deadline) && remaining > 0,
      'HANDOFF_CONTROL_BUDGET_EXCEEDED',
    );
    this.monotonicDeadline = performance.now() + remaining;
    this.signal = AbortSignal.timeout(Math.ceil(remaining));
  }
  assert(): void {
    requireUpgrade(
      !this.signal.aborted &&
        this.clock.now().getTime() < this.deadline &&
        performance.now() < this.monotonicDeadline,
      'HANDOFF_CONTROL_BUDGET_EXCEEDED',
    );
  }
  remaining(): number {
    this.assert();
    return Math.max(
      1,
      Math.ceil(
        Math.min(
          this.deadline - this.clock.now().getTime(),
          this.monotonicDeadline - performance.now(),
        ),
      ),
    );
  }
  async step<T>(work: () => Promise<T>): Promise<T> {
    this.assert();
    const original = this.retain(work);
    let expired: (() => void) | undefined;
    try {
      const result = await Promise.race([
        original,
        new Promise<never>((_ok, fail) => {
          expired = () => {
            fail(new UpgradeError('HANDOFF_CONTROL_BUDGET_EXCEEDED'));
          };
          this.signal.addEventListener('abort', expired, { once: true });
          if (this.signal.aborted) expired();
        }),
      ]);
      this.assert();
      return result;
    } finally {
      if (expired) this.signal.removeEventListener('abort', expired);
    }
  }
}
