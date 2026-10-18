import { Inject, Injectable, Optional } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { DATABASE } from '@platform/shared-kernel';
import type { ProjectId, Tx } from '@platform/shared-kernel';
import { Project } from '../../../domain/entities/project.entity';
import type { ProjectRepository } from '../../../domain/repositories/project.repository';
import { projects, type ProjectRow } from '../schema/project.sqlite';
import {
  PROJECT_READ_PROJECTION,
  type ProjectReadProjection,
} from '../../../domain/ports/project-read-projection.port';
import { asProjectId } from '@platform/shared-kernel';

type Db = BetterSQLite3Database;

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
    return Promise.resolve(row ? this.toDomain(row) : null);
  }

  findByIdSync(_tx: Tx, id: ProjectId): Project | null {
    const row = this.db.select().from(projects).where(eq(projects.id, id)).get();
    return row ? this.toDomain(row) : null;
  }

  async findByName(name: string): Promise<Project | null> {
    if (this.projection?.authoritative?.()) {
      const id = this.projection.findIdByName?.(name);
      return id ? this.findById(asProjectId(id)) : null;
    }
    const row = this.db.select().from(projects).where(eq(projects.name, name)).get();
    return row ? this.toDomain(row) : null;
  }

  async findAll(): Promise<Project[]> {
    return Promise.resolve(
      this.db
        .select()
        .from(projects)
        .all()
        .map((r) => this.toDomain(r)),
    );
  }

  async count(): Promise<number> {
    const row = this.db
      .select({ n: sql<number>`count(*)` })
      .from(projects)
      .get();
    return Promise.resolve(row?.n ?? 0);
  }

  saveSync(_tx: Tx, project: Project): void {
    const authoritative = this.projection?.authoritative?.() ?? false;
    const name = authoritative
      ? this.projection?.saveNameSync?.(_tx, project.id, project.name)
      : project.name;
    if (typeof name !== 'string') throw new Error('PROJECT_NAME_AUTHORITY_UNAVAILABLE');
    const values = {
      id: project.id as string,
      name,
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
      id: asProjectId(row.id),
      name: this.projection?.name(row.id, row.name) ?? row.name,
      sourceType: row.sourceType,
      repoUrl: row.repoUrl,
      repoBranch: row.repoBranch,
      cloneStatus: row.cloneStatus,
      cloneErrorCode: row.cloneErrorCode,
      baselinePath: row.baselinePath,
      baselineSizeBytes: row.baselineSizeBytes,
      workspaceMode: row.workspaceMode,
      version: row.version,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  }
}
