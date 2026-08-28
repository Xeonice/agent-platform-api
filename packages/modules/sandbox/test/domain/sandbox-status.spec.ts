import { describe, it, expect } from 'vitest';
import { asProjectId, asSandboxId } from '@platform/shared-kernel';
import { SandboxStatusVO } from '../../src/domain/value-objects/sandbox-status.vo';
import { Sandbox } from '../../src/domain/entities/sandbox.entity';
import { InvalidSandboxTransitionError } from '../../src/domain/errors/invalid-transition.error';
import { SandboxCreated } from '../../src/domain/events/sandbox-events';

/**
 * Zero-mock domain unit test (docs/backend/25 L0). The transition table is static
 * data, so the state machine is exhaustively assertable without any test double.
 */
describe('SandboxStatusVO transition table', () => {
  it('allows stopped -> starting (restart, reuses the existing workspace dir)', () => {
    expect(SandboxStatusVO.canTransitionTo('stopped', 'starting')).toBe(true);
  });

  it('rejects pending -> running (must traverse the scheduling pipeline)', () => {
    expect(SandboxStatusVO.canTransitionTo('pending', 'running')).toBe(false);
  });

  it('has exactly the 12 canonical statuses and destroyed is terminal', () => {
    expect(SandboxStatusVO.all).toHaveLength(12);
    expect(SandboxStatusVO.all).not.toContain('waiting-input');
    expect(SandboxStatusVO.isTerminal('destroyed')).toBe(true);
    expect(SandboxStatusVO.isTerminal('running')).toBe(false);
  });
});

describe('Sandbox aggregate', () => {
  const now = new Date('2026-08-12T00:00:00.000Z');
  const baseInput = {
    id: asSandboxId('sbx-1'),
    projectId: asProjectId('prj-1'),
    runtime: 'claude-code',
    provider: 'aio',
    headless: false,
    timeoutMinutes: null,
    idleTimeoutSec: 1800,
    now,
  };

  it('creates in pending, records the first transition, raises SandboxCreated', () => {
    const sandbox = Sandbox.create(baseInput);
    expect(sandbox.status).toBe('pending');
    expect(sandbox.transitions).toHaveLength(1);
    expect(sandbox.transitions[0]).toMatchObject({
      from: null,
      to: 'pending',
      triggeredBy: 'user',
    });
    expect(sandbox.pullEvents().map((e) => e.type)).toContain('SandboxCreated');
  });

  /**
   * 审计流的 `summary` 要「一行人话，直接上 UI」（13 §2.8.2），而审计是**历史快照**：
   * 记的必须是**当时**的名字。所以名字随事件走，projector 不回查库——任务后来被改名、
   * 甚至沙箱被销毁，那条审计行都该保持原样。
   */
  it('SandboxCreated 带的是任务显示名，且与聚合上的是同一个值', () => {
    const sandbox = Sandbox.create({ ...baseInput, initialPrompt: '修复登录页的样式问题' });
    const created = sandbox
      .pullEvents()
      .find((e): e is SandboxCreated => e instanceof SandboxCreated);

    // 这一条是关键：事件里塞 `runtime` / `imageRef` / id 的那几版同样"有个 name 字段"，
    // 只有与聚合自己那份对齐才能把它们分开。
    expect(created?.name).toBe(sandbox.name);
    expect(created?.name).toBe('修复登录页的样式问题');
    // ⚠️ 否定断言：写 id 的那一版正是本轮要修掉的东西。
    expect(created?.name).not.toBe(baseInput.id);
    expect(created?.name).not.toContain('sbx-1');
  });

  it('没有指令时，名字退化成 runtime + 时刻（仍然认得出，不是 UUID）', () => {
    const sandbox = Sandbox.create({ ...baseInput, runtimeLabel: 'Claude Code' });
    const created = sandbox
      .pullEvents()
      .find((e): e is SandboxCreated => e instanceof SandboxCreated);
    expect(created?.name).toBe('Claude Code · 2026-08-12 00:00');
  });

  it('permits the legal pending -> scheduling move and raises SandboxStateChanged', () => {
    const sandbox = Sandbox.create(baseInput);
    sandbox.pullEvents(); // drain create event
    sandbox.transitionTo('scheduling', 'scheduler', now);
    expect(sandbox.status).toBe('scheduling');
    expect(sandbox.pullEvents().map((e) => e.type)).toContain('SandboxStateChanged');
  });

  it('throws InvalidSandboxTransitionError on an illegal move', () => {
    const sandbox = Sandbox.create(baseInput);
    expect(() => sandbox.transitionTo('running', 'user', now)).toThrow(
      InvalidSandboxTransitionError,
    );
  });
});
