/**
 * Cross-context facade (docs/backend/26 §3, 01 §5): the `project` context needs a
 * per-project Task count for its list/get DTOs (Task = sandbox, 23 D-1) WITHOUT
 * importing the `sandbox` domain. It depends only on this port; the `sandbox`
 * context provides the implementation. Living in `contracts` keeps both sides
 * boundaries-clean.
 */
import type { Tx } from '@platform/shared-kernel';

export interface SandboxFacade {
  /** Existing tasks referencing this frozen image version; stopped/failed count, destroyed do not. */
  imageReferences(
    manifestId: string,
  ): Promise<
    { id: string; name: string; status: string; projectId: string; projectName: string }[]
  >;
  /** Capacity using the same default quota and policy as task admission. */
  defaultCapacity(): Promise<{
    remainingTasks: number;
    registeredTasks: number;
    maxTasks: number;
    basis: string;
  }>;
  credentialImpact(
    runtimeId: string,
    boundIds: string[],
  ): Promise<{
    affectedTasks: {
      id: string;
      name: string;
      runtime: string;
      status: string;
      headless: boolean;
    }[];
    preparingTasks: {
      id: string;
      name: string;
      runtime: string;
      status: string;
      headless: boolean;
    }[];
  }>;
  /**
   * Count the LIVE (non-destroyed) sandboxes per project id. Returns a map keyed
   * by every requested id (0 when a project has none).
   */
  countByProject(projectIds: string[]): Promise<Record<string, number>>;
  /** Tasks that are creating, running, stopping or being destroyed block project deletion. */
  activeByProject(projectId: string): Promise<{ id: string; name: string }[]>;
  /** Recheck active tasks and remove inactive records in the caller's transaction. */
  deleteByProjectSync(tx: Tx, projectId: string): string[];
  /** Remove only the directories returned by a successfully committed deletion. */
  removeProjectWorkspaces(paths: string[]): Promise<void>;
}

export const SANDBOX_FACADE = Symbol('SandboxFacade');
