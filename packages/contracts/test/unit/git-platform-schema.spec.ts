import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import { GIT_PLATFORM_IDS } from '@platform/shared-kernel';
import { GitPlatformSchema } from '../../src/schemas/credential.schema';

const EXPECTED_VALUES = [...GIT_PLATFORM_IDS, 'other'];

describe('GitPlatformSchema (registry-derived zod enum)', () => {
  it('accepts every registry id plus the "other" escape hatch', () => {
    for (const value of EXPECTED_VALUES) {
      expect(GitPlatformSchema.safeParse(value).success).toBe(true);
    }
  });

  it('rejects an unknown platform and the empty string', () => {
    expect(GitPlatformSchema.safeParse('bitbucket').success).toBe(false);
    expect(GitPlatformSchema.safeParse('').success).toBe(false);
    expect(GitPlatformSchema.safeParse('GitHub').success).toBe(false);
  });

  it('exposes exactly the registry ids + "other" as its runtime enum values', () => {
    expect(GitPlatformSchema.options).toEqual(EXPECTED_VALUES);
  });

  it('the emitted OpenAPI platform enum stays in lock-step with the registry', () => {
    // openapi.json is the committed drift artifact (re-emitted by `openapi:emit`).
    const doc = JSON.parse(readFileSync(resolve(process.cwd(), 'openapi.json'), 'utf8'));
    const enums: string[][] = [];
    JSON.stringify(doc, (_key, node) => {
      if (
        node &&
        typeof node === 'object' &&
        Array.isArray(node.enum) &&
        node.type === 'string' &&
        node.enum.includes('github')
      ) {
        enums.push(node.enum);
      }
      return node;
    });
    expect(enums.length).toBeGreaterThan(0);
    for (const e of enums) {
      expect(e).toEqual(EXPECTED_VALUES);
    }
  });
});
