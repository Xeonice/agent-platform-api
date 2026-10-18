import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { configurePlatformApp } from '../bootstrap/configure-app';
import { setupWebsockets } from '../bootstrap/websocket.setup';
import { readPublicNetworkConfig } from '../platform/config/public-network';
import { platformConnection } from '../platform/persistence/platform.module';
import { PlatformLoggerService } from '../platform/logging';
import { env } from '../platform/config/env';
import { coordinatorArtifactIdentity } from '../platform/upgrade/coordinator-artifact-identity';

async function main(): Promise<void> {
  process.env.PLATFORM_PROCESS_ROLE = 'coordinator';
  const { AppModule } = await import('../app.module');
  if (
    !process.env.PLATFORM_INSTANCE_ID ||
    !process.env.RUNTIME_OWNER_RPC_URL ||
    (process.env.PLATFORM_COORDINATOR_RPC_KEY?.length ?? 0) < 32 ||
    (process.env.PLATFORM_CONTROL_RPC_KEY?.length ?? 0) < 32 ||
    (process.env.PLATFORM_CONTROLLER_RPC_KEY?.length ?? 0) < 32
  )
    throw new Error('COORDINATOR_ROLE_CONFIG_REQUIRED');
  if (!['127.0.0.1', '::1', 'localhost'].includes(env.host))
    throw new Error('COORDINATOR_LOOPBACK_REQUIRED');
  await coordinatorArtifactIdentity();
  const network = readPublicNetworkConfig();
  // Acquires the durable writer epoch before any provider or scheduler is constructed.
  platformConnection();
  process.env.SANDBOX_RECONCILE_ON_BOOT = 'false';
  const app = await NestFactory.create(AppModule, { bufferLogs: true, abortOnError: false });
  app.useLogger(app.get(PlatformLoggerService));
  configurePlatformApp(app, network);
  setupWebsockets(app, network);
  app.enableShutdownHooks();
  await app.listen(env.port, env.host);
}
void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'COORDINATOR_BOOT_FAILED');
  process.exitCode = 1;
});
