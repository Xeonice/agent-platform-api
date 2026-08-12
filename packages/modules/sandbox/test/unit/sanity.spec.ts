import { describe, it, expect } from 'vitest';
import {
  SandboxStatusVO,
  SANDBOX_STATUSES,
} from '../../src/domain/value-objects/sandbox-status.vo';
import type { SandboxStatus } from '../../src/domain/value-objects/sandbox-status.vo';

/**
 * Explicit "sanity" unit test proving the unit gate actually executes and that a
 * real, minimal domain invariant holds — no `expect(true)` filler. Asserts the
 * SandboxStatus transition graph (a pure value object) is well-formed.
 */
describe('sandbox domain sanity: SandboxStatus transition graph', () => {
  it('the canonical happy path is legal step by step', () => {
    const happyPath: SandboxStatus[] = [
      'pending',
      'scheduling',
      'preparing-workspace',
      'creating',
      'starting',
      'running',
    ];
    for (let i = 0; i < happyPath.length - 1; i++) {
      expect(SandboxStatusVO.canTransitionTo(happyPath[i], happyPath[i + 1])).toBe(true);
    }
  });

  it('exactly one status is terminal, and it is `destroyed`', () => {
    const terminal = SANDBOX_STATUSES.filter((s) => SandboxStatusVO.isTerminal(s));
    expect(terminal).toEqual(['destroyed']);
  });

  it('every non-terminal status has at least one legal successor', () => {
    for (const status of SANDBOX_STATUSES) {
      if (status === 'destroyed') continue;
      expect(SandboxStatusVO.nextStates(status).length).toBeGreaterThan(0);
    }
  });

  it('failed can retry to scheduling or proceed to destroying, but not jump to running', () => {
    expect(SandboxStatusVO.canTransitionTo('failed', 'scheduling')).toBe(true);
    expect(SandboxStatusVO.canTransitionTo('failed', 'destroying')).toBe(true);
    expect(SandboxStatusVO.canTransitionTo('failed', 'running')).toBe(false);
  });
});
