import { resolve } from 'node:path';
import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CLOCK, ID_GENERATOR, UNIT_OF_WORK, EVENT_BUS, asProjectId } from '@platform/shared-kernel';
import type { Clock, IdGenerator, UnitOfWork, EventBus } from '@platform/shared-kernel';
import { SANDBOX_FACADE } from '@platform/contracts';
import type {
  CreateProjectInput,
  DeleteProjectInput,
  ProjectBranches,
  ProjectDto,
  SandboxFacade,
} from '@platform/contracts';
import { Project } from '../domain/entities/project.entity';
import type { CloneErrorCode } from '../domain/entities/project.entity';
import { PROJECT_REPOSITORY } from '../domain/repositories/project.repository';
import type { ProjectRepository } from '../domain/repositories/project.repository';
import { BASELINE_MANAGER } from '../domain/ports/baseline-manager.port';
import type { BaselineManager } from '../domain/ports/baseline-manager.port';
import { BASELINE_GIT } from '../domain/ports/baseline-git.port';
import type { BaselineGit } from '../domain/ports/baseline-git.port';
import { CloneError } from '../domain/ports/git-cloner.port';
import { InvalidRepoUrlError, ProjectStateError } from '../domain/errors/project-errors';
import { CloneProjectWorkflow } from './clone-project.workflow';
import { SyncBaselineWorkflow } from './sync-baseline.workflow';
import { ProjectMapper } from './dto/project.mapper';
import { listBaselineBranches } from './baseline-branches';

const MAX_PROJECTS = 50; // I-PRJ-4

/** HTTP + retryable for a failed baseline fetch, straight from 03 §7.5's table. */
const FETCH_STATUS: Record<CloneErrorCode, HttpStatus> = {
  CLONE_FAILED_PERMISSION: HttpStatus.FORBIDDEN,
  CLONE_FAILED_NETWORK: HttpStatus.BAD_GATEWAY,
  DISK_INSUFFICIENT: HttpStatus.INSUFFICIENT_STORAGE,
  TIMEOUT: HttpStatus.GATEWAY_TIMEOUT,
  INTERRUPTED: HttpStatus.BAD_GATEWAY,
};
const FETCH_RETRYABLE: Record<CloneErrorCode, boolean> = {
  CLONE_FAILED_PERMISSION: false, // the user must configure a credential
  CLONE_FAILED_NETWORK: true,
  DISK_INSUFFICIENT: false, // the user must free space
  TIMEOUT: true,
  INTERRUPTED: true,
};

function fetchEnvelope(e: { code: CloneErrorCode; message: string }): Record<string, unknown> {
  return { code: e.code, message: e.message, retryable: FETCH_RETRYABLE[e.code] };
}

/**
 * Protocol-agnostic project application service (02 §1). REST + MCP inject this.
 * git projects return immediately as `cloning` (202 at the REST edge) and clone
 * in the background (CloneProjectWorkflow); empty projects are `ready` at once.
 */
