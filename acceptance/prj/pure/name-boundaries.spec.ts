import { describe, expect, it } from 'vitest';
import { CreateProjectSchema } from '@platform/contracts';

describe('PRJ-002 project name Unicode contract', () => {
  it.each(['a', '字', '😀'])('preserves 40 %s code points and rejects the 41st', (character) => {
    const name = character.repeat(40);
    expect(CreateProjectSchema.parse({ name, sourceType: 'empty' }).name).toBe(name);
    const rejected = CreateProjectSchema.safeParse({
      name: `${name}${character}`,
      sourceType: 'empty',
    });
    expect(rejected.success).toBe(false);
    if (!rejected.success) expect(rejected.error.issues[0]?.path).toEqual(['name']);
  });
  it('retains the required string boundary without treating a valid surrogate pair as two characters', () => {
    expect(CreateProjectSchema.safeParse({ name: '', sourceType: 'empty' }).success).toBe(false);
    expect(CreateProjectSchema.safeParse({ name: 40, sourceType: 'empty' }).success).toBe(false);
    const name = `${'😀'.repeat(20)}${'e\u0301'.repeat(10)}`;
    expect(CreateProjectSchema.parse({ name, sourceType: 'empty' }).name).toBe(name);
    expect(CreateProjectSchema.safeParse({ name: `${name}x`, sourceType: 'empty' }).success).toBe(
      false,
    );
  });
});
