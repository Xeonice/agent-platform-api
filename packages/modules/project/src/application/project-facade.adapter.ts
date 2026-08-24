import { Inject, Injectable } from '@nestjs/common';
import { asProjectId } from '@platform/shared-kernel';
import { ProjectAccessError } from '@platform/contracts';
import type { ProjectFacade, ProjectRuntimeContext } from '@platform/contracts';
import { PROJECT_REPOSITORY } from '../domain/repositories/project.repository';
import type { ProjectRepository } from '../domain/repositories/project.repository';
import { BASELINE_GIT } from '../domain/ports/baseline-git.port';
import type { BaselineGit } from '../domain/ports/baseline-git.port';
import { ProjectStateError } from '../domain/errors/project-errors';
import { listBaselineBranches } from './baseline-branches';

/**
 * Implements the cross-context `ProjectFacade` (contracts) so the `sandbox`
 * context can resolve a project's baseline + readiness WITHOUT importing the
 * project domain. Runs `Project.assertCanAcceptTask` internally and translates
 * domain failures into the boundaries-safe `ProjectAccessError`.
 */
@Injectable()
export class ProjectFacadeAdapter implements ProjectFacade {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly repo: ProjectRepository,
    @Inject(BASELINE_GIT) private readonly git: BaselineGit,
  ) {}

  async getRuntimeContextForTask(
    projectId: string,
    branch?: string,
  ): Promise<ProjectRuntimeContext> {
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
    /**
     * ⚠️ THE BRANCH IS VERIFIED HERE, WHILE THE CALLER IS STILL AT THE DOOR — and this
     * method is READ-ONLY, which is what lets the refusal be 零副作用 (10 §6.8). It costs
     * one local `git branch -r`: after a full clone the answer is already on disk, so
     * there is no network call to fail and no git credential to hold. The only other
     * place that could catch a bad branch is `preparing-workspace`, i.e. after the 202,
     * after a row exists and after a workspace copy — a 「失败」 for what is plainly a
     * 「被拒」.
     */
    if (branch !== undefined) {
      const available = await listBaselineBranches(this.git, project);
      if (!available.includes(branch)) {
        throw new ProjectAccessError(
          'BRANCH_NOT_FOUND',
          `project ${projectId} has no branch '${branch}'`,
        );
      }
    }
    return {
      projectId,
      baselinePath: project.baselinePath,
      sourceType: project.sourceType,
      branch,
    };
  }
}
