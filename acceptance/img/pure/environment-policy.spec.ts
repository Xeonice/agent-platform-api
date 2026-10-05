import { describe, expect, it } from 'vitest';
import { EnvVarSet } from '../../../packages/modules/image/src/domain/value-objects/env-var-set.vo';
import { mergeEnv } from '../../../packages/modules/image/src/domain/services/env-merge.domain-service';

describe('image environment input and override policy', () => {
  it.each(['HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'OPENAI_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'])(
    'rejects reserved %s rather than letting image config replace credential plumbing',
    (key) => {
      expect(() => EnvVarSet.create([{ key, value: 'forbidden' }])).toThrow();
    },
  );
  it('uses UTF-8 byte limits, not displayed character count', () => {
    expect(EnvVarSet.create([{ key: 'UNICODE', value: '界'.repeat(1365) }]).size).toBe(1);
    expect(() => EnvVarSet.create([{ key: 'UNICODE', value: '界'.repeat(1366) }])).toThrow();
  });
  it('permits case-distinct POSIX keys but rejects duplicate keys and 51 entries', () => {
    expect(
      EnvVarSet.create([
        { key: 'Mode', value: 'one' },
        { key: 'MODE', value: 'two' },
      ]).size,
    ).toBe(2);
    expect(() =>
      EnvVarSet.create([
        { key: 'MODE', value: 'one' },
        { key: 'MODE', value: 'two' },
      ]),
    ).toThrow();
    expect(() =>
      EnvVarSet.create(Array.from({ length: 51 }, (_, i) => ({ key: `VAR_${i}`, value: 'x' }))),
    ).toThrow();
  });
  it('task overrides project overrides image and reports the surviving source without mutating inputs', () => {
    const image = EnvVarSet.create([
      { key: 'MODE', value: 'image' },
      { key: 'PORT', value: '3000' },
    ]);
    const project = EnvVarSet.create([{ key: 'MODE', value: 'project' }]);
    const task = EnvVarSet.create([{ key: 'MODE', value: 'task' }]);
    expect(mergeEnv(image, project, task)).toEqual([
      { key: 'MODE', value: 'task', source: 'task', overridden: true },
      { key: 'PORT', value: '3000', source: 'image', overridden: false },
    ]);
    expect(image.find('MODE')?.value).toBe('image');
    expect(project.find('MODE')?.value).toBe('project');
  });
});
