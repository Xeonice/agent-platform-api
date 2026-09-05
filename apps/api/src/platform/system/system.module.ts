import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { SystemController } from './system.controller';
import { SystemSettingsService } from './system-settings.service';
import { InitializationService } from './initialization.service';
import { SystemResourcesService } from './system-resources.service';
import { MEMORY_SOURCES, systemMemorySources } from './memory.probe';
import { SystemProvidersService } from './system-providers.service';
import { ConnectivityProbe } from './diagnostics/connectivity.probe';
import { DiagnosticsService } from './diagnostics/diagnostics.service';
import { DIAGNOSE_CHECKS, type DiagnoseCheck } from './diagnostics/checks/check.types';
import { ContainerRuntimeCheck } from './diagnostics/checks/container-runtime.check';
import { DevKvmCheck } from './diagnostics/checks/dev-kvm.check';
import { DiskSpaceCheck } from './diagnostics/checks/disk-space.check';
import { PortConflictCheck } from './diagnostics/checks/port-conflict.check';
import { OutboundNetworkCheck } from './diagnostics/checks/outbound-network.check';
import { WsLoopbackCheck } from './diagnostics/checks/ws-loopback.check';
import { DataRootFsCheck } from './diagnostics/checks/data-root-fs.check';
import { PresetImageCheck } from './diagnostics/checks/preset-image.check';
import { SANDBOX_PROVIDER_REGISTRY, type ProviderRegistry } from '@platform/contracts';
import { ImageSeeder } from '@platform/image';
import { PresetImageProvisioner } from './preset-image/preset-image-provisioner';
import { DockerodeProvisionAdapter } from './preset-image/dockerode-provision.adapter';

/**
 * 系统端点的装配（01 §2 `platform/system/`；23 D-11/D-12：不属任何限界上下文）。
 *
 * ⚠️ **八项检查经 `DIAGNOSE_CHECKS` 这一个 token 注入，而不是让 `DiagnosticsService`
 * 直接构造它们。** 每一项都有自己的依赖（registry / facade / settings / HttpAdapterHost），
 * 手工 new 会把 DI 搬进 service；而且**新增一项只需要往这个数组里加一行**，调度器一个
 * 字都不用改 —— 它已经按契约 `DIAGNOSE_CHECK_IDS` 排序并校验完整性了。
 *
 * ⚠️ 数组里的顺序**不重要**（`DiagnosticsService.ordered()` 按契约重排），但仍按契约
 * 顺序写，好让读代码的人一眼对得上八项清单。
 */
@Module({
  controllers: [HealthController, SystemController],
  providers: [
    SystemSettingsService,
    InitializationService,
    SystemResourcesService,
    { provide: MEMORY_SOURCES, useValue: systemMemorySources },
    SystemProvidersService,
    ConnectivityProbe,
    DiagnosticsService,
    ContainerRuntimeCheck,
    DevKvmCheck,
    DiskSpaceCheck,
    PortConflictCheck,
    OutboundNetworkCheck,
    WsLoopbackCheck,
    DataRootFsCheck,
    PresetImageCheck,
    DockerodeProvisionAdapter,
    {
      // ⚠️ 三个依赖都收窄成窄口子（`PresetImageDockerPort` / `AssetsDirSource` /
      //    `HostFacts`），于是搬运的全部判据可以在纯单测里钉住，而不必起一个 docker。
      provide: PresetImageProvisioner,
      inject: [DockerodeProvisionAdapter, SANDBOX_PROVIDER_REGISTRY, ImageSeeder],
      useFactory: (
        docker: DockerodeProvisionAdapter,
        providers: ProviderRegistry,
        seeder: ImageSeeder,
      ): PresetImageProvisioner =>
        new PresetImageProvisioner(
          docker,
          { assetsDir: (): string | undefined => process.env['SANDBOX_IMAGE_ASSETS_DIR'] },
          {
            // ⚠️ **权威是 registry 的 `defaultProvider`，不是 `process.platform`**
            //    —— 与 `substrate.ts` 同一条：第三方 provider 用
            //    `register(p, { default: true })` 能把默认档移走（04 §8），
            //    照着平台再推一次等于造第二个真相源，而两个真相源迟早会打架。
            defaultProvider: (): string => providers.defaultProvider,
            // ⚠️ 资产清单用 OCI 的 `os/arch` 写法（`linux/arm64`），而 node 的
            //    `process.arch` 是 `arm64`、`process.platform` 是 `darwin`。
            //    ⛔ **沙箱镜像永远是 linux**（容器/微 VM 里跑的是 linux），所以 os 段
            //    恒为 `linux` —— 拿宿主的 `darwin` 去比会一条都匹配不上。
            platform: (): string => `linux/${process.arch}`,
          },
          // ⚠️ 复用开机播种那条路，不另写一份注册逻辑 —— 两份「怎么算注册好了」
          //    迟早会对不上，而其中一份还是诊断第 4 步的判据。
          { seed: (): Promise<void> => seeder.onApplicationBootstrap() },
        ),
    },
    {
      provide: DIAGNOSE_CHECKS,
      inject: [
        ContainerRuntimeCheck,
        DevKvmCheck,
        DiskSpaceCheck,
        PortConflictCheck,
        OutboundNetworkCheck,
        WsLoopbackCheck,
        DataRootFsCheck,
        PresetImageCheck,
      ],
      useFactory: (...checks: DiagnoseCheck[]): DiagnoseCheck[] => checks,
    },
  ],
  exports: [SystemSettingsService],
})
export class SystemModule {}
