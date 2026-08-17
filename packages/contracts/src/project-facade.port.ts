import type { ProjectSourceType } from './schemas/project.schema';

/**
 * Cross-context facade (docs/backend/26 §3 link①, 01 §5): the `sandbox` context
 * needs, at provision time, the project's baseline directory + whether it may
 * accept a task — WITHOUT importing the `project` domain. It depends only on this
 * port; the `project` context provides the implementation (which runs
 * `Project.assertCanAcceptTask` internally). Living in `contracts` keeps both
 * sides boundaries-clean and avoids a package cycle.
 */
export interface ProjectRuntimeContext {
  projectId: string;
  /** host baseline dir to import into the sandbox workspace (empty dir ⇒ empty ws). */
  baselinePath: string;
  sourceType: ProjectSourceType;
}

export interface ProjectFacade {
  /**
   * Resolve the runtime context for a NEW task, asserting the project exists and
   * is ready (I-PRJ). Throws `ProjectAccessError` otherwise — the sandbox
   * interface maps its `code` to HTTP.
   */
  getRuntimeContextForTask(projectId: string): Promise<ProjectRuntimeContext>;
}

export const PROJECT_FACADE = Symbol('ProjectFacade');

export type ProjectAccessErrorCode = 'PROJECT_NOT_FOUND' | 'PROJECT_NOT_READY';

/** Boundaries-safe error the facade throws and the sandbox interface maps to HTTP. */
export class ProjectAccessError extends Error {
  constructor(
    readonly code: ProjectAccessErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ProjectAccessError';
  }
}
