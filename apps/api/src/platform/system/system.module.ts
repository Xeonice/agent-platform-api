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
