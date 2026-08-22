// Public surface of the runtime context consumed by the app assembly.
export { RuntimeModule } from './interface/runtime.module';
export { RuntimeApplicationService } from './application/runtime-application.service';
export {
  runtimeSettings,
  runtimeInstallations,
} from './infrastructure/persistence/schema/runtime.sqlite';
