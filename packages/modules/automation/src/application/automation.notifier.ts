import { Inject, Injectable, Logger } from '@nestjs/common';
import { UNIT_OF_WORK } from '@platform/shared-kernel';
import type { UnitOfWork } from '@platform/shared-kernel';
import { ProjectApplicationService } from '@platform/project';
import { AUTOMATION_RUN_REPOSITORY } from '../domain/repositories/automation-run.repository';
import type { AutomationRunRepository } from '../domain/repositories/automation-run.repository';
import { WEBHOOK_SENDER } from '../domain/ports/webhook-sender.port';
import type { WebhookPayload, WebhookSender } from '../domain/ports/webhook-sender.port';
import { AUTOMATION_RUN_LOG_READER } from '../domain/ports/run-log-reader.port';
import type { RunLogReader } from '../domain/ports/run-log-reader.port';
import type { Automation } from '../domain/entities/automation.entity';
import type { AutomationRun } from '../domain/entities/automation-run.entity';
import type { RunOutcome } from '../domain/value-objects/webhook-target.vo';

/** `automation_runs.output_summary` = stdout **末尾 1KB**（13 §2.7.2）。 */
const SUMMARY_BYTES = 1024;

/**
 * webhook 投递的编排（03 §8.5「触发点」行）。
 *
 * 三个触发点，一个都不能少：
 *   ① run 进入终态时按 `triggerOn` 匹配；
 *   ② **降频与自动禁用**也各发一条（P21-7 §5 明确要求）；
 *   ③ 凭证过期导致的跳过（03 §8.2 行 2「跳过 + 横幅 + webhook」）。
 *
 * ⚠️ **全部方法都不抛，也都不参与调用方的事务。** 投递失败绝不影响 run 本身的状态
 * （通知是旁路）；`webhook_status` 是终态记录里**唯一**允许后置补写的字段
 * （I-AUR-3），所以它是投递完之后单独写的一笔。
 */
@Injectable()
export class AutomationNotifier {
  private readonly logger = new Logger('AutomationNotifier');
  /** 已经为哪些规则发过「降频/禁用」通知 —— 避免每轮重发（进程内即可，重启重发一次无害）。 */
  private readonly announced = new Map<string, string>();

  constructor(
    @Inject(WEBHOOK_SENDER) private readonly sender: WebhookSender,
    @Inject(AUTOMATION_RUN_REPOSITORY) private readonly runs: AutomationRunRepository,
    @Inject(AUTOMATION_RUN_LOG_READER) private readonly logs: RunLogReader,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    private readonly projects: ProjectApplicationService,
  ) {}

  /** stdout 末尾 1KB —— 列表快速预览（13 §2.7.2）。读不到就不给，不编。 */
  async summarize(logPath: string | null): Promise<string | undefined> {
    if (logPath === null) return undefined;
    try {
      const slice = await this.logs.read(logPath, undefined, SUMMARY_BYTES);
      return slice.content === '' ? undefined : slice.content;
    } catch {
      return undefined;
    }
  }

  /** ① run 终态。 */
  async afterRunFinished(automation: Automation, run: AutomationRun): Promise<void> {
    const outcome = toOutcome(run.status);
    if (outcome === null) return;
    const target = automation.webhook;
    // I-AUT-6：`webhook` 为空**根本不发**（不是发一条被过滤的）。
    if (target === null) return;
    if (!target.matches(outcome)) {
      this.persistStatus(run.id, 'skipped');
      return;
    }
    const payload = await this.payload(automation, run, `run.${run.status}`);
    const result = await this.sender.deliver(target.url, payload);
    this.persistStatus(run.id, result);
  }

  /** ③ 凭证过期跳过（03 §8.2 行 2）。 */
  async afterAuthExpired(automation: Automation, run: AutomationRun): Promise<void> {
    const target = automation.webhook;
    if (target === null) return;
    // ⚠️ **不过 `triggerOn` 匹配**：这条不是「运行结果」，它是「这条规则从现在起
    // 跑不了了」。用 `triggerOn='success'` 把它过滤掉，等于让一个只关心成功通知的人
    // 永远不知道自己的凭证过期了。
    const payload = await this.payload(automation, run, 'auth.expired');
    const result = await this.sender.deliver(target.url, payload);
    this.persistStatus(run.id, result);
  }

