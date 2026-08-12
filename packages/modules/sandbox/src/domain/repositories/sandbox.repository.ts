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
  /** upsert the sandbox row + append pending transitions, inside `tx`. */
  saveSync(tx: Tx, sandbox: Sandbox): void;
}

export const SANDBOX_REPOSITORY = Symbol('SandboxRepository');
