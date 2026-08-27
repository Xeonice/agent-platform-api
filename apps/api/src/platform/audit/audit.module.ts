import { Global, Module } from '@nestjs/common';
import { AUDIT_RECORDER } from '@platform/contracts';
import { AuditController } from './audit.controller';
import { AuditExportService } from './audit-export.service';
import { AuditProjector } from './audit.projector';
import { AuditRepository } from './audit.repository';
import { AuditRetentionJob } from './audit-retention.job';
import { DbAuditRecorder } from './audit-recorder.impl';

/**
 * 平台级审计流的装配（13 §2.8.2）。
 *
 * `@Global()` 是**有意**的，与 `PlatformModule` / `RealtimeModule` 同一档待遇：
 * `AUDIT_RECORDER` 的消费方分散在**各个限界上下文的 application 层**（provision
 * workflow 记阶段耗时、失败路径记失败那一刻），它们不该、也不能为了拿一个平台设施去
 * import `apps/api` 里的 module。
 *
 * 装的四样：
 *   · `AUDIT_RECORDER`     —— 写入口 ②（应用层显式记录），port 在 `@platform/contracts`
 *   · `AuditProjector`     —— 写入口 ①（订阅 EventBus 的 post-commit 批）
 *   · `AuditRetentionJob`  —— 30 天 + 20 万条双闸，分片裁剪
 *   · `AuditController`    —— GET /api/system/audit 与 /audit/export
 */
@Global()
@Module({
  controllers: [AuditController],
  providers: [
    AuditRepository,
    DbAuditRecorder,
    { provide: AUDIT_RECORDER, useExisting: DbAuditRecorder },
    AuditProjector,
    AuditRetentionJob,
    AuditExportService,
  ],
  exports: [AUDIT_RECORDER, AuditRepository, AuditRetentionJob, AuditExportService],
})
export class AuditModule {}
