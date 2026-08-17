import { Inject, Injectable } from '@nestjs/common';
import { asProjectId } from '@platform/shared-kernel';
import { ProjectAccessError } from '@platform/contracts';
import type { ProjectFacade, ProjectRuntimeContext } from '@platform/contracts';
import { PROJECT_REPOSITORY } from '../domain/repositories/project.repository';
import type { ProjectRepository } from '../domain/repositories/project.repository';
import { ProjectStateError } from '../domain/errors/project-errors';

/**
 * Implements the cross-context `ProjectFacade` (contracts) so the `sandbox`
 * context can resolve a project's baseline + readiness WITHOUT importing the
 * project domain. Runs `Project.assertCanAcceptTask` internally and translates
 * domain failures into the boundaries-safe `ProjectAccessError`.
 */
@Injectable()
export class ProjectFacadeAdapter implements ProjectFacade {
  constructor(@Inject(PROJECT_REPOSITORY) private readonly repo: ProjectRepository) {}

  async getRuntimeContextForTask(projectId: string): Promise<ProjectRuntimeContext> {
    const project = await this.repo.findById(asProjectId(projectId));
    if (!project) {
      throw new ProjectAccessError('PROJECT_NOT_FOUND', `project ${projectId} not found`);
    }
    try {
      project.assertCanAcceptTask();
    } catch (e) {
      if (e instanceof ProjectStateError) {
        throw new ProjectAccessError('PROJECT_NOT_READY', e.message);
      }
      throw e;
    }
    return {
      projectId,
      baselinePath: project.baselinePath,
      sourceType: project.sourceType,
    };
  }
}
