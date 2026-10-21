import { describe, expect, it } from 'vitest';
import {
  UpgradeProtocolRangeSchema,
  UpgradeAccessSchema,
  UpgradeStageProgressSchema,
} from '@platform/contracts';
import {
  observeUpgradeOnce,
  withUpgradeObservation,
} from '../../../apps/api/src/platform/upgrade/upgrade-observation';

describe('response-local upgrade observation cache validates its heterogeneous boundary', () => {
  it('shares one real read while retaining the original value and its extension fields', async () => {
    const owner = {};
    const value = { min: 1, max: 1, futureEvidence: { epoch: 7 } };
    let reads = 0;
    let decoded = 0;
    const read = async () => {
      reads++;
      await Promise.resolve();
      return value;
    };
    const decode = (input: unknown): unknown => {
      UpgradeProtocolRangeSchema.parse(input);
      decoded++;
      return input;
    };
    await withUpgradeObservation(async () => {
      const values = await Promise.all([
        observeUpgradeOnce<unknown>(owner, 'same-proof', read, decode),
        observeUpgradeOnce<unknown>(owner, 'same-proof', read, decode),
      ]);
      expect(values).toEqual([value, value]);
      expect(values[0]).toBe(value);
      expect(values[1]).toBe(value);
    });
    expect(reads).toBe(1);
    expect(decoded).toBe(1);
  });

  it('rejects a cached value with the wrong shape without running a second physical read', async () => {
    const owner = {};
    let reads = 0;
    await withUpgradeObservation(async () => {
      const first = observeUpgradeOnce(
        owner,
        'same-key',
        () => {
          reads++;
          return Promise.resolve({ min: 1, max: 1 });
        },
        (input) => UpgradeProtocolRangeSchema.parse(input),
      );
      const collision = observeUpgradeOnce(
        owner,
        'same-key',
        () => {
          reads++;
          return Promise.resolve({ upgradeKey: 'must-not-run' });
        },
        (input) => UpgradeAccessSchema.parse(input),
      );
      await expect(first).resolves.toEqual({ min: 1, max: 1 });
      await expect(collision).rejects.toMatchObject({ name: 'ZodError' });
    });
    expect(reads).toBe(1);
  });

  it('keeps the original failed read rejected for both callers and starts fresh in the next scope', async () => {
    const owner = {};
    const failure = new Error('physical proof unavailable');
    let reads = 0;
    const read = (): Promise<number> => {
      reads++;
      return Promise.reject(failure);
    };
    await withUpgradeObservation(async () => {
      const results = await Promise.allSettled([
        observeUpgradeOnce(owner, 'proof', read, (input) =>
          UpgradeStageProgressSchema.shape.completedWork.parse(input),
        ),
        observeUpgradeOnce(owner, 'proof', read, (input) =>
          UpgradeStageProgressSchema.shape.completedWork.parse(input),
        ),
      ]);
      for (const result of results) {
        expect(result.status).toBe('rejected');
        if (result.status === 'rejected') expect(result.reason).toBe(failure);
      }
    });
    expect(reads).toBe(1);
    await withUpgradeObservation(async () => {
      await expect(
        observeUpgradeOnce(
          owner,
          'proof',
          () => {
            reads++;
            return Promise.resolve(2);
          },
          (input) => UpgradeStageProgressSchema.shape.completedWork.parse(input),
        ),
      ).resolves.toBe(2);
    });
    expect(reads).toBe(2);
  });
});
