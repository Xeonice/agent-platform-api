import { Module } from '@nestjs/common';
import { SANDBOX_REPOSITORY } from '../domain/repositories/sandbox.repository';
import { SandboxApplicationService } from '../application/sandbox-application.service';
import { SqliteSandboxRepository } from '../infrastructure/persistence/sqlite/sandbox.repository.impl';
import { SandboxController } from './http/sandbox.controller';
import { SandboxMcpTools } from './mcp/sandbox.mcp-tools';

/**
 * Composition root for the sandbox context. This file is the ONE place allowed
 * to wire a domain port (SANDBOX_REPOSITORY) to its infrastructure implementation
 * (SqliteSandboxRepository) — see the boundaries `module-root` element override
 * in eslint.config.mjs. Infrastructure ports it does not own (DATABASE, CLOCK,
 * ID_GENERATOR, UNIT_OF_WORK, EVENT_BUS) come from the @Global PlatformModule.
 */
@Module({
  controllers: [SandboxController],
  providers: [
    SandboxApplicationService,
    SandboxMcpTools,
    { provide: SANDBOX_REPOSITORY, useClass: SqliteSandboxRepository },
  ],
  exports: [SandboxApplicationService],
})
export class SandboxModule {}
