import { Global, Module } from '@nestjs/common';
import {
  SANDBOX_EXEC_PORT,
  SANDBOX_PROVIDER_REGISTRY,
  SANDBOX_PTY_PORT,
  SANDBOX_FACADE,
  WORKSPACE_PREPARER,
} from '@platform/contracts';
import { SANDBOX_REPOSITORY } from '../domain/repositories/sandbox.repository';
import { SandboxApplicationService } from '../application/sandbox-application.service';
import { SandboxPtyAdapter } from '../application/sandbox-pty.adapter';
import { SandboxExecAdapter } from '../application/sandbox-exec.adapter';
import { ProvisionSandboxWorkflow } from '../application/workflows/provision-sandbox.workflow';
import { SandboxFacadeAdapter } from '../application/sandbox-facade.adapter';
import { SandboxEventProjector } from '../application/sandbox-event.projector';
import { CredentialRevokedHandler } from '../application/event-handlers/credential-revoked.handler';
import { SqliteSandboxRepository } from '../infrastructure/persistence/sqlite/sandbox.repository.impl';
import { FsWorkspacePreparer } from '../infrastructure/workspace/workspace-preparer';
import { SandboxProviderRegistry } from '../infrastructure/registry/provider-registry';
import { AioSandboxProvider } from '../infrastructure/providers/aio/aio-sandbox.provider';
import { BoxliteSandboxProvider } from '../infrastructure/providers/boxlite/boxlite-sandbox.provider';
import { DOCKER_CLIENT } from '../infrastructure/providers/docker/docker.token';
import { createDockerClient } from '../infrastructure/providers/docker/docker-client';
import { RuntimeReconciler } from '../infrastructure/reconcile/runtime-reconciler';
import { SandboxController } from './http/sandbox.controller';
import { ProviderController } from './http/provider.controller';
import { SandboxMcpTools } from './mcp/sandbox.mcp-tools';

/**
 * Composition root for the sandbox context — the ONE place ports are wired to
 * implementations (boundaries `module-root` element). Registers BOTH built-in
 * providers (aio default + boxlite) against the open registry, the workspace
 * preparer, and the cross-context SANDBOX_PTY_PORT (consumed by `terminal`) +
 * SANDBOX_FACADE (consumed by `project` for taskCount). @Global so those tokens
 * reach other contexts by token without a package cycle (mirrors ProjectModule).
 *
 * SANDBOX_PROVIDER_REGISTRY is EXPORTED (mirroring RuntimeModule's adapter registry):
 * that is what makes 04 §8 方式一 real — an out-of-tree module can inject the token and
 * `register()` its provider from `onModuleInit` without this file being edited.
 */
@Global()
@Module({
  controllers: [SandboxController, ProviderController],
  providers: [
    SandboxApplicationService,
    ProvisionSandboxWorkflow,
    SandboxMcpTools,
    { provide: SANDBOX_REPOSITORY, useClass: SqliteSandboxRepository },
    { provide: WORKSPACE_PREPARER, useClass: FsWorkspacePreparer },
    { provide: DOCKER_CLIENT, useFactory: createDockerClient },
    AioSandboxProvider,
    BoxliteSandboxProvider,
    { provide: SANDBOX_PROVIDER_REGISTRY, useClass: SandboxProviderRegistry },
    { provide: SANDBOX_PTY_PORT, useClass: SandboxPtyAdapter },
    { provide: SANDBOX_EXEC_PORT, useClass: SandboxExecAdapter },
    { provide: SANDBOX_FACADE, useClass: SandboxFacadeAdapter },
    RuntimeReconciler,
    SandboxEventProjector,
    CredentialRevokedHandler,
  ],
  exports: [
    SandboxApplicationService,
    SANDBOX_PROVIDER_REGISTRY,
    SANDBOX_PTY_PORT,
    SANDBOX_EXEC_PORT,
    SANDBOX_FACADE,
  ],
})
export class SandboxModule {}
