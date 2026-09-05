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

// 开机播种器 —— 平台层的「预制镜像搬运」推完之后要就地再播一次种。
// ⚠️ **导出它而不是在平台层另写一份注册逻辑**：两份「怎么算注册好了」迟早对不上，
//    而其中一份正是诊断第 4 步的判据。
export { ImageSeeder } from './application/image-seeder';
