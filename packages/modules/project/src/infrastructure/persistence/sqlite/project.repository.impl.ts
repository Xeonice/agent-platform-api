import { Inject, Injectable, Optional } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { DATABASE } from '@platform/shared-kernel';
import type { ProjectId, Tx } from '@platform/shared-kernel';
import { Project } from '../../../domain/entities/project.entity';
import type {
  CloneErrorCode,
  ProjectSourceType,
  WorkspaceMode,
} from '../../../domain/entities/project.entity';
import type { CloneStatus } from '../../../domain/value-objects/project-status.vo';
import type { ProjectRepository } from '../../../domain/repositories/project.repository';
import { projects, type ProjectRow } from '../schema/project.sqlite';
import {
  PROJECT_READ_PROJECTION,
  type ProjectReadProjection,
} from '../../../domain/ports/project-read-projection.port';

type Db = BetterSQLite3Database<Record<string, never>>;

/**
 * SQLite (better-sqlite3 + Drizzle) implementation of ProjectRepository (28 §4/§7.3).
 * `saveSync`/`deleteSync` run inside the caller's synchronous UnitOfWork.
 */
@Injectable()
export class SqliteProjectRepository implements ProjectRepository {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Optional()
    @Inject(PROJECT_READ_PROJECTION)
    private readonly projection?: ProjectReadProjection,
  ) {}

  async findById(id: ProjectId): Promise<Project | null> {
    const row = this.db.select().from(projects).where(eq(projects.id, id)).get();
    return row ? this.toDomain(row) : null;
  }

  findByIdSync(_tx: Tx, id: ProjectId): Project | null {
    const row = this.db.select().from(projects).where(eq(projects.id, id)).get();
    return row ? this.toDomain(row) : null;
  }

  async findByName(name: string): Promise<Project | null> {
    if (this.projection?.authoritative?.()) {
      const id = this.projection.findIdByName?.(name);
      return id ? this.findById(id as ProjectId) : null;
    }
    const row = this.db.select().from(projects).where(eq(projects.name, name)).get();
    return row ? this.toDomain(row) : null;
  }

  async findAll(): Promise<Project[]> {
    return this.db
      .select()
      .from(projects)
      .all()
      .map((r) => this.toDomain(r));
  }

  async count(): Promise<number> {
    const row = this.db
      .select({ n: sql<number>`count(*)` })
      .from(projects)
      .get();
    return row?.n ?? 0;
  }

  saveSync(_tx: Tx, project: Project): void {
    const authoritative = this.projection?.authoritative?.() ?? false;
    const authoritySlot = authoritative
      ? this.projection?.saveNameSync?.(_tx, project.id, project.name)
      : undefined;
    if (authoritative && typeof authoritySlot !== 'string')
      throw new Error('PROJECT_NAME_AUTHORITY_UNAVAILABLE');
    const values = {
      id: project.id as string,
      name: authoritative ? authoritySlot! : project.name,
      sourceType: project.sourceType,
      repoUrl: project.repoUrl,
      repoBranch: project.repoBranch,
      cloneStatus: project.cloneStatus,
      cloneErrorCode: project.cloneErrorCode,
      baselinePath: project.baselinePath,
      baselineSizeBytes: project.baselineSizeBytes,
      workspaceMode: project.workspaceMode,
      version: project.version,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
    };
    this.db
      .insert(projects)
      .values(values)
      .onConflictDoUpdate({
        target: projects.id,
        set: {
          name: values.name,
          sourceType: values.sourceType,
          repoUrl: values.repoUrl,
          repoBranch: values.repoBranch,
          cloneStatus: values.cloneStatus,
          cloneErrorCode: values.cloneErrorCode,
          baselineSizeBytes: values.baselineSizeBytes,
          workspaceMode: values.workspaceMode,
          version: values.version,
          updatedAt: values.updatedAt,
        },
      })
      .run();
    project.markPersisted(project.version);
  }

  deleteSync(_tx: Tx, id: ProjectId): void {
    this.db.delete(projects).where(eq(projects.id, id)).run();
  }

  private toDomain(row: ProjectRow): Project {
    return Project.rehydrate({
      id: row.id as ProjectId,
      name: this.projection?.name(row.id, row.name) ?? row.name,
      sourceType: row.sourceType as ProjectSourceType,
      repoUrl: row.repoUrl,
      repoBranch: row.repoBranch,
      cloneStatus: row.cloneStatus as CloneStatus,
      cloneErrorCode: row.cloneErrorCode as CloneErrorCode | null,
      baselinePath: row.baselinePath,
      baselineSizeBytes: row.baselineSizeBytes,
      workspaceMode: row.workspaceMode as WorkspaceMode,
      version: row.version,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  }
}
