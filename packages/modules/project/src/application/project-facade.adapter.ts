import { Inject, Injectable, Logger } from '@nestjs/common';
import { asProjectId } from '@platform/shared-kernel';
import { ProjectAccessError } from '@platform/contracts';
import type {
  ProjectFacade,
  ProjectRuntimeContext,
  RegisterRetainedVolumeCommand,
} from '@platform/contracts';
import { PROJECT_REPOSITORY } from '../domain/repositories/project.repository';
import type { ProjectRepository } from '../domain/repositories/project.repository';
import { BASELINE_GIT } from '../domain/ports/baseline-git.port';
import type { BaselineGit } from '../domain/ports/baseline-git.port';
import { ProjectStateError } from '../domain/errors/project-errors';
import { listBaselineBranches } from './baseline-branches';
import { RetainedVolumeService } from './retained-volume.service';

/**
 * Implements the cross-context `ProjectFacade` (contracts) so the `sandbox`
 * context can resolve a project's baseline + readiness WITHOUT importing the
 * project domain. Runs `Project.assertCanAcceptTask` internally and translates
 * domain failures into the boundaries-safe `ProjectAccessError`.
 */
@Injectable()
export class ProjectFacadeAdapter implements ProjectFacade {
  private readonly logger = new Logger('ProjectFacadeAdapter');

  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly repo: ProjectRepository,
    @Inject(BASELINE_GIT) private readonly git: BaselineGit,
    private readonly retainedVolumes: RetainedVolumeService,
  ) {}

  /**
   * `RegisterRetainedVolumeCommand`（24 §3）—— sandbox 上下文销毁完 keepVolume 之后
   * 把目录登记进 project 侧的账本。
   *
   * ⚠️ **永不向销毁流程抛。** 此刻实例已经没了、目录已经留下了；因为账本没记上就把
   * 整个 destroy 判失败，换来的是一个停在 `destroying` 的沙箱 + 一个谁也管不到的目录
   * —— 比「目录在、账本暂缺」坏得多。03 §7.7 的口径就是**目录是事实、表是索引**，
   * 两者不一致时以目录为准（启动对账补记或标 `deleted_at`）。
   */
  async registerRetainedVolume(command: RegisterRetainedVolumeCommand): Promise<void> {
    try {
      await this.retainedVolumes.register(command);
    } catch (e) {
      this.logger.error(
        `failed to register retained volume for sandbox ${command.sandboxId ?? '(unknown)'}: ` +
          `${(e as Error).message}. The directory is kept; startup reconciliation will pick it up.`,
      );
    }
  }

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
      // 03 §1：sandbox 侧的配额登记按它 × 1.2 算 `disk_mb_reserved`。原样透出，
      // **不在这里换算** —— 换算规则属于调度（03 §3），住在 sandbox 上下文。
      baselineSizeBytes: project.baselineSizeBytes,
    };
  }
}
