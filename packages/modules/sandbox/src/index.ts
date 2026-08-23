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
