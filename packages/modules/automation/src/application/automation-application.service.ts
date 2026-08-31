import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  CLOCK,
  EVENT_BUS,
  ID_GENERATOR,
  UNIT_OF_WORK,
  asAutomationId,
  asProjectId,
} from '@platform/shared-kernel';
import type { Clock, EventBus, IdGenerator, UnitOfWork } from '@platform/shared-kernel';
import {
  AUDIT_RECORDER,
  AUTOMATION_LIMIT_REACHED,
  AUTOMATION_PER_PROJECT_LIMIT,
} from '@platform/contracts';
import type {
  AuditRecorder,
  AutomationDto,
  AutomationRunDto,
  CreateAutomationInput,
  PaginatedAutomationRuns,
  UpdateAutomationInput,
  WebhookTestResult,
} from '@platform/contracts';
import { ProjectApplicationService } from '@platform/project';
import { Automation } from '../domain/entities/automation.entity';
import { AUTOMATION_REPOSITORY } from '../domain/repositories/automation.repository';
import type { AutomationRepository } from '../domain/repositories/automation.repository';
import { AUTOMATION_RUN_REPOSITORY } from '../domain/repositories/automation-run.repository';
import type { AutomationRunRepository } from '../domain/repositories/automation-run.repository';
import { WEBHOOK_SENDER } from '../domain/ports/webhook-sender.port';
import type { WebhookSender } from '../domain/ports/webhook-sender.port';
import { AutomationInvariantError, AutomationLimitError } from '../domain/errors/automation-errors';
import { AUTOMATION_RUN_LOG_READER } from '../domain/ports/run-log-reader.port';
import type { RunLogSlice, RunLogReader } from '../domain/ports/run-log-reader.port';
import { AutomationMapper } from './dto/automation.mapper';

/** `GET .../runs` 的默认页大小（27 §10「运行历史：分页 20」）。 */
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

/** `GET .../runs/:runId/logs` 默认回末尾 64KB（03 §8.6）。 */
const DEFAULT_LOG_WINDOW = 64 * 1024;
const MAX_LOG_WINDOW = 1024 * 1024;

/**
 * automation 的 CRUD 与查询面（27 §8 的 11 个端点里的 10 个；第 11 个
 * `webhook-test` 也在这里，因为它属于同一张表单）。
 *
 * **协议无关**（02 §1）：REST 控制器注入的就是它。automation 不进 MCP（27 §11.3），
 * 所以这里没有第二层壳。
 */
@Injectable()
export class AutomationApplicationService {
  constructor(
    @Inject(AUTOMATION_REPOSITORY) private readonly repo: AutomationRepository,
    @Inject(AUTOMATION_RUN_REPOSITORY) private readonly runs: AutomationRunRepository,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(EVENT_BUS) private readonly events: EventBus,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
    @Inject(AUDIT_RECORDER) private readonly audit: AuditRecorder,
    @Inject(WEBHOOK_SENDER) private readonly webhooks: WebhookSender,
    @Inject(AUTOMATION_RUN_LOG_READER) private readonly logs: RunLogReader,
    private readonly projects: ProjectApplicationService,
  ) {}

  /** `GET /api/projects/:id/automations`。 */
  async listByProject(projectId: string): Promise<AutomationDto[]> {
    const rules = await this.repo.listByProject(asProjectId(projectId));
    return rules.map((r) => AutomationMapper.toDto(r));
  }

  /**
   * `POST /api/projects/:id/automations`。
   *
   * ⚠️ **项目必须先存在**（`automations.project_id` 是 FK RESTRICT，13 §2.7.4）。
   * 这里主动查一次而不是让 SQLite 的外键约束去炸：约束异常出线是 500 + 一句
   * `FOREIGN KEY constraint failed`，而用户要的是 404「没有这个项目」。
   */
  async create(projectId: string, input: CreateAutomationInput): Promise<AutomationDto> {
    await this.requireProject(projectId);
    const pid = asProjectId(projectId);

    // I-AUT-7 的 application 那一半（23 §4.6 第三类：跨聚合计数，DB 表达不了）。
    const existing = await this.repo.countByProject(pid);
    if (existing >= AUTOMATION_PER_PROJECT_LIMIT) {
      throw this.limitReached(existing);
    }

    const now = this.clock.now();
    const automation = this.build(() =>
      Automation.create({
        id: asAutomationId(this.ids.next()),
        projectId: pid,
        name: input.name,
        description: input.description,
        runtimeId: input.runtime,
        prompt: input.prompt,
        scheduleKind: input.scheduleKind,
        scheduleConfig: input.scheduleConfig,
        timezone: input.timezone,
        timeoutMinutes: input.timeoutMinutes,
        artifactRetentionDays: input.artifactRetentionDays,
        webhookUrl: input.webhookUrl,
        triggerOn: input.triggerOn,
        now,
      }),
    );

    this.uow.run((tx) => {
      this.repo.saveSync(tx, automation);
    });
    this.audit.record({
      category: 'project',
      type: 'automation.created',
      actor: 'user',
      subjectType: 'automation',
      subjectId: automation.id,
      summary: `创建了自动化规则「${automation.name}」`,
      detail: {
        projectId,
        scheduleKind: automation.schedule.kind,
        timezone: automation.schedule.timezone,
        runtimeId: automation.runtimeId,
      },
      outcome: 'ok',
    });
    return AutomationMapper.toDto(automation);
  }

