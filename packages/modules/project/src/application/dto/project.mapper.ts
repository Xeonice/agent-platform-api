import type { ProjectDto } from '@platform/contracts';
import type { Project } from '../../domain/entities/project.entity';

/**
 * Mapper — the ONLY place domain ↔ wire DTO conversion happens (28 §4/§8).
 * `taskCount` is supplied by the application (cross-context SandboxFacade).
 *
 * `repoUrl` / `repoBranch` / `baselineSizeBytes` / `updatedAt` are projected since the
 * P21-6 read-only bar (10 §7.3) — see the `ProjectDtoSchema` comment for why that
 * overturns the earlier 「来源不外露」 ruling. `null → undefined` because the wire
 * contract writes them `?:`, and a JSON `null` would make the frontend's
 * `repoUrl ?? '—'` render 「null」 instead of the placeholder.
 *
 * `baselinePath` and `workspaceMode` stay INTERNAL: the first is a host filesystem
 * path (an absolute server path has no meaning to a browser and is free reconnaissance
 * for anything else reading the response), the second is a v1.1 switch with no UI.
 */
export const ProjectMapper = {
  toDto(project: Project, taskCount: number): ProjectDto {
    return {
      id: project.id as string,
      name: project.name,
      sourceType: project.sourceType,
      cloneStatus: project.cloneStatus,
      cloneErrorCode: project.cloneErrorCode,
      taskCount,
      createdAt: project.createdAt.toISOString(),
      repoUrl: project.repoUrl ?? undefined,
      repoBranch: project.repoBranch ?? undefined,
      baselineSizeBytes: project.baselineSizeBytes ?? undefined,
      updatedAt: project.updatedAt.toISOString(),
    };
  },
};
