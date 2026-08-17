import { describe, it, expect } from 'vitest';
import { asProjectId, asSandboxId } from '@platform/shared-kernel';
import { SandboxStatusVO } from '../../src/domain/value-objects/sandbox-status.vo';
import { Sandbox } from '../../src/domain/entities/sandbox.entity';
import { InvalidSandboxTransitionError } from '../../src/domain/errors/invalid-transition.error';

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
