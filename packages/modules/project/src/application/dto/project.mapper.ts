import type { ProjectDto } from '@platform/contracts';
import type { Project } from '../../domain/entities/project.entity';

/**
 * Mapper — the ONLY place domain ↔ wire DTO conversion happens (28 §4/§8).
 * `repoUrl`/`repoBranch` and internal fields (workspaceMode/baselineSizeBytes/
 * updatedAt) are intentionally NOT projected (shared/10 §7 minimal DTO).
 * `taskCount` is supplied by the application (cross-context SandboxFacade).
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
    };
  },
};
