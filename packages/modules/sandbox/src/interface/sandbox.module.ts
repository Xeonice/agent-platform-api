import { Module } from '@nestjs/common';
import {
  SANDBOX_PROVIDER_REGISTRY,
  SANDBOX_PTY_PORT,
  WORKSPACE_PREPARER,
} from '@platform/contracts';
import { SANDBOX_REPOSITORY } from '../domain/repositories/sandbox.repository';
import { SandboxApplicationService } from '../application/sandbox-application.service';
import { SandboxPtyAdapter } from '../application/sandbox-pty.adapter';
import { SqliteSandboxRepository } from '../infrastructure/persistence/sqlite/sandbox.repository.impl';
import { FsWorkspacePreparer } from '../infrastructure/workspace/workspace-preparer';
import { SandboxProviderRegistry } from '../infrastructure/registry/provider-registry';
import { AioSandboxProvider } from '../infrastructure/providers/aio/aio-sandbox.provider';
import { BoxliteSandboxProvider } from '../infrastructure/providers/boxlite/boxlite-sandbox.provider';
import { DOCKER_CLIENT } from '../infrastructure/providers/docker/docker.token';
import { createDockerClient } from '../infrastructure/providers/docker/docker-client';
import { SandboxController } from './http/sandbox.controller';
import { SandboxMcpTools } from './mcp/sandbox.mcp-tools';

/**
 * Composition root for the sandbox context — the ONE place ports are wired to
 * implementations (boundaries `module-root` element). Registers BOTH built-in
 * providers (aio default + boxlite) against the open registry, the workspace
 * preparer, and the cross-context SANDBOX_PTY_PORT (consumed by `terminal`).
 */
@Module({
  controllers: [SandboxController],
  providers: [
    SandboxApplicationService,
    SandboxMcpTools,
    { provide: SANDBOX_REPOSITORY, useClass: SqliteSandboxRepository },
    { provide: WORKSPACE_PREPARER, useClass: FsWorkspacePreparer },
    { provide: DOCKER_CLIENT, useFactory: createDockerClient },
    AioSandboxProvider,
    BoxliteSandboxProvider,
    { provide: SANDBOX_PROVIDER_REGISTRY, useClass: SandboxProviderRegistry },
    { provide: SANDBOX_PTY_PORT, useClass: SandboxPtyAdapter },
  ],
  exports: [SandboxApplicationService, SANDBOX_PTY_PORT],
})
export class SandboxModule {}
