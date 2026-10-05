import { Global, Module } from '@nestjs/common';
import { AUTOMATION_PROJECT_CLEANUP } from '@platform/contracts';
import { SqliteAutomationProjectCleanup } from '../infrastructure/persistence/sqlite/automation-project-cleanup.adapter';
import { AUTOMATION_REPOSITORY } from '../domain/repositories/automation.repository';
import { AUTOMATION_RUN_REPOSITORY } from '../domain/repositories/automation-run.repository';
import { WEBHOOK_SENDER } from '../domain/ports/webhook-sender.port';
import { AUTOMATION_RUN_LOG_READER } from '../domain/ports/run-log-reader.port';
import { AutomationApplicationService } from '../application/automation-application.service';
import { AutomationScheduler } from '../application/automation.scheduler';
import { AutomationNotifier } from '../application/automation.notifier';
import { SqliteAutomationRepository } from '../infrastructure/persistence/sqlite/automation.repository.impl';
import { SqliteAutomationRunRepository } from '../infrastructure/persistence/sqlite/automation-run.repository.impl';
import { HttpWebhookSender } from '../infrastructure/webhook/http-webhook.sender';
import { FsRunLogReader } from '../infrastructure/logs/fs-run-log.reader';
import { AutomationController } from './http/automation.controller';
import { ProjectAutomationController } from './http/project-automation.controller';

/**
 * Composition root for the automation context (01 §2) —— 端口绑定实现的**唯一**一处。
 *
 * 对外通过全局 AUTOMATION_PROJECT_CLEANUP 端口提供同事务的项目删除能力；
 * project 不导入 automation 模块或其内部表。调度协作者仍由各自上下文提供。
 *
 * automation 不暴露 MCP 壳（27 §11.3）。
 */
@Global()
@Module({
  controllers: [ProjectAutomationController, AutomationController],
  providers: [
    AutomationApplicationService,
    AutomationScheduler,
    AutomationNotifier,
    { provide: AUTOMATION_REPOSITORY, useClass: SqliteAutomationRepository },
    { provide: AUTOMATION_RUN_REPOSITORY, useClass: SqliteAutomationRunRepository },
    { provide: WEBHOOK_SENDER, useClass: HttpWebhookSender },
    { provide: AUTOMATION_RUN_LOG_READER, useClass: FsRunLogReader },
    { provide: AUTOMATION_PROJECT_CLEANUP, useClass: SqliteAutomationProjectCleanup },
  ],
  exports: [AutomationApplicationService, AutomationScheduler, AUTOMATION_PROJECT_CLEANUP],
})
export class AutomationModule {}
