import { Global, Module } from '@nestjs/common';
import { IMAGE_FACADE, IMAGE_SPEC_REGISTRY } from '@platform/contracts';
import { IMAGE_REPOSITORY } from '../domain/repositories/image.repository';
import { IMAGE_MANIFEST_REPOSITORY } from '../domain/repositories/image-manifest.repository';
import { ENV_SECRET_CIPHER } from '../domain/ports/env-secret.cipher.port';
import { ImageSeeder } from '../application/image-seeder';
import { ImageApplicationService } from '../application/image-application.service';
import { ImageFacadeAdapter } from '../application/image-facade.adapter';
import { SqliteImageRepository } from '../infrastructure/persistence/sqlite/image.repository.impl';
import { SqliteImageManifestRepository } from '../infrastructure/persistence/sqlite/image-manifest.repository.impl';
import { DefaultImageSpecRegistry } from '../infrastructure/registry/image-spec.registry';
import { OciImageSpecProvider } from '../infrastructure/spec/oci-image-spec.provider';
import { AesGcmEnvSecretCipher } from '../infrastructure/crypto/env-secret.cipher';
import { ImageController } from './http/image.controller';

/**
 * Composition root for the image context (01) — the ONE place ports are bound.
 *
 * `@Global` + an exported `IMAGE_FACADE` is what lets the sandbox context enforce
 * I-IMG-2 / I-IMG-3 at the create door and read the frozen digest at provision
 * without a package cycle (mirrors PROJECT_FACADE / CREDENTIAL_FACADE).
 *
 * `IMAGE_SPEC_REGISTRY` is EXPORTED for the same reason the other two registries are
 * (04 §8 方式一): an out-of-tree module can inject the token and `register()` its own
 * `ImageSpecProvider` from `onModuleInit` without this file being edited. Until this
 * slice the token was a bare Symbol with no interface, no implementation and no
 * binding — 「provider / runtime / 镜像三层可注册」 was two thirds true.
 */
@Global()
@Module({
  controllers: [ImageController],
  providers: [
    ImageApplicationService,
    ImageSeeder,
    ImageFacadeAdapter,
    OciImageSpecProvider,
    { provide: IMAGE_REPOSITORY, useClass: SqliteImageRepository },
    { provide: IMAGE_MANIFEST_REPOSITORY, useClass: SqliteImageManifestRepository },
    { provide: IMAGE_SPEC_REGISTRY, useClass: DefaultImageSpecRegistry },
    { provide: ENV_SECRET_CIPHER, useClass: AesGcmEnvSecretCipher },
    { provide: IMAGE_FACADE, useExisting: ImageFacadeAdapter },
  ],
  // ⚠️ `ImageSeeder` 导出给平台层的「预制镜像搬运」：推完之后要就地再播一次种，
  //    否则链条只是从第 2 步挪到第 4 步（`PresetImageProvisioner.ImageSeedPort`）。
  exports: [ImageApplicationService, IMAGE_FACADE, IMAGE_SPEC_REGISTRY, ImageSeeder],
})
export class ImageModule {}
