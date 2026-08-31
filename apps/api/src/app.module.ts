import { Module } from '@nestjs/common';
import { McpModule } from '@rekog/mcp-nest';
import { ProjectModule } from '@platform/project';
import { SandboxModule } from '@platform/sandbox';
import { TerminalModule } from '@platform/terminal';
import { CredentialModule } from '@platform/credential';
import { RuntimeModule } from '@platform/runtime';
import { ImageModule } from '@platform/image';
import { AutomationModule } from '@platform/automation';
import { PlatformModule } from './platform/persistence/platform.module';
import { SystemModule } from './platform/system/system.module';
import { AuditModule } from './platform/audit/audit.module';
import { AccessPasscodeModule } from './platform/access-passcode/access-passcode.module';
import { RealtimeModule } from './platform/events/realtime.module';
import { LoggingModule } from './platform/logging';
import { mcpModuleOptions } from './bootstrap/mcp.setup';
import { guardProviders } from './bootstrap/guards.setup';

/**
 * Root module (01 §2): assembles the @Global platform, the MCP transport, the
 * system endpoints, and the bounded-context modules (only `sandbox` in this
 * scaffold slice; the other six contexts follow the identical four-layer shape).
 */
@Module({
  imports: [
    PlatformModule,
    LoggingModule.forRoot(),
    AuditModule,
    AccessPasscodeModule,
    RealtimeModule,
    McpModule.forRoot(mcpModuleOptions),
    ProjectModule,
    SandboxModule,
    TerminalModule,
    CredentialModule,
    RuntimeModule,
    ImageModule,
    // ⚠️ 放在 sandbox / runtime / access-passcode 之后：automation 消费它们提供的三个
    //    contracts 口（`AUTOMATION_TASK_LAUNCHER` / `RUNTIME_CREDENTIAL_STATE_READER` /
    //    `ACCESS_GATE_READER`），依赖方向单向进来。
    AutomationModule,
    // ⚠️ 放在各限界上下文之后：`SystemModule` 注入三个扩展点 registry
    //    （provider / runtime adapter / image spec）与 `IMAGE_FACADE`，它们由那几个
    //    @Global 模块提供 —— 装配顺序与图上的可读性一致，省得下一个人去猜。
    SystemModule,
  ],
  providers: [...guardProviders],
})
export class AppModule {}
