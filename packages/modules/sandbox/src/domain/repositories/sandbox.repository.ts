import type { SandboxId, ProjectId, Tx } from '@platform/shared-kernel';
import type { Sandbox } from '../entities/sandbox.entity';

/**
 * SandboxRepository PORT (interface only — implemented in infrastructure, 01 §3).
 * Reads are async; the transactional write is SYNCHRONOUS `saveSync(tx, agg): void`
 * (P0-2 / 28 §7.3) — the `void` return forbids `await` in the write path at the
 * type level.
 */
export interface SandboxRepository {
  findById(id: SandboxId): Promise<Sandbox | null>;
  findByProject(projectId: ProjectId): Promise<Sandbox[]>;
  /**
   * 全部 sandbox（不按项目过滤）——工作台左侧任务树要一次拿到**所有项目**的任务。
   * ⚠️ 与 `countActiveByProject` 一样含 destroyed 行，**排除在应用层做**（见 list()）：
   * 两条路径必须用同一份过滤，否则树上的计数与列表会各说各话。
   */
  findAll(): Promise<Sandbox[]>;
  /** live (non-destroyed) sandbox count per project id, in ONE grouped query. */
  countActiveByProject(projectIds: string[]): Promise<Record<string, number>>;
  /** Read-only projection for the image deletion guard, including the actual project name. */
  findImageReferences(manifestId: string): Promise<SandboxImageReference[]>;
  /** Same-transaction live recheck followed by inactive-record removal. */
  deleteByProjectSync(tx: Tx, projectId: ProjectId): DeletedProjectSandbox[];
  listPendingProjectCleanup(): Promise<DeletedProjectSandbox[]>;
  completeProjectCleanupSync(tx: Tx, sandboxId: string): void;
  /** upsert the sandbox row + append pending transitions, inside `tx`. */
  saveSync(tx: Tx, sandbox: Sandbox): void;
}

export const SANDBOX_REPOSITORY = Symbol('SandboxRepository');

export interface SandboxImageReference {
  id: string;
  name: string;
  status: string;
  projectId: string;
  projectName: string;
  headless: boolean;
}

export interface DeletedProjectSandbox {
  id: string;
  provider: string;
  providerSandboxId: string | null;
  providerState: Record<string, unknown> | null;
  workspacePath: string | null;
}

export function isProjectTaskActive(status: string): boolean {
  return !['stopped', 'failed', 'destroyed'].includes(status);
}
