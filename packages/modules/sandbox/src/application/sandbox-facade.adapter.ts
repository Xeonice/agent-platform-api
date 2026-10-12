import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  Optional,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import {
  asProjectId,
  UNIT_OF_WORK,
  BUSINESS_WRITER_AUTHORITY,
  type Tx,
  type UnitOfWork,
  type BusinessWriterAuthority,
} from '@platform/shared-kernel';
import {
  SANDBOX_PROVIDER_REGISTRY,
  WORKSPACE_PREPARER,
  SandboxProviderError,
  SandboxProviderErrorCode,
  WAITING_INPUT_QUERY,
  TERMINAL_BOOKMARK_CLEANUP,
  RUNTIME_BUSINESS_AUTHORITY,
} from '@platform/contracts';
import type {
  ProviderRegistry,
  SandboxFacade,
  WorkspacePreparer,
  WaitingInputQueryPort,
  TerminalBookmarkCleanup,
  RuntimeBusinessAuthorityPort,
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
  private ownershipPaused = false;
  private ownershipEpoch = 0;

  constructor(
    @Inject(SANDBOX_REPOSITORY) private readonly repo: SandboxRepository,
    @Inject(SANDBOX_PROVIDER_REGISTRY) private readonly providers: ProviderRegistry,
    @Inject(WORKSPACE_PREPARER) private readonly workspace: WorkspacePreparer,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    private readonly sandboxes: SandboxApplicationService,
    @Inject(WAITING_INPUT_QUERY) private readonly waiting: WaitingInputQueryPort,
    @Optional()
    @Inject(BUSINESS_WRITER_AUTHORITY)
    private readonly writer?: BusinessWriterAuthority,
    @Optional()
    @Inject(TERMINAL_BOOKMARK_CLEANUP)
    private readonly terminalBookmarks?: TerminalBookmarkCleanup,
    @Optional()
    @Inject(RUNTIME_BUSINESS_AUTHORITY)
    private readonly authority?: RuntimeBusinessAuthorityPort,
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
      const deleted = this.repo.deleteByProjectSync(tx, asProjectId(projectId));
      for (const sandbox of deleted) this.terminalBookmarks?.deleteForSandboxSync(tx, sandbox.id);
      return deleted.map(cleanupKey);
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
    if (this.ownershipPaused || this.cleaning.has(job.id)) return;
    this.cleaning.add(job.id);
    const localEpoch = this.ownershipEpoch;
    const writerEpoch = this.writer?.epoch?.() ?? 0;
    const assertCurrent = (): void => {
      if (
        this.ownershipPaused ||
        localEpoch !== this.ownershipEpoch ||
        writerEpoch !== (this.writer?.epoch?.() ?? 0)
      )
        throw new Error('PROJECT_CLEANUP_OWNERSHIP_SUPERSEDED');
      if (
        ['coordinator', 'coordinator-prepared'].includes(process.env.PLATFORM_PROCESS_ROLE ?? '') &&
        (!this.writer || !this.writer.run)
      )
        throw new Error('PROJECT_CLEANUP_WRITER_AUTHORITY_REQUIRED');
      this.writer?.assert();
    };
    try {
      const cleanup = async (): Promise<void> => {
        assertCurrent();
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
        assertCurrent();
        await this.workspace.cleanup(job.id, { keep: false });
        assertCurrent();
        this.uow.run((tx) => {
          assertCurrent();
          this.terminalBookmarks?.deleteForSandboxSync(tx, job.id);
          this.repo.completeProjectCleanupSync(tx, job.id);
        });
      };
      const withActor = () =>
        this.authority
          ? this.authority.run(
              {
                operationId: `project-cleanup:${job.id}`,
                actor: { kind: 'system', id: 'committed-project-deletion' },
              },
              cleanup,
            )
          : cleanup();
      await (this.writer?.run ? this.writer.run(withActor) : withActor());
    } catch (error) {
      this.logger.error(`project task cleanup pending for ${job.id}: ${String(error)}`);
    } finally {
      this.cleaning.delete(job.id);
    }
  }

  /** A handoff cannot abandon an already dispatched explicit cleanup effect. */
  pauseOwnership(): boolean {
    if (this.cleaning.size > 0) return false;
    this.ownershipPaused = true;
    this.ownershipEpoch++;
    return true;
  }
  resumeOwnership(): void {
    if (this.ownershipPaused) this.ownershipEpoch++;
    this.ownershipPaused = false;
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
