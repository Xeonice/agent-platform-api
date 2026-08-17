/**
 * Cross-context facade (docs/backend/26 §3, 01 §5): the `project` context needs a
 * per-project Task count for its list/get DTOs (Task = sandbox, 23 D-1) WITHOUT
 * importing the `sandbox` domain. It depends only on this port; the `sandbox`
 * context provides the implementation. Living in `contracts` keeps both sides
 * boundaries-clean.
 */
export interface SandboxFacade {
  /**
   * Count the LIVE (non-destroyed) sandboxes per project id. Returns a map keyed
   * by every requested id (0 when a project has none).
   */
  countByProject(projectIds: string[]): Promise<Record<string, number>>;
}

export const SANDBOX_FACADE = Symbol('SandboxFacade');
