import { describe, it, expect } from 'vitest';
import {
  InitialTask,
  INITIAL_PROMPT_MAX_LENGTH,
} from '../../src/domain/value-objects/initial-task.vo';
import { SandboxInvariantViolationError } from '../../src/domain/errors/invariant-violation.error';
import { deriveDefaultTaskName } from '../../src/domain/services/task-name.policy';

/** T-SBX-9a / 9b — the `InitialTask` value object and invariant I-SBX-10. */
describe('T-SBX-9a — InitialTask construction (I-SBX-10)', () => {
  it('accepts exactly 8000 characters and rejects 8001 (same spec as automations.prompt)', () => {
    const ok = 'x'.repeat(INITIAL_PROMPT_MAX_LENGTH);
    expect(InitialTask.create({ prompt: ok }).prompt).toHaveLength(8000);
    expect(() => InitialTask.create({ prompt: `${ok}x` })).toThrow(SandboxInvariantViolationError);
  });

  it('rejects a consumedAt with no prompt to have consumed', () => {
    expect(() => InitialTask.create({ consumedAt: new Date() })).toThrow(/I-SBX-10/);
  });

  it('treats a blank-only prompt as NO instruction', () => {
    // otherwise the platform would start an agent with whitespace and then mark the
    // instruction consumed — a task that silently did nothing.
    const t = InitialTask.create({ prompt: '   \n\t ' });
    expect(t.prompt).toBeUndefined();
    expect(t.isPending).toBe(false);
  });

  it('a stored prompt+consumedAt pair rehydrates fine', () => {
    const at = new Date('2026-08-21T10:00:00.000Z');
    const t = InitialTask.create({ prompt: 'do it', consumedAt: at });
    expect(t.consumedAt).toBe(at);
    expect(t.isPending).toBe(false);
  });
});

describe('T-SBX-9b — consume() is one-shot and irreversible (I-SBX-10)', () => {
  it('stamps consumedAt and reports the task as no longer pending', () => {
    const at = new Date('2026-08-21T10:00:00.000Z');
    const t = InitialTask.create({ prompt: 'ship it' });
    expect(t.isPending).toBe(true);
    const consumed = t.consume(at);
    expect(consumed.consumedAt).toBe(at);
    expect(consumed.isPending).toBe(false);
    // immutable: the original is untouched
    expect(t.consumedAt).toBeUndefined();
  });

  it('a SECOND consume throws — a replayed instruction is destructive', () => {
    const t = InitialTask.create({ prompt: 'ship it' }).consume(new Date());
    expect(() => t.consume(new Date())).toThrow(/already consumed/);
  });

  it('there is no way to clear consumedAt back to undefined', () => {
    const t = InitialTask.create({ prompt: 'ship it' }).consume(new Date());
    // the only mutator is consume(), and it refuses; the field is readonly otherwise.
    expect(Object.keys(t)).not.toContain('setConsumedAt');
    expect(() =>
      InitialTask.create({ prompt: 'ship it', consumedAt: null }).consume(new Date()),
    ).not.toThrow();
  });

  it('consuming a task that has no instruction at all throws', () => {
    expect(() => InitialTask.none().consume(new Date())).toThrow(/no initial instruction/);
  });
});

describe('T-SBX-9c — the default task name (P21-1 §9)', () => {
  const now = new Date('2026-08-10T14:23:45.000Z');

  it('takes the first line, capped at 20 UTF-8 CODE POINTS, with an ellipsis', () => {
    const name = deriveDefaultTaskName({
      prompt: '重构用户中心的登录与注册流程并补齐单元测试\n第二行会被忽略',
      runtimeLabel: 'Codex',
      now,
    });
    expect([...name]).toHaveLength(21); // 20 code points + '…'
    expect(name.endsWith('…')).toBe(true);
    expect(name.startsWith('重构用户中心的登录与注册流程')).toBe(true);
  });

  it('counts CJK as ONE code point each, not by display width', () => {
    // 20 CJK ideographs are exactly 20 code points (40 display columns) ⇒ no truncation
    const twenty = '一二三四五六七八九十一二三四五六七八九十';
    expect(deriveDefaultTaskName({ prompt: twenty, runtimeLabel: 'Codex', now })).toBe(twenty);
  });

  it('never splits an astral character in half', () => {
    // 19 ASCII + 2 emoji: a UTF-16 `slice(0,20)` would cut the first emoji's surrogate
    // pair and produce an unpaired surrogate; code-point iteration cannot.
    const name = deriveDefaultTaskName({
      prompt: `${'a'.repeat(19)}🎉🎉`,
      runtimeLabel: 'Codex',
      now,
    });
    expect([...name]).toHaveLength(21);
    expect(name).toBe(`${'a'.repeat(19)}🎉…`);
    expect(/[\uD800-\uDFFF]/.test(name.replace(/\p{Extended_Pictographic}/gu, ''))).toBe(false);
  });

  it('skips leading blank lines and uses the first non-blank one', () => {
    const name = deriveDefaultTaskName({
      prompt: '\n   \n修复登录报错',
      runtimeLabel: 'Codex',
      now,
    });
    expect(name).toBe('修复登录报错');
  });

  it('adds the ellipsis when later lines were dropped, even if line 1 is short', () => {
    expect(
      deriveDefaultTaskName({ prompt: 'fix login\nsee issue #42', runtimeLabel: 'C', now }),
    ).toBe('fix login…');
    expect(deriveDefaultTaskName({ prompt: 'fix login', runtimeLabel: 'C', now })).toBe(
      'fix login',
    );
  });

  it('falls back to `<Runtime> · <timestamp>` when there is no instruction', () => {
    expect(deriveDefaultTaskName({ runtimeLabel: 'Codex', now })).toBe('Codex · 2026-08-10 14:23');
    expect(deriveDefaultTaskName({ prompt: '  \n ', runtimeLabel: 'Codex', now })).toBe(
      'Codex · 2026-08-10 14:23',
    );
  });
});
