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
