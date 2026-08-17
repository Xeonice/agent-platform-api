// Public surface of the project context consumed by the app assembly.
export { ProjectModule } from './interface/project.module';
export { ProjectApplicationService } from './application/project-application.service';
export { ProjectMcpTools } from './interface/mcp/project.mcp-tools';
export { projects } from './infrastructure/persistence/schema/project.sqlite';
export { CloneStatusVO } from './domain/value-objects/project-status.vo';
export type { CloneStatus } from './domain/value-objects/project-status.vo';
