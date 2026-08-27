import { describe, it, expect } from 'vitest';
import { EnvVarSet } from '../../src/domain/value-objects/env-var-set.vo';
import { mergeEnv } from '../../src/domain/services/env-merge.domain-service';

/** `EnvMergeService` — three layers, later wins (23 §9.5, P21-4 §10.3). */
const image = EnvVarSet.create([
  { key: 'LOG_LEVEL', value: 'info' },
  { key: 'ONLY_IMAGE', value: 'i' },
]);
const project = EnvVarSet.create([
  { key: 'LOG_LEVEL', value: 'debug' },
  { key: 'ONLY_PROJECT', value: 'p' },
]);
const task = EnvVarSet.create([{ key: 'LOG_LEVEL', value: 'trace' }]);

describe('mergeEnv', () => {
  it('lets the later layer win and labels the winner with ITS source', () => {
    const merged = mergeEnv(image, project, task);
    const byKey = new Map(merged.map((e) => [e.key, e]));
    expect(byKey.get('LOG_LEVEL')).toMatchObject({ value: 'trace', source: 'task' });
    expect(byKey.get('ONLY_IMAGE')).toMatchObject({ value: 'i', source: 'image' });
    expect(byKey.get('ONLY_PROJECT')).toMatchObject({ value: 'p', source: 'project' });
  });

  it('marks the survivor `overridden` only when it really replaced something', () => {
    // ⚠️ THE MUTATION THIS CATCHES is `overridden: true` for everything the last layer
    // sets. The badge means 「this replaced a lower layer」; setting it on a variable
    // that only ever existed once tells the user a lower layer they never wrote is
    // being ignored.
    const merged = mergeEnv(image, project, task);
    const byKey = new Map(merged.map((e) => [e.key, e]));
    expect(byKey.get('LOG_LEVEL')?.overridden).toBe(true);
    expect(byKey.get('ONLY_IMAGE')?.overridden).toBe(false);
    expect(byKey.get('ONLY_PROJECT')?.overridden).toBe(false);
  });

  it('is a pure function — it does not touch its inputs', () => {
    const before = JSON.stringify([image.entries, project.entries, task.entries]);
    mergeEnv(image, project, task);
    expect(JSON.stringify([image.entries, project.entries, task.entries])).toBe(before);
  });

  it('knows nothing about credentials — 「凭证永远赢」 is ORDER, not a blacklist', () => {
    // Credential env is written by the application layer ON TOP of this result
    // (05 §4.1). Teaching the merge about credential names would put a credential
    // concern in the image domain and give the platform two half-decisions.
    const withCredName = EnvVarSet.create([{ key: 'MY_TOKEN', value: 'from-image' }]);
    const merged = mergeEnv(withCredName, EnvVarSet.empty(), EnvVarSet.empty());
    expect(merged).toEqual([
      { key: 'MY_TOKEN', value: 'from-image', source: 'image', overridden: false },
    ]);
  });
});
