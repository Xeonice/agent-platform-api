import type { CloneStatus } from '../value-objects/project-status.vo';

/** Illegal clone_status move (I-PRJ) → interface maps to HTTP 409. */
export class InvalidProjectTransitionError extends Error {
  constructor(
    readonly from: CloneStatus,
    readonly to: CloneStatus,
  ) {
    super(`Illegal project transition: ${from} -> ${to}`);
    this.name = 'InvalidProjectTransitionError';
  }
}

/** RepoUrl value-object rejection (I-PRJ) → HTTP 400. */
export class InvalidRepoUrlError extends Error {
  constructor(raw: string) {
    super(`invalid repository URL: ${raw}`);
    this.name = 'InvalidRepoUrlError';
  }
}

/** An operation not allowed in the project's current state (e.g. retry on ready) → 409. */
export class ProjectStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectStateError';
  }
}
