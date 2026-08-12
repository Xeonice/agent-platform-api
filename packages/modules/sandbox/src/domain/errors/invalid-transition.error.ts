import type { SandboxStatus } from '../value-objects/sandbox-status.vo';

/** Illegal state-machine move (28 §11) → interface layer maps to HTTP 409. */
export class InvalidSandboxTransitionError extends Error {
  constructor(
    public readonly from: SandboxStatus,
    public readonly to: SandboxStatus,
  ) {
    super(`Illegal sandbox transition: ${from} -> ${to}`);
    this.name = 'InvalidSandboxTransitionError';
  }
}
