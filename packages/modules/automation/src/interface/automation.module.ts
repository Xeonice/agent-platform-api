import { Module } from '@nestjs/common';
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
 * ⚠️ **不是 `@Global`**（与 project/sandbox/runtime 那几个相反）：没有任何别的上下文
 * 依赖 automation。它自己需要的三个跨上下文口（`AUTOMATION_TASK_LAUNCHER` /
 * `RUNTIME_CREDENTIAL_STATE_READER` / `ACCESS_GATE_READER`）由那三个 @Global 模块提供，
 * 方向是**单向进来**的 —— 所以本模块必须装配在它们**之后**（见 `app.module.ts`）。
 *
 * ⛔ **没有 MCP 壳**（27 §11.3「automation 全部（11 个）」不进 MCP）。
 */
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
  ],
  exports: [AutomationApplicationService, AutomationScheduler],
})
export class AutomationModule {}
