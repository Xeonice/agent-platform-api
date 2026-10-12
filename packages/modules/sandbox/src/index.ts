// Public surface of the sandbox context consumed by the app assembly.
export { SandboxModule } from './interface/sandbox.module';
export {
  SANDBOX_CREATE_INTENTS,
  type SandboxCreateIntents,
  type SandboxCreateIntent,
} from './domain/ports/sandbox-create-intents.port';
export { SqliteSandboxCreateIntents } from './infrastructure/persistence/sqlite/sandbox-create-intents.impl';
export { SandboxApplicationService } from './application/sandbox-application.service';
export { SandboxFacadeAdapter } from './application/sandbox-facade.adapter';
export {
  SANDBOX_ADMISSION_INTENTS,
  type SandboxAdmissionIntents,
} from './domain/ports/sandbox-admission-intents.port';
export { SqliteSandboxAdmissionIntents } from './infrastructure/persistence/sqlite/sandbox-admission-intents.impl';
export {
  JOB_COMPLETION_RECEIPTS,
  type JobCompletionReceipt,
  type JobCompletionReceipts,
} from './domain/ports/job-completion-receipts.port';
export {
  SqliteJobCompletionReceipts,
  completedJobHandleDigest,
  jobCompletionEvidenceDigest,
} from './infrastructure/persistence/sqlite/job-completion-receipts.impl';
export { AgentTaskApplicationService } from './application/agent-task.service';
export { RunAgentTaskWorkflow } from './application/workflows/run-agent-task.workflow';
export { ProvisionSandboxWorkflow } from './application/workflows/provision-sandbox.workflow';
export { TasksGateway } from './interface/gateway/tasks.gateway';
export { SandboxMcpTools } from './interface/mcp/sandbox.mcp-tools';
export {
  sandboxes,
  sandboxStateTransitions,
} from './infrastructure/persistence/schema/sandbox.sqlite';
export { agentTasks } from './infrastructure/persistence/schema/agent-task.sqlite';
export { assertBoxliteSdkAvailable } from './infrastructure/providers/boxlite/boxlite-runtime';
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

// 共享的 dockerode 客户端 token —— 平台层的「预制镜像搬运」要用同一个客户端。
// ⚠️ **导出的是 token 不是实现**：让 platform 复用 SandboxModule 已经绑好的那一个，
//    而不是自己再 new 一个 —— 两个客户端 = 两份 env 解读，迟早出现「沙箱连得上 docker、
//    搬运连不上」这种谁都没错的组合。
export { DOCKER_CLIENT } from './infrastructure/providers/docker/docker.token';
export { RuntimeOwnerServer } from './infrastructure/runtime-rpc/owner-server';
export {
  RuntimeOwnerProviderRegistry,
  RuntimeOwnerConnection,
  RuntimeOwnerProcessStream,
} from './infrastructure/runtime-rpc/owner-client';
export {
  startRuntimeOwnerFromEnvironment,
  createRuntimeOwnerProviderRegistry,
} from './infrastructure/runtime-rpc/owner-factory';
export { withRuntimeBusinessAuthority } from './infrastructure/runtime-rpc/authority-context';
