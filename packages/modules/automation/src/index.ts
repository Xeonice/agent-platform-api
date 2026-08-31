// Public surface of the automation context consumed by the app assembly.
export { AutomationModule } from './interface/automation.module';
export { AutomationApplicationService } from './application/automation-application.service';
export { AutomationScheduler } from './application/automation.scheduler';
export { automations, automationRuns } from './infrastructure/persistence/schema/automation.sqlite';
// 领域事件类 —— 供平台级 `AuditProjector` 判别（理由见 sandbox 包同一处注释）。
export {
  AutomationTriggered,
  AutomationRunFinished,
  AutomationDegraded,
  AutomationDisabled,
  AutomationReenabled,
} from './domain/events/automation-events';
