import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { ErrorEnvelopeSchema } from '../../src/errors';
import { VALIDATION_FAILED_CODE, validationFailureEnvelope } from '../../src/validation-envelope';
import { CreateSandboxSchema } from '../../src/schemas/sandbox.schema';
import { GitTestRequestSchema } from '../../src/schemas/credential.schema';

/**
 * DTO 校验失败 → 信封（04 §4 / shared/10 §6.8）。
 *
 * 本文件守两件事，第二件比第一件重要：
 *   ① 出线的是**真信封**（`code`/`message`/`retryable`），且 `message` 说得清哪个字段、
 *      违反了什么 —— 这正是这次改动的全部意义：此前用户只看得到「请求失败（HTTP 400）」。
 *   ② `details` 里**没有用户提交的值**。zod 的 issue 对象本身带 `received`（枚举/字面量/
 *      联合），而校验失败的字段最可能就是 prompt 正文或明文凭证。所以下面每一条泄漏用例都
 *      把一个**独一无二的哨兵串**塞进被拒的位置，然后对**整个信封的 JSON**做子串搜索 ——
 *      不是逐字段断言：逐字段断言只能挡住今天想得到的那几个字段。
 */
const envelopeOf = (schema: z.ZodTypeAny, input: unknown) => {
  const parsed = schema.safeParse(input);
  if (parsed.success) throw new Error('expected the schema to reject this input');
  return validationFailureEnvelope(parsed.error.issues);
};

const base = { projectId: 'prj-1', runtime: 'claude-code' };

describe('a DTO violation comes out as a real ErrorEnvelope', () => {
  it('carries code / message / retryable and validates against the envelope schema', () => {
    const envelope = envelopeOf(CreateSandboxSchema, {
      ...base,
      initialPrompt: 'x'.repeat(8001),
    });

    // The envelope contract itself — the frontend's `toApiError` demands `code` AND
    // `retryable` before it will treat a body as an envelope at all.
    expect(ErrorEnvelopeSchema.safeParse(envelope).success).toBe(true);
    expect(envelope.code).toBe(VALIDATION_FAILED_CODE);
    // 原样再发必然被同一条规则拒掉 ⇒ 每按必败的 [重试] 比没有按钮更糟（04 §4.1）。
    expect(envelope.retryable).toBe(false);
  });

  it('names the offending field and the rule it broke, in a sentence a user can act on', () => {
    const envelope = envelopeOf(CreateSandboxSchema, {
      ...base,
      initialPrompt: 'x'.repeat(8001),
    });

    // 「哪个字段」和「违反了什么」两件事都必须在这句话里 —— 少任何一半，用户都还是不知道
    // 该改什么。前端在创建语境下会把它嵌进「无法用当前配置创建：{message}。请调整配置后再试」。
    expect(envelope.message).toContain('initialPrompt');
    expect(envelope.message).toContain('8000');
    expect(envelope.message).not.toContain('Validation failed');
  });

  it('puts the per-issue list in `details`, as path + rule + expectation', () => {
    const envelope = envelopeOf(CreateSandboxSchema, {
      ...base,
      initialPrompt: 'x'.repeat(8001),
    });

    expect(envelope.details).toEqual([
      { path: 'initialPrompt', code: 'too_big', message: '长度超过上限 8000 字符' },
    ]);
  });

  it('uses dot/bracket paths for nested fields (10 §6.8 `env[3].key`)', () => {
    const envelope = envelopeOf(CreateSandboxSchema, {
      ...base,
      require: { snapshot: 'yes' },
    });
    expect(envelope.details?.[0]?.path).toBe('require.snapshot');
  });

  it('summarises the first problem and counts the rest, keeping every one in `details`', () => {
    const envelope = envelopeOf(CreateSandboxSchema, { projectId: '', runtime: '' });
    expect(envelope.details).toHaveLength(2);
    expect(envelope.message).toContain('另有 1 处');
  });

  it('says "缺少必填字段" rather than a type name when the field is simply absent', () => {
    const envelope = envelopeOf(CreateSandboxSchema, { runtime: 'claude-code' });
    expect(envelope.details?.[0]).toMatchObject({
      path: 'projectId',
      message: '缺少必填字段',
    });
  });
});

/**
 * ── 泄漏防线 ──────────────────────────────────────────────────────────────────────
 *
 * 这一组是本文件存在的主要理由。`details` 的诱惑写法是 `error.issues` 原样透出（zod 的
 * issue 结构刚好塞得进 `z.array(z.record(...))`），而那样做会把**用户提交的值**顺着错误
 * 路径搬到前端渲染、服务端日志、以及用户随手发给我们的截图里。
 *
 * 每条用例的形状都一样：把哨兵串放进一个 zod **会把它写进 issue** 的位置，然后搜整个信封。
 */
const SENTINEL = 'sk-live-DO-NOT-ECHO-9f3a1';

describe('the envelope never echoes what the user submitted', () => {
  it('drops `received` on an enum violation (zod puts the raw value in issue AND message)', () => {
    // `type` 是 `z.enum(['ssh-key','https-token'])`。用户把凭证明文填错了字段 —— 一次
    // 手滑，而 zod 的默认 message 就是 `… received 'sk-live-…'`。
    const envelope = envelopeOf(GitTestRequestSchema, {
      source: 'inline',
      type: SENTINEL,
      secret: 'whatever',
    });

    expect(JSON.stringify(envelope)).not.toContain(SENTINEL);
    // …而该说的还是说了：允许的取值来自 schema 侧，可以放心给。
    expect(envelope.details?.[0]).toMatchObject({ path: 'type', code: 'invalid_enum_value' });
    expect(envelope.message).toContain('ssh-key');
  });

  it('drops `received` on a literal-union violation (`timeoutMinutes` on the create door)', () => {
    // `TimeoutMinutesSchema` 是 `z.union([literal(30), …])`，非法值让 zod 造出 `invalid_union`,
    // 其 `unionErrors` 里每个分支都带 `received: <原始值>`。整棵子树都不能透出。
    const envelope = envelopeOf(CreateSandboxSchema, { ...base, timeoutMinutes: 133742 });

    expect(JSON.stringify(envelope)).not.toContain('133742');
    expect(envelope.details?.[0]).toMatchObject({ path: 'timeoutMinutes' });
  });

  it('drops the discriminator value the caller sent', () => {
    const envelope = envelopeOf(GitTestRequestSchema, { source: SENTINEL });

    expect(JSON.stringify(envelope)).not.toContain(SENTINEL);
    expect(envelope.message).toContain('inline');
  });

  it('never carries the prompt body, however it fails', () => {
    const envelope = envelopeOf(CreateSandboxSchema, {
      ...base,
      initialPrompt: `${SENTINEL}${'x'.repeat(8001)}`,
    });
    expect(JSON.stringify(envelope)).not.toContain(SENTINEL);
  });

  it('reports a wrong TYPE by its type name — that is not a value, and users need it', () => {
    const envelope = envelopeOf(CreateSandboxSchema, { ...base, projectId: 12345 });
    expect(envelope.details?.[0]?.message).toBe('类型应为 string，实际为 number');
    expect(JSON.stringify(envelope)).not.toContain('12345');
  });
});