  /** `GET /api/automations/:id`。 */
  async get(id: string): Promise<AutomationDto> {
    return AutomationMapper.toDto(await this.require(id));
  }

  /**
   * `PUT /api/automations/:id`。
   *
   * ★ **`timezone` 缺席 ⇒ 原样保留**（I-AUT-9 / T-AUT-7）。这条不变量真正的落点在
   * `Automation.update()` 的签名上；这里只是把它原封不动地传下去 —— 特别是**不做**
   * 「拿旧值填满整个 patch 再传」那种看似无害的归一化，那会把「缺席」和「显式传了同一个
   * 值」抹成一样，`scheduleTouched` 随之恒为真，改个 prompt 就会重算触发时刻。
   */
  async update(id: string, patch: UpdateAutomationInput): Promise<AutomationDto> {
    const automation = await this.require(id);
    const now = this.clock.now();
    this.build(() => {
      automation.update(
        {
          name: patch.name,
          description: patch.description,
          runtimeId: patch.runtime,
          prompt: patch.prompt,
          scheduleKind: patch.scheduleKind,
          scheduleConfig: patch.scheduleConfig,
          timezone: patch.timezone,
          timeoutMinutes: patch.timeoutMinutes,
          artifactRetentionDays: patch.artifactRetentionDays,
          webhookUrl: patch.webhookUrl,
          triggerOn: patch.triggerOn,
        },
        now,
      );
      return automation;
    });
    this.uow.run((tx) => {
      this.repo.saveSync(tx, automation);
    });
    return AutomationMapper.toDto(automation);
  }

  /** `DELETE /api/automations/:id` —— 204。运行历史随 FK CASCADE 一起走。 */
  async remove(id: string): Promise<void> {
    const automation = await this.require(id);
    this.uow.run((tx) => {
      this.repo.deleteSync(tx, automation.id);
    });
    this.audit.record({
      category: 'project',
      type: 'automation.deleted',
      actor: 'user',
      subjectType: 'automation',
      subjectId: automation.id,
      summary: `删除了自动化规则「${automation.name}」`,
      detail: { projectId: automation.projectId },
      outcome: 'ok',
    });
  }

  /**
   * `POST /api/automations/:id/enable` —— **动作而非字段更新**（02 §5.1 的判据）。
   * I-AUT-4：必须同时清零 `consecutiveFailures` 与 `degraded`。
   */
  async enable(id: string): Promise<AutomationDto> {
    const automation = await this.require(id);
    automation.enable(this.clock.now());
    // `AutomationReenabled` 与写入**同一个事务**（R-3 / 28 §7.3 的 Outbox 纪律）：
    // 事件不是「顺手也发一下」，它和那次状态变更要么一起在，要么一起不在。
    this.uow.run((tx) => {
      this.repo.saveSync(tx, automation);
      this.events.publishInTx(tx, automation.pullEvents());
    });
    this.audit.record({
      category: 'project',
      type: 'automation.enabled',
      actor: 'user',
      subjectType: 'automation',
      subjectId: automation.id,
      summary: `重新启用了自动化规则「${automation.name}」（失败计数与降频态已清零）`,
      detail: { projectId: automation.projectId },
      outcome: 'ok',
    });
    return AutomationMapper.toDto(automation);
  }

