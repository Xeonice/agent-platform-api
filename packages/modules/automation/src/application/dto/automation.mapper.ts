import type { AutomationDto, AutomationRunDto } from '@platform/contracts';
import type { Automation } from '../../domain/entities/automation.entity';
import type { AutomationRun } from '../../domain/entities/automation-run.entity';
import type { RetentionDays } from '../../domain/value-objects/policies.vo';
import type { TimeoutMinutes } from '../../domain/value-objects/policies.vo';

/**
 * 聚合 → 线上 DTO（10 §7.3）。
 *
 * ⚠️ **可空字段一律「缺席」而不是 `null`**：10 §7.3 的形状用的是 `?:`，而 `null` 在
 * `exactOptionalPropertyTypes` 之外的 TS 里会被 JSON 原样带出去，前端的 `??` 兜底就
 * 全都失效（`null ?? x` 给 x，但 `hasOwnProperty` 为真的 `null` 会让「有没有这个字段」
 * 的判断答错）。
 */
export const AutomationMapper = {
  toDto(a: Automation): AutomationDto {
    return {
      id: a.id,
      projectId: a.projectId,
      name: a.name,
      ...(a.description !== null ? { description: a.description } : {}),
      runtime: a.runtimeId,
      prompt: a.prompt,
      scheduleKind: a.schedule.kind,
      scheduleConfig: a.schedule.config,
      timezone: a.schedule.timezone,
      timeoutMinutes: a.timeoutMinutes as TimeoutMinutes,
      artifactRetentionDays: a.retentionDays as RetentionDays,
      ...(a.webhook !== null ? { webhookUrl: a.webhook.url } : {}),
      triggerOn: a.webhook?.triggerOn ?? 'failure',
      enabled: a.enabled,
      degraded: a.degraded,
      consecutiveFailures: a.failureCount,
      ...(a.lastTriggeredAt !== null ? { lastTriggeredAt: a.lastTriggeredAt.toISOString() } : {}),
      ...(a.nextTriggerAt !== null ? { nextTriggerAt: a.nextTriggerAt.toISOString() } : {}),
      createdAt: a.createdAt.toISOString(),
      updatedAt: a.updatedAt.toISOString(),
    };
  },

  runToDto(r: AutomationRun): AutomationRunDto {
    return {
      id: r.id,
      automationId: r.automationId,
      ...(r.sandboxId !== null ? { sandboxId: r.sandboxId } : {}),
      status: r.status,
      ...(r.errorCode !== null ? { errorCode: r.errorCode } : {}),
      ...(r.errorMessage !== null ? { errorMessage: r.errorMessage } : {}),
      retryCount: r.retryCount,
      ...(r.retryAt !== null ? { retryAt: r.retryAt.toISOString() } : {}),
      triggeredAt: r.triggeredAt.toISOString(),
      ...(r.startedAt !== null ? { startedAt: r.startedAt.toISOString() } : {}),
      ...(r.completedAt !== null ? { completedAt: r.completedAt.toISOString() } : {}),
      // 库里存的是秒（13 §2.7.2 `duration_sec`），线上给毫秒（10 §7.3 `durationMs`）。
      // 两处口径不同是既有事实，转换只此一处 —— 散在调用点上迟早出现一个差 1000 倍的数。
      ...(r.durationSec !== null ? { durationMs: r.durationSec * 1000 } : {}),
      ...(r.outputSummary !== null ? { outputSummary: r.outputSummary } : {}),
      ...(r.webhookStatus !== null ? { webhookStatus: r.webhookStatus } : {}),
    };
  },
};
