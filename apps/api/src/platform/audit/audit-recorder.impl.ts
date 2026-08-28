import { Inject, Injectable, Logger } from '@nestjs/common';
import { CLOCK } from '@platform/shared-kernel';
import type { Clock } from '@platform/shared-kernel';
import type { AuditRecorder, AuditRecordInput } from '@platform/contracts';
import { AuditRepository } from './audit.repository';
import { redactAuditDetail, redactAuditText } from './audit-redaction';

/**
 * `AuditRecorder` 的落库实现 —— 审计流的**写入口**，两个入口（projector / 应用层
 * 显式）最终都从这里过，脱敏因此只有一处（13 §2.8.2「脱敏在写入口」）。
 *
 * ⚠️ **它吞掉自己的所有异常。** 审计是观察设施不是账本（P21-5 §10.5：「审计写入永不
 * 阻断业务」）。一次 CHECK 违反、一次磁盘满，都不该把用户正在做的事推翻 —— 极小概率
 * 「操作成功但没记上」是**已经登记在案**的代价（13 §2.8.2 的「已知丢失窗口」同源）。
 *
 * ⚠️ 但**不是静默**：吞掉的同时打一条 `Logger.error`。写不进去而没人知道，等于把
 * 「审计流是空的」和「什么都没发生」混成一件事。
 */
@Injectable()
export class DbAuditRecorder implements AuditRecorder {
  private readonly logger = new Logger('AuditRecorder');

  constructor(
    private readonly repo: AuditRepository,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  record(input: AuditRecordInput): void {
    try {
      this.repo.insert({
        at: this.clock.now(),
        category: input.category,
        type: input.type,
        severity: input.severity ?? 'info',
        subjectType: input.subjectType ?? null,
        subjectId: input.subjectId ?? null,
        actor: input.actor,
        summary: redactAuditText(input.summary),
        detail: redactAuditDetail(input.detail) ?? null,
        durationMs: input.durationMs ?? null,
        outcome: input.outcome ?? null,
        errorCode: input.errorCode ?? null,
      });
    } catch (e) {
      this.logger.error(
        `audit write dropped (${input.category}/${input.type}): ${(e as Error).message}`,
      );
    }
  }
}
