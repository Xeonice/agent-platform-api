import { Module } from '@nestjs/common';
import { McpModule } from '@rekog/mcp-nest';
import { SandboxModule } from '@platform/sandbox';
import { PlatformModule } from './platform/persistence/platform.module';
import { SystemModule } from './platform/system/system.module';
import { mcpModuleOptions } from './bootstrap/mcp.setup';
import { guardProviders } from './bootstrap/guards.setup';

/**
 * Root module (01 §2): assembles the @Global platform, the MCP transport, the
 * system endpoints, and the bounded-context modules (only `sandbox` in this
 * scaffold slice; the other six contexts follow the identical four-layer shape).
 */
@Module({
  imports: [PlatformModule, McpModule.forRoot(mcpModuleOptions), SystemModule, SandboxModule],
  providers: [...guardProviders],
})
export class AppModule {}