@Injectable()
export class ProjectApplicationService {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly repo: ProjectRepository,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(EVENT_BUS) private readonly events: EventBus,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
    @Inject(BASELINE_MANAGER) private readonly baseline: BaselineManager,
    @Inject(BASELINE_GIT) private readonly git: BaselineGit,
    @Inject(SANDBOX_FACADE) private readonly sandboxes: SandboxFacade,
    private readonly cloneWorkflow: CloneProjectWorkflow,
    private readonly syncWorkflow: SyncBaselineWorkflow,
  ) {}

  private dataRoot(): string {
    return process.env.DATA_ROOT ?? resolve(process.cwd(), 'data');
  }

  private baselinePathFor(projectId: string): string {
    return resolve(this.dataRoot(), 'baselines', projectId);
  }

  async create(input: CreateProjectInput): Promise<ProjectDto> {
    // I-PRJ-1 as a 400 (the domain also enforces it as a last line of defence).
    if (input.sourceType === 'git' && !input.repoUrl) {
      throw new BadRequestException("sourceType 'git' requires repoUrl");
    }
    if (input.sourceType === 'empty' && input.repoUrl) {
      throw new BadRequestException("sourceType 'empty' must omit repoUrl");
    }
    // I-PRJ-4: at most 50 projects; names are unique (app-level pre-check backed by
    // the DB UNIQUE index for the race).
    if ((await this.repo.count()) >= MAX_PROJECTS) {
      throw new BadRequestException(`project limit reached (max ${MAX_PROJECTS})`);
    }
    if (await this.repo.findByName(input.name)) {
      throw new ConflictException(`a project named '${input.name}' already exists`);
    }
    const id = asProjectId(this.ids.next());
    const baselinePath = this.baselinePathFor(id);
    let project: Project;
    try {
      project = Project.create({
        id,
        name: input.name,
        sourceType: input.sourceType,
        repoUrl: input.repoUrl,
        repoBranch: input.repoBranch,
        baselinePath,
        now: this.clock.now(),
      });
    } catch (e) {
      throw this.mapDomainError(e);
    }

    // empty projects get their (empty) baseline up front; git baselines are created
    // by the cloner in the background.
    if (input.sourceType === 'empty') {
      await this.baseline.createEmptyDir(baselinePath);
    }
    this.persist(project);
    if (input.sourceType === 'git') {
      this.cloneWorkflow.enqueue(id);
    }
    return this.toDto(project);
  }

  async retryClone(id: string): Promise<ProjectDto> {
    const project = await this.require(id);
    try {
      project.retryClone(this.clock.now());
    } catch (e) {
      throw this.mapDomainError(e);
    }
    this.persist(project);
    this.cloneWorkflow.enqueue(id);
    return this.toDto(project);
  }

  async convertToEmpty(id: string): Promise<ProjectDto> {
    const project = await this.require(id);
    try {
      project.convertToEmpty(this.clock.now());
    } catch (e) {
      throw this.mapDomainError(e);
    }
    // drop any partial clone, then materialise an empty baseline.
    await this.baseline.removeDir(project.baselinePath).catch(() => undefined);
    await this.baseline.createEmptyDir(project.baselinePath);
    this.persist(project);
    return this.toDto(project);
  }

  /**
   * `GET /api/projects/:id/branches` (03 §7.2★). Reads the baseline's LOCAL
   * remote-tracking refs — never `git ls-remote`. After a full clone every branch is
   * already on disk, so this endpoint has no network failure mode and needs no git
   * credential; throwing that away by asking the remote would forfeit the single
   * biggest reason the baseline is cloned in full.
   *
   * `[]` for an empty project or a baseline that is not `ready` (10 §6.2): there is no
   * repository on disk to read, and answering 「暂时没有分支」 is the truthful answer for a
   * project still cloning, not an error the branch picker has to special-case.
   */
  async listBranches(id: string): Promise<ProjectBranches> {
    return listBaselineBranches(this.git, await this.require(id));
  }

  /**
   * `POST /api/projects/:id/sync` (03 §7.2★ / 27 §3). `ready` git projects only —
   * anything else is a 409 raised by the aggregate, not by an `if` here, so the rule
   * holds for every caller of `Project.syncBaseline`.
   *
   * The scope is the baseline and NOTHING else; see `SyncBaselineWorkflow`.
   */
  async syncBaseline(id: string): Promise<ProjectDto> {
    const project = await this.require(id);
    try {
      await this.syncWorkflow.run(project);
    } catch (e) {
      throw this.mapDomainError(e);
    }
    this.persist(project);
    return this.toDto(project);
  }

  async cancelClone(id: string): Promise<ProjectDto> {
    const project = await this.require(id);
    if (project.cloneStatus === 'cloning') {
      this.cloneWorkflow.cancel(id);
    }
    return this.toDto(project);
  }

  async delete(id: string, input: DeleteProjectInput = {}): Promise<void> {
    const project = await this.require(id);
    if (project.cloneStatus === 'cloning') this.cloneWorkflow.cancel(id);
    if (!(input.keepBaseline ?? false)) {
      await this.baseline.removeDir(project.baselinePath).catch(() => undefined);
    }
    this.uow.run((tx) => this.repo.deleteSync(tx, asProjectId(id)));
  }

  async get(id: string): Promise<ProjectDto> {
    return this.toDto(await this.require(id));
  }

  async list(): Promise<ProjectDto[]> {
    const projects = await this.repo.findAll();
    const counts = await this.sandboxes.countByProject(projects.map((p) => p.id as string));
    return projects.map((p) => ProjectMapper.toDto(p, counts[p.id as string] ?? 0));
  }

  /** Map one project, filling taskCount via the cross-context SandboxFacade. */
  private async toDto(project: Project): Promise<ProjectDto> {
    const id = project.id as string;
    const counts = await this.sandboxes.countByProject([id]);
    return ProjectMapper.toDto(project, counts[id] ?? 0);
  }

  private async require(id: string): Promise<Project> {
    const project = await this.repo.findById(asProjectId(id));
    if (!project) throw new NotFoundException(`project ${id} not found`);
    return project;
  }

  private persist(project: Project): void {
    this.uow.run((tx) => {
      this.repo.saveSync(tx, project);
      this.events.publishInTx(tx, project.pullEvents());
    });
  }

  private mapDomainError(e: unknown): unknown {
    if (e instanceof InvalidRepoUrlError) return new BadRequestException(e.message);
    if (e instanceof ProjectStateError) return new ConflictException(e.message);
    // A failed `git fetch --all` is the remote's answer, not a platform bug, so it keeps
    // its CLONE taxonomy code (03 §7.5). That is deliberate reuse: the frontend already
    // branches on these exact codes for a failed clone — PERMISSION ⇒ [配置 Git 凭证],
    // NETWORK ⇒ [重试] — and a sync failing for the same reason should not need a second
    // vocabulary. `retryable` comes from 03 §7.5's own column, not from the status code.
    if (e instanceof CloneError) return new HttpException(fetchEnvelope(e), FETCH_STATUS[e.code]);
    return e;
  }
}
