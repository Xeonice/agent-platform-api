// Public surface of the image context consumed by the app assembly and by the
// sandbox context's migration-level foreign key.
export { ImageModule } from './interface/image.module';
export { ImageApplicationService } from './application/image-application.service';
export { ImageFacadeAdapter } from './application/image-facade.adapter';
export { OciImageSpecProvider } from './infrastructure/spec/oci-image-spec.provider';
// exported for the e2e doubles: they need a REAL digest from whichever registry the
// ref names, because the provider now pulls `ref@digest` (04 §7 时刻④).
export { OciRegistryClient } from './infrastructure/spec/oci-registry.client';
export { DefaultImageSpecRegistry } from './infrastructure/registry/image-spec.registry';
export { images, imageManifests } from './infrastructure/persistence/schema/image.sqlite';
export { EnvVarSet } from './domain/value-objects/env-var-set.vo';
export { mergeEnv } from './domain/services/env-merge.domain-service';
export type { MergedEnv, EnvSource } from './domain/services/env-merge.domain-service';
// 领域事件类 —— 供平台级 `AuditProjector` 判别（理由见 image-events.ts 顶部注释）。
export {
  ImageRegistered,
  ImageValidated,
  ImageActivated,
  ImageDeactivated,
  ImageConfigUpdated,
  ImageDeleted,
} from './domain/events/image-events';
