// Public surface of the project context consumed by the app assembly.
export { ProjectModule } from './interface/project.module';
export { ProjectApplicationService } from './application/project-application.service';
export { ProjectMcpTools } from './interface/mcp/project.mcp-tools';
export { projects } from './infrastructure/persistence/schema/project.sqlite';
export { CloneStatusVO } from './domain/value-objects/project-status.vo';
export type { CloneStatus } from './domain/value-objects/project-status.vo';
// 领域事件类 —— 供平台级 `AuditProjector` 判别（理由见 sandbox 包同一处注释）。
export {
  ProjectCreated,
  ProjectCloneRetried,
  ProjectConvertedToEmpty,
  ProjectCloneCancelled,
  ProjectBaselineSynced,
  ProjectDeleted,
  VolumeRetained,
} from './domain/events/project-events';
export { RetainedVolumeService } from './application/retained-volume.service';
export { VolumeReaper } from './application/volume.reaper';
export { retainedVolumes } from './infrastructure/persistence/schema/retained-volume.sqlite';
