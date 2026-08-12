/**
 * SandboxStatus value object (docs/backend/23 I-SBX-1, 03 §4, 28 §2.2).
 *
 * The transition table is STATIC DATA, not scattered if/else — that is the
 * precondition for exhaustive, zero-mock unit tests (25 L0).
 *
 * Domain owns its own status literal union (it does NOT import the wire enum
 * from @platform/contracts — boundaries forbids domain→contracts). The three
 * layers share the same literals by construction (28 §4 "三层同枚举字面量").
 *
 * `waiting-input` is deliberately absent: it is a runtime sub-state of `running`
 * surfaced only over WS + as a derived DTO field, never a persisted status.
 */
export const SANDBOX_STATUSES = [
  'pending',
  'scheduling',
  'preparing-workspace',
  'creating',
  'starting',
  'running',
  'idle',
  'stopping',
  'stopped',
  'failed',
  'destroying',
  'destroyed',
] as const;

export type SandboxStatus = (typeof SANDBOX_STATUSES)[number];

/**
 * Legal transitions (03 §4):
 *   pending → scheduling → preparing-workspace → creating → starting → running ⇄ idle → stopping → stopped
 *   any active state → failed
 *   failed → scheduling (retry) | destroying
 *   stopped → starting (restart, reuse existing workspace dir — does NOT re-enter preparing-workspace)
 *   stopped/failed → destroying → destroyed (terminal)
 */
const TRANSITIONS: Readonly<Record<SandboxStatus, readonly SandboxStatus[]>> = {
  pending: ['scheduling'],
  scheduling: ['preparing-workspace', 'failed'],
  'preparing-workspace': ['creating', 'failed'],
  creating: ['starting', 'failed'],
  starting: ['running', 'failed'],
  running: ['idle', 'stopping', 'failed'],
  idle: ['running', 'stopping'],
  stopping: ['stopped', 'failed'],
  stopped: ['starting', 'destroying'],
  failed: ['scheduling', 'destroying'],
  destroying: ['destroyed'],
  destroyed: [],
};

export const SandboxStatusVO = {
  all: SANDBOX_STATUSES,

  canTransitionTo(from: SandboxStatus, to: SandboxStatus): boolean {
    return TRANSITIONS[from].includes(to);
  },

  isTerminal(status: SandboxStatus): boolean {
    return TRANSITIONS[status].length === 0;
  },

  nextStates(from: SandboxStatus): readonly SandboxStatus[] {
    return TRANSITIONS[from];
  },
};
