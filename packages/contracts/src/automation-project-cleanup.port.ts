import type { Tx } from '@platform/shared-kernel';

/** Project deletion owns the transaction; automation owns its rules and run history. */
export interface AutomationProjectCleanup {
  deleteByProjectSync(tx: Tx, projectId: string): void;
  countsByProject(projectId: string): Promise<{ rules: number; runs: number }>;
}

export const AUTOMATION_PROJECT_CLEANUP = Symbol('AutomationProjectCleanup');
