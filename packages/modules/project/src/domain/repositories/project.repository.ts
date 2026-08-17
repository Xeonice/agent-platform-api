import type { ProjectId, Tx } from '@platform/shared-kernel';
import type { Project } from '../entities/project.entity';

/**
 * ProjectRepository PORT (interface only — implemented in infrastructure, 01 §3).
 * Reads are async; the transactional write is SYNCHRONOUS `saveSync(tx, agg): void`
 * (P0-2 / 28 §7.3).
 */
export interface ProjectRepository {
  findById(id: ProjectId): Promise<Project | null>;
  findByName(name: string): Promise<Project | null>;
  findAll(): Promise<Project[]>;
  count(): Promise<number>;
  saveSync(tx: Tx, project: Project): void;
  deleteSync(tx: Tx, id: ProjectId): void;
}

export const PROJECT_REPOSITORY = Symbol('ProjectRepository');