  /** ② 降频与自动禁用（P21-7 §5）。 */
  async afterStateChange(automation: Automation): Promise<void> {
    const target = automation.webhook;
    if (target === null) return;
    const state = !automation.enabled
      ? 'automation.disabled'
      : automation.degraded
        ? 'automation.degraded'
        : null;
    if (state === null) {
      this.announced.delete(automation.id);
      return;
    }
    if (this.announced.get(automation.id) === state) return;
    this.announced.set(automation.id, state);
    const project = await this.projectName(automation.projectId);
    await this.sender.deliver(target.url, {
      event: state,
      automationId: automation.id,
      automationName: automation.name,
      projectId: automation.projectId,
      projectName: project,
      runtimeId: automation.runtimeId,
      triggeredAt: (automation.lastTriggeredAt ?? automation.updatedAt).toISOString(),
      status: state === 'automation.disabled' ? 'disabled' : 'degraded',
      errorMessage: `consecutive failures: ${String(automation.failureCount)}`,
    });
  }

  private async payload(
    automation: Automation,
    run: AutomationRun,
    event: string,
  ): Promise<WebhookPayload> {
    const base: WebhookPayload = {
      event,
      automationId: automation.id,
      automationName: automation.name,
      projectId: automation.projectId,
      projectName: await this.projectName(automation.projectId),
      runtimeId: automation.runtimeId,
      triggeredAt: run.triggeredAt.toISOString(),
      status: run.status,
      ...(run.completedAt !== null ? { finishedAt: run.completedAt.toISOString() } : {}),
      ...(run.errorCode !== null ? { errorCode: run.errorCode } : {}),
      ...(run.errorMessage !== null ? { errorMessage: run.errorMessage } : {}),
    };
    const taskUrl = deepLink(run.sandboxId);
    // ⚠️ `publicBaseUrl` 未配置 ⇒ **省略 `taskUrl`**（T-AUT-33），而不是拼出
    // `undefined/?taskId=…`。一条看起来可点的死链比没有链接更糟。
    return taskUrl === undefined ? base : { ...base, taskUrl };
  }

  private async projectName(projectId: string): Promise<string> {
    try {
      return (await this.projects.get(projectId)).name;
    } catch {
      // 项目查不到不该把一条通知拦下来 —— 载荷里 `projectId` 本来就是权威那一个。
      return projectId;
    }
  }

  /**
   * I-AUR-3 的唯一例外：终态 run 上补写 `webhook_status`。
   *
   * **重新从库里取一遍**再写，而不是拿调用方手里那个聚合：投递最坏要 40 秒
   * （10s 超时 + 5s/25s 退避），那期间调用方手里的副本可能已经过时。
   */
  private persistStatus(runId: string, status: 'sent' | 'failed' | 'skipped'): void {
    void this.runs
      .findById(runId)
      .then((fresh) => {
        if (fresh === null) return;
        fresh.recordWebhookStatus(status);
        this.uow.run((tx) => {
          this.runs.saveSync(tx, fresh);
        });
      })
      .catch((e: unknown) => {
        this.logger.warn(`could not record webhook status for run ${runId}: ${String(e)}`);
      });
  }
}

function toOutcome(status: string): RunOutcome | null {
  return status === 'success' || status === 'failed' || status === 'timeout' ? status : null;
}

/**
 * `<publicBaseUrl>/?taskId=<sandboxId>`（P20 §8.3）。
 *
 * ⚠️ **读的是 env，不是 `system_settings`** —— 本轮的取舍，如实记在这里：
 * `publicBaseUrl` 的权威落点是 `system_settings`（10 §7.3 `SystemSettingsDto`），
 * 而那张表住在 `apps/api` 的平台层，automation 这个 package 够不到它，为它再开一个
 * contracts 端口是这一期不划算的一笔。env 缺席 ⇒ 省略字段，与 T-AUT-33 要求的行为
 * **完全一致**；差别只在「配置从哪儿读」。已在报告里登记为待收口项。
 */
function deepLink(sandboxId: string | null): string | undefined {
  const base = process.env.PUBLIC_BASE_URL;
  if (base === undefined || base === '' || sandboxId === null) return undefined;
  return `${base.replace(/\/+$/, '')}/?taskId=${sandboxId}`;
}
