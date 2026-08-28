// Public surface of the runtime context consumed by the app assembly.
export { RuntimeModule } from './interface/runtime.module';
export { RuntimeApplicationService } from './application/runtime-application.service';
export {
  runtimeSettings,
  runtimeInstallations,
} from './infrastructure/persistence/schema/runtime.sqlite';
// 领域事件类 —— 供平台级 `AuditProjector` 判别（理由见 sandbox 包同一处注释）。
export {
  RuntimeInstallationStateChanged,
  RuntimeAuthModeChanged,
} from './domain/events/runtime-events';
