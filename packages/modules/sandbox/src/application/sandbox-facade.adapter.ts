import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { asProjectId, UNIT_OF_WORK, type Tx, type UnitOfWork } from '@platform/shared-kernel';
import {
  SANDBOX_PROVIDER_REGISTRY,
  WORKSPACE_PREPARER,
  SandboxProviderError,
  SandboxProviderErrorCode,
  WAITING_INPUT_QUERY,
} from '@platform/contracts';
import type {
  ProviderRegistry,
  SandboxFacade,
  WorkspacePreparer,
  WaitingInputQueryPort,
} from '@platform/contracts';
import { SANDBOX_REPOSITORY, isProjectTaskActive } from '../domain/repositories/sandbox.repository';
import type {
  DeletedProjectSandbox,
  SandboxRepository,
} from '../domain/repositories/sandbox.repository';
import { SandboxProjectHasActiveTasksError } from '../domain/errors/write-conflict.error';
import { withTeardownDeadline } from './teardown-deadline';
import { SandboxApplicationService } from './sandbox-application.service';

/** Records and cleanup intent commit together; external IO begins after commit. */
@Injectable()
export class SandboxFacadeAdapter
  implements SandboxFacade, OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger('SandboxFacadeAdapter');
  private retry: NodeJS.Timeout | undefined;
  private readonly cleaning = new Set<string>();

  constructor(
    @Inject(SANDBOX_REPOSITORY) private readonly repo: SandboxRepository,
    @Inject(SANDBOX_PROVIDER_REGISTRY) private readonly providers: ProviderRegistry,
    @Inject(WORKSPACE_PREPARER) private readonly workspace: WorkspacePreparer,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    private readonly sandboxes: SandboxApplicationService,
    @Inject(WAITING_INPUT_QUERY) private readonly waiting: WaitingInputQueryPort,
  ) {}

  countByProject(projectIds: string[]): Promise<Record<string, number>> {
    return this.repo.countActiveByProject(projectIds);
  }

  async imageReferences(manifestId: string) {
    const rows = await this.repo.findImageReferences(manifestId);
    const waiting = this.waiting.filterWaiting(rows.map((row) => row.id));
    return rows.map(({ headless, ...row }) => ({
      ...row,
      status:
        !headless && ['running', 'idle'].includes(row.status) && waiting.has(row.id)
          ? 'waiting_input'
          : row.status,
    }));
  }

  defaultCapacity() {
    return this.sandboxes.defaultCapacity();
  }

  async activeByProject(projectId: string): Promise<{ id: string; name: string }[]> {
    return (await this.repo.findByProject(asProjectId(projectId)))
      .filter((sandbox) => isProjectTaskActive(sandbox.status))
      .map((sandbox) => ({ id: sandbox.id, name: sandbox.name }));
  }

  async credentialImpact(runtimeId: string, boundIds: string[]) {
    const bound = new Set(boundIds);
    const rows = (await this.repo.findAll()).filter((sandbox) => sandbox.status !== 'destroyed');
    const waiting = this.waiting.filterWaiting(rows.map((sandbox) => sandbox.id));
    const summary = (sandbox: (typeof rows)[number]) => ({
      id: sandbox.id,
      name: sandbox.name,
      runtime: sandbox.runtime,
      status:
        !sandbox.headless && ['running', 'idle'].includes(sandbox.status) && waiting.has(sandbox.id)
          ? 'waiting_input'
          : sandbox.status,
      headless: sandbox.headless,
    });
    return {
      affectedTasks: rows.filter((sandbox) => bound.has(sandbox.id)).map(summary),
      preparingTasks: rows
        .filter(
          (sandbox) =>
            sandbox.runtime === runtimeId &&
            !bound.has(sandbox.id) &&
            ['pending', 'scheduling', 'preparing-workspace', 'creating', 'starting'].includes(
              sandbox.status,
            ),
        )
        .map(summary),
    };
  }

  deleteByProjectSync(tx: Tx, projectId: string): string[] {
    try {
      return this.repo.deleteByProjectSync(tx, asProjectId(projectId)).map(cleanupKey);
    } catch (error) {
      if (error instanceof SandboxProjectHasActiveTasksError)
        throw new ConflictException({
          code: 'PROJECT_HAS_ACTIVE_TASKS',
          message: error.message,
          details: error.tasks,
        });
      throw error;
    }
  }

  async removeProjectWorkspaces(paths: string[]): Promise<void> {
    const requested = new Set(paths);
    // Read committed jobs: a rolled-back project transaction cannot start cleanup.
    const jobs = (await this.repo.listPendingProjectCleanup()).filter((job) =>
      requested.has(cleanupKey(job)),
    );
    await Promise.all(jobs.map((job) => this.clean(job)));
  }

  async retryPending(): Promise<void> {
    await Promise.all((await this.repo.listPendingProjectCleanup()).map((job) => this.clean(job)));
  }

  private async clean(job: DeletedProjectSandbox): Promise<void> {
    if (this.cleaning.has(job.id)) return;
    this.cleaning.add(job.id);
    try {
      if (job.providerSandboxId) {
        try {
          await withTeardownDeadline(
            this.providers.get(job.provider).destroy({
              provider: job.provider,
              providerSandboxId: job.providerSandboxId,
              providerState: job.providerState ?? undefined,
            }),
            job.id,
          );
        } catch (error) {
          if (
            !(error instanceof SandboxProviderError) ||
            error.code !== SandboxProviderErrorCode.NOT_FOUND
          )
            throw error;
        }
      }
      await this.workspace.cleanup(job.id, { keep: false });
      this.uow.run((tx) => this.repo.completeProjectCleanupSync(tx, job.id));
    } catch (error) {
      this.logger.error(`project task cleanup pending for ${job.id}: ${String(error)}`);
    } finally {
      this.cleaning.delete(job.id);
    }
  }

  onApplicationBootstrap(): void {
    const recover = (): void => {
      void this.retryPending().catch((error: unknown) =>
        this.logger.error(`project cleanup recovery failed: ${String(error)}`),
      );
    };
    recover();
    this.retry = setInterval(recover, 15_000);
    this.retry.unref();
  }

  onModuleDestroy(): void {
    if (this.retry) clearInterval(this.retry);
  }
}

function cleanupKey(job: DeletedProjectSandbox): string {
  return job.workspacePath ?? `sandbox:${job.id}`;
}