  /** `POST /api/automations/:id/disable`。 */
  async disable(id: string): Promise<AutomationDto> {
    const automation = await this.require(id);
    automation.disable(this.clock.now());
    this.uow.run((tx) => {
      this.repo.saveSync(tx, automation);
    });
    this.audit.record({
      category: 'project',
      type: 'automation.disabled',
      actor: 'user',
      subjectType: 'automation',
      subjectId: automation.id,
      summary: `停用了自动化规则「${automation.name}」`,
      detail: { projectId: automation.projectId },
      outcome: 'ok',
    });
    return AutomationMapper.toDto(automation);
  }

  /**
   * `GET /api/automations/:id/runs?before=&limit=` —— **游标信封**（与审计流同形）。
   *
   * ⚠️ 上一版是 `?page=&pageSize=` 的 offset 分页，在**头部追加**的运行历史上是错的：
   * 翻页期间新落 run 会让下一页重复上一页尾部，**而且看起来完全正常**
   * （`useAuditStream` 文件头纪律 ① 点名的就是这里）。
   */
  async listRuns(id: string, before?: string, limit?: number): Promise<PaginatedAutomationRuns> {
    const automation = await this.require(id);
    const size = clamp(limit ?? DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE);
    const slice = await this.runs.listByAutomation(automation.id, {
      ...(before === undefined ? {} : { before }),
      limit: size,
    });
    return {
      items: slice.items.map((r) => AutomationMapper.runToDto(r)),
      hasMore: slice.hasMore,
    };
  }


  /** `GET /api/automations/runs/:runId`。 */
  async getRun(runId: string): Promise<AutomationRunDto> {
    return AutomationMapper.runToDto(await this.requireRun(runId));
  }

  /**
   * `GET /api/automations/runs/:runId/logs?offset=&limit=` —— 分页字节区间，
   * **默认回末尾 64KB**（03 §8.6）。
   */
  async readRunLogs(runId: string, offset?: number, limit?: number): Promise<RunLogSlice> {
    const run = await this.requireRun(runId);
    if (run.logPath === null) {
      // 还没有日志（skipped / missed / 还没跑起来）——空片而不是 404：run 存在，
      // 只是这一刻它没有正文。404 会让前端把「还没输出」渲染成「记录不存在」。
      return { content: '', offset: 0, totalBytes: 0, eof: true };
    }
    const window = clamp(limit ?? DEFAULT_LOG_WINDOW, 1, MAX_LOG_WINDOW);
    return this.logs.read(run.logPath, offset, window);
  }

  /**
   * `POST /api/automations/webhook-test` —— 发一条 `event:'test'` 的样例载荷，
   * 同样的 10s 超时与 SSRF 规则（03 §8.5 表格最后一行）。
   */
  test(url: string): Promise<WebhookTestResult> {
    return this.webhooks.test(url);
  }

  private async require(id: string): Promise<Automation> {
    const found = await this.repo.findById(asAutomationId(id));
    if (!found) throw new NotFoundException(`automation ${id} not found`);
    return found;
  }

  private async requireRun(runId: string) {
    const run = await this.runs.findById(runId);
    if (!run) throw new NotFoundException(`automation run ${runId} not found`);
    return run;
  }

  private async requireProject(projectId: string): Promise<void> {
    try {
      await this.projects.get(projectId);
    } catch {
      throw new NotFoundException(`project ${projectId} not found`);
    }
  }

  /**
   * 把领域不变量的违反翻译成 HTTP。
   *
   * ⚠️ `AutomationInvariantError` → **400 而不是 409**：非法时区、prompt 超长、
   * timeout 不在四档里，全都是「请求内容不对」（10 §6.8 的 A 类），用户要做的是就地
   * 改表单。超上限是 C 类（`AutomationLimitError`），出路完全不同 —— 先删一条。
   */
  private build<T>(fn: () => T): T {
    try {
      return fn();
    } catch (e) {
      if (e instanceof AutomationInvariantError) {
        throw new BadRequestException({
          code: 'VALIDATION_FAILED',
          message: e.message,
          retryable: false,
          sideEffectFree: true,
        });
      }
      if (e instanceof AutomationLimitError) throw this.limitReached(AUTOMATION_PER_PROJECT_LIMIT);
      throw e;
    }
  }

  private limitReached(existing: number): ConflictException {
    return new ConflictException({
      code: AUTOMATION_LIMIT_REACHED,
      message:
        `this project already has ${String(existing)} automation rules, the limit is ` +
        `${String(AUTOMATION_PER_PROJECT_LIMIT)} (I-AUT-7). Delete one before adding another.`,
      retryable: false,
      sideEffectFree: true,
    });
  }
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(Math.max(Math.trunc(v), min), max);
}
