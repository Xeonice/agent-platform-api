import { Global, Module } from '@nestjs/common';
import { SANDBOX_PROVIDER_REGISTRY } from '@platform/contracts';
import { SandboxProviderRegistry } from '../infrastructure/registry/provider-registry';
import { AioSandboxProvider } from '../infrastructure/providers/aio/aio-sandbox.provider';
import { BoxliteSandboxProvider } from '../infrastructure/providers/boxlite/boxlite-sandbox.provider';
import { createDockerClient } from '../infrastructure/providers/docker/docker-client';
import { DOCKER_CLIENT } from '../infrastructure/providers/docker/docker.token';

/** SDK composition belongs to the Owner, never to the Coordinator's RPC directory.
 * Installation modules inject this same public token and register their providers
 * in onModuleInit. The role entry waits for every hook before publishing metadata. */
@Global()
@Module({
  providers: [
    { provide: DOCKER_CLIENT, useFactory: createDockerClient },
    AioSandboxProvider,
    BoxliteSandboxProvider,
    { provide: SANDBOX_PROVIDER_REGISTRY, useClass: SandboxProviderRegistry },
  ],
  exports: [SANDBOX_PROVIDER_REGISTRY],
})
export class RuntimeOwnerModule {}
