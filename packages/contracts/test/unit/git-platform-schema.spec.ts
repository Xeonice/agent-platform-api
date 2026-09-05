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
    // ⚠️ 源码把它 `as z.ZodType<GitPlatform>` 了（为了让 `z.infer` 出字面量联合而不是
    //    widened string），于是**静态类型上看不见 `.options`** —— 但运行期它确实是个
    //    `ZodEnum`，`patchNestJsSwagger` 正是靠这个值产出 OpenAPI 的 enum。
    //    ⇒ 这条断言要的就是那个**运行期**事实，所以在这里把它显式取回来。
    //    ⛔ 不改源码那个 cast：它有自己的理由（见 credential.schema.ts 那段注释）。
    // ⚠️ 不打断言：`Reflect.get` 拿运行期属性，类型上就是 `unknown`，
    //    再由 `expect` 比对 —— 这是「读一个类型上看不见的运行期事实」的正当写法。
    expect(Reflect.get(GitPlatformSchema, 'options')).toEqual(EXPECTED_VALUES);
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
