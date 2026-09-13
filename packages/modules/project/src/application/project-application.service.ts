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
import { RETAINED_VOLUME_REPOSITORY } from '../domain/repositories/retained-volume.repository';
import type { RetainedVolumeRepository } from '../domain/repositories/retained-volume.repository';
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
  // 404, not 403: the remote did not open, and we do NOT know whether that is a
  // missing credential or a typo in the URL (see CloneErrorCodeSchema).
  CLONE_FAILED_NOT_FOUND: HttpStatus.NOT_FOUND,
  CLONE_FAILED_NETWORK: HttpStatus.BAD_GATEWAY,
  DISK_INSUFFICIENT: HttpStatus.INSUFFICIENT_STORAGE,
  TIMEOUT: HttpStatus.GATEWAY_TIMEOUT,
  INTERRUPTED: HttpStatus.BAD_GATEWAY,
};
const FETCH_RETRYABLE: Record<CloneErrorCode, boolean> = {
  CLONE_FAILED_PERMISSION: false, // the user must configure a credential
  CLONE_FAILED_NOT_FOUND: false, // a credential or a different URL is needed first
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
    @Inject(RETAINED_VOLUME_REPOSITORY) private readonly volumes: RetainedVolumeRepository,
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
    //
    // ★ Every rejection below carries an explicit BUSINESS CODE, not a bare string.
    //   Without one they all出线 as `BAD_REQUEST` (the filter's status→code fallback)
    //   and the frontend has literally nothing to branch on but the English prose —
    //   which is why `project limit reached (max 50)` used to reach users verbatim.
    //   ⛔ Inferring the meaning from the status code is banned on the frontend
    //   (`useProjects.ts` header), so the meaning has to be stated here.
    if (input.sourceType === 'git' && !input.repoUrl) {
      throw new BadRequestException({
        code: 'INVALID_PROJECT_SOURCE',
        message: "sourceType 'git' requires repoUrl",
        retryable: false,
        sideEffectFree: true,
      });
    }
    if (input.sourceType === 'empty' && input.repoUrl) {
      throw new BadRequestException({
        code: 'INVALID_PROJECT_SOURCE',
        message: "sourceType 'empty' must omit repoUrl",
        retryable: false,
        sideEffectFree: true,
      });
    }
    // I-PRJ-4: at most 50 projects; names are unique (app-level pre-check backed by
    // the DB UNIQUE index for the race).
    if ((await this.repo.count()) >= MAX_PROJECTS) {
      throw new BadRequestException({
        code: 'PROJECT_LIMIT_REACHED',
        message: `project limit reached (max ${MAX_PROJECTS})`,
        retryable: false,
        sideEffectFree: true,
      });
    }
    if (await this.repo.findByName(input.name)) {
      // 27 §... documents this as ALREADY_EXISTS(409); it never actually shipped —
      // the bare ConflictException came out as `INVALID_STATE`, so the frontend's
      // `code === 'ALREADY_EXISTS'` branch was dead code from the day it was written.
      throw new ConflictException({
        code: 'ALREADY_EXISTS',
        message: `a project named '${input.name}' already exists`,
        retryable: false,
        sideEffectFree: true,
      });
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
    // 聚合判「真取消了还是按晚了」，只有前者才发事件（见 `Project.cancelClone`）。
    if (project.cancelClone(this.clock.now())) {
      this.cloneWorkflow.cancel(id);
      // ⚠️ 只 publish，不 save：取消**不改聚合状态**，落定由 workflow 的失败路径写。
      this.publish(project);
    }
    return this.toDto(project);
  }

  /**
   * 删项目。
   *
   * ⚠️ **还在占盘的保留成果会拦下这一步**（下面那段）。这条规则此前写在 DB 的
   * `onDelete: 'restrict'` 上，而那是错的：`RetainedVolumeService.remove()` 是**软删**
   * （记录留档审计），行永远不消失 ⇒ 一个项目只要曾经有过一份保留成果就**再也删不掉**，
   * 用户把成果清干净也没用。已在真库上实证。FK 已退回弱引用，见
   * `retained-volume.sqlite.ts` 里 `projectId` 的注释。
   *
   * ⇒ 判据必须是 `deletedAt === null`（还在占盘），而不是「有没有这一行」。
   * 这件事只有应用层知道，所以约束落在这里。
   */
  async delete(id: string, input: DeleteProjectInput = {}): Promise<void> {
    const project = await this.require(id);
    // ⚠️ 走 `mapDomainError` 而不是直接抛：领域错误漏出去就是 500，
    //    而这是一次**可预期的拒绝**，用户该拿到 409 和一句能照做的话。
    try {
      await this.assertNoLiveRetainedVolumes(id);
    } catch (e) {
      throw this.mapDomainError(e);
    }
    if (project.cloneStatus === 'cloning') this.cloneWorkflow.cancel(id);
    const keptBaseline = input.keepBaseline ?? false;
    if (!keptBaseline) {
      await this.baseline.removeDir(project.baselinePath).catch(() => undefined);
    }
    // ⚠️ 事件在删行**之前**攒好、与删行**同一个事务** publish：审计必须在主体被删除
    // 之后继续存在（13 §2.8.2「为什么 subject_id 不设 FK」），而这条记录本身此前
    // 压根不存在 —— 删掉项目后 `seq` 一点没动。
    project.markDeleted(keptBaseline, this.clock.now());
    this.uow.run((tx) => {
      // ⚠️ **必须在删项目之前**：`retained_volumes.project_id` 上是
      //    `onDelete: 'restrict'`，留着任何一行都会把下面那句顶回来。
      //    到这里能走过前置检查，说明剩下的全是已清理的墓碑行（见
      //    `deleteByProjectSync` 的注释：卷的生命周期本身在 `audit_events` 里）。
      this.volumes.deleteByProjectSync(tx, asProjectId(id));
      this.repo.deleteSync(tx, asProjectId(id));
      this.events.publishInTx(tx, project.pullEvents());
    });
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
    // `PROJECT_NOT_FOUND` (10 §6.8) rather than the filter's generic `NOT_FOUND`:
    // the id in the message is a UUID nobody can act on, so the frontend renders
    // its own sentence and needs a code to select it by.
    if (!project) {
      throw new NotFoundException({
        code: 'PROJECT_NOT_FOUND',
        message: `project ${id} not found`,
        retryable: false,
        sideEffectFree: true,
      });
    }
    return project;
  }

  private persist(project: Project): void {
    this.uow.run((tx) => {
      this.repo.saveSync(tx, project);
      this.events.publishInTx(tx, project.pullEvents());
    });
  }

  /** 只投递事件、不写行 —— 给「聚合状态没变但确实发生了一件事」的路径用（cancel-clone）。 */
  private publish(project: Project): void {
    this.uow.run((tx) => this.events.publishInTx(tx, project.pullEvents()));
  }

  /**
   * 还在占盘的保留成果 ⇒ 拒绝删项目（409 `INVALID_STATE`）。
   *
   * ⛔ **不级联删除**：保留成果是用户**明确选择留下**的产物，销毁它必须是一次单独的、
   * 他自己按下的动作。把它折进「删项目」里，用户点一次就永久失去了两样东西，
   * 而他只打算失去一样。
   *
   * ⚠️ 文案里给出**去哪儿清**，不只说「删不掉」——与镜像那条「请改为点 [禁用]」同姿态
   * （P22 §1：拒绝必须带下一步，否则用户卡死在这里）。
   *
   * ⚠️ 只数 `deletedAt === null` 的。已清理的那些是审计留档，不该拦任何人。
   */
  private async assertNoLiveRetainedVolumes(id: string): Promise<void> {
    const live = (await this.volumes.listByProject(asProjectId(id))).filter(
      (v) => v.deletedAt === null,
    );
    if (live.length === 0) return;
    throw new ProjectStateError(
      `这个项目下还有 ${String(live.length)} 份保留成果没清理，删掉项目会让它们再也找不到归属；` +
        '请先到「保留成果」里逐份清理，或等它们到期自动回收，然后再删项目。',
    );
  }

  private mapDomainError(e: unknown): unknown {
    if (e instanceof InvalidRepoUrlError) {
      return new BadRequestException({
        code: 'INVALID_REPO_URL',
        message: e.message,
        retryable: false,
        sideEffectFree: true,
      });
    }
    // ⚠️ Stays `INVALID_STATE` (409) on purpose — 10 §6.8 already names that code for
    // exactly this set (sync on non-ready / convert-to-empty & retry-clone on
    // non-failed) and the CALLER always knows which action it invoked, so one code
    // plus the call site is enough to pick the right sentence. Minting three more
    // codes would buy nothing the caller does not already know.
    if (e instanceof ProjectStateError) {
      return new ConflictException({
        code: 'INVALID_STATE',
        message: e.message,
        retryable: false,
        sideEffectFree: true,
      });
    }
    // A failed `git fetch --all` is the remote's answer, not a platform bug, so it keeps
    // its CLONE taxonomy code (03 §7.5). That is deliberate reuse: the frontend already
    // branches on these exact codes for a failed clone — PERMISSION ⇒ [配置 Git 凭证],
    // NETWORK ⇒ [重试] — and a sync failing for the same reason should not need a second
    // vocabulary. `retryable` comes from 03 §7.5's own column, not from the status code.
    if (e instanceof CloneError) return new HttpException(fetchEnvelope(e), FETCH_STATUS[e.code]);
    return e;
  }
}
