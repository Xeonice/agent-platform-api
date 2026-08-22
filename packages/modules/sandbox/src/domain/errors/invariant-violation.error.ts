/**
 * A sandbox aggregate invariant was violated (23 §5.2). Unlike
 * `InvalidSandboxTransitionError` (a legitimate user-facing 409 — "you cannot stop
 * a destroyed task"), this signals that the CALLER asked for something the model
 * forbids outright, e.g. consuming an already-consumed instruction (I-SBX-10).
 */
export class SandboxInvariantViolationError extends Error {
  constructor(
    readonly invariant: string,
    message: string,
  ) {
    super(`${invariant}: ${message}`);
    this.name = 'SandboxInvariantViolationError';
  }
}
