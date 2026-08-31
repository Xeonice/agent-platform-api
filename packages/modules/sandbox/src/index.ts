// Public surface of the sandbox context consumed by the app assembly.
export { SandboxModule } from './interface/sandbox.module';
export { SandboxApplicationService } from './application/sandbox-application.service';
export { AgentTaskApplicationService } from './application/agent-task.service';
export { SandboxMcpTools } from './interface/mcp/sandbox.mcp-tools';
export {
  sandboxes,
  sandboxStateTransitions,
} from './infrastructure/persistence/schema/sandbox.sqlite';
export { agentTasks } from './infrastructure/persistence/schema/agent-task.sqlite';
// domain re-export kept minimal; tests import from ./domain via source paths.
export { SandboxStatusVO } from './domain/value-objects/sandbox-status.vo';
export type { SandboxStatus } from './domain/value-objects/sandbox-status.vo';
// 实例身份（回收作用域）：e2e 需要按真实形状造孤儿,故经公共出口暴露。
export {
  INSTANCE_LABEL,
  boxliteNamePrefix,
  platformInstanceId,
} from './infrastructure/reconcile/instance-id';
// 领域事件类 —— **平台级 `AuditProjector` 需要 `instanceof` 判别**（13 §2.8.2 写入
// 入口 ①）。审计 projector 住在 `apps/api/src/platform/audit/`（那张表是平台表，
// 不属于任何限界上下文），只能经公共出口拿到这几个类；靠 `event.type` 字符串比对
// 也能跑，但那样字段被改名时**没有任何东西会红**。
export {
  SandboxCreated,
  SandboxStateChanged,
  SandboxReconciledAsOrphan,
} from './domain/events/sandbox-events';
export { AgentTaskStarted, AgentTaskFinished } from './domain/events/agent-task-events';
