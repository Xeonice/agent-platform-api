import { Global, Module } from '@nestjs/common';
import {
  SANDBOX_PROVIDER_REGISTRY,
  SANDBOX_PTY_PORT,
  SANDBOX_FACADE,
  WORKSPACE_PREPARER,
} from '@platform/contracts';
import { SANDBOX_REPOSITORY } from '../domain/repositories/sandbox.repository';
import { SandboxApplicationService } from '../application/sandbox-application.service';
import { SandboxPtyAdapter } from '../application/sandbox-pty.adapter';
import { SandboxFacadeAdapter } from '../application/sandbox-facade.adapter';
import { SandboxEventProjector } from '../application/sandbox-event.projector';
import { SqliteSandboxRepository } from '../infrastructure/persistence/sqlite/sandbox.repository.impl';
import { FsWorkspacePreparer } from '../infrastructure/workspace/workspace-preparer';
import { SandboxProviderRegistry } from '../infrastructure/registry/provider-registry';
import { AioSandboxProvider } from '../infrastructure/providers/aio/aio-sandbox.provider';
import { BoxliteSandboxProvider } from '../infrastructure/providers/boxlite/boxlite-sandbox.provider';
import { DOCKER_CLIENT } from '../infrastructure/providers/docker/docker.token';
import { createDockerClient } from '../infrastructure/providers/docker/docker-client';
import { RuntimeReconciler } from '../infrastructure/reconcile/runtime-reconciler';
import { SandboxController } from './http/sandbox.controller';
import { SandboxMcpTools } from './mcp/sandbox.mcp-tools';

/**
 * Composition root for the sandbox context — the ONE place ports are wired to
 * implementations (boundaries `module-root` element). Registers BOTH built-in
 * providers (aio default + boxlite) against the open registry, the workspace
 * preparer, and the cross-context SANDBOX_PTY_PORT (consumed by `terminal`) +
 * SANDBOX_FACADE (consumed by `project` for taskCount). @Global so those tokens
 * reach other contexts by token without a package cycle (mirrors ProjectModule).
 */
@Global()
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
    { provide: SANDBOX_FACADE, useClass: SandboxFacadeAdapter },
    RuntimeReconciler,
    SandboxEventProjector,
  ],
  exports: [SandboxApplicationService, SANDBOX_PTY_PORT, SANDBOX_FACADE],
})
export class SandboxModule {}
