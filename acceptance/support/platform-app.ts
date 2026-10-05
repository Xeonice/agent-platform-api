import { Test } from '@nestjs/testing';
import { IMAGE_SPEC_REGISTRY, SANDBOX_PROVIDER_REGISTRY } from '@platform/contracts';
import type { ProviderRegistry } from '@platform/contracts';
import { AppModule } from '../../apps/api/src/app.module';
import { configurePlatformApp } from '../../apps/api/src/bootstrap/configure-app';
import { setupWebsockets } from '../../apps/api/src/bootstrap/websocket.setup';
import { ProtocolProvider, registryMetadataFixture } from './protocol-resources';
import { useEnv } from './strict-ports';
export { ProtocolProvider, registryMetadataFixture } from './protocol-resources';

/** Complete Nest + production SQLite/services/guards. Only external resource providers are replaced. */
export async function createPlatform(patch: Record<string, string | undefined> = {}) {
  const restore = useEnv({
    DATABASE_URL: ':memory:',
    ACCESS_PASSCODE: undefined,
    ACCESS_PASSCODE_AUTO_GENERATE: 'false',
    SANDBOX_DEFAULT_IMAGE: 'ghcr.io/agent-infra/sandbox:latest',
    ...patch,
  });
  const provider = new ProtocolProvider();
  const registry: ProviderRegistry = {
    defaultProvider: provider.name,
    get: () => provider,
    has: (name) => name === provider.name,
    list: () => [provider],
    register: () => {
      throw new Error('fixed resource fixture');
    },
  };
  const module = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(SANDBOX_PROVIDER_REGISTRY)
    .useValue(registry)
    .overrideProvider(IMAGE_SPEC_REGISTRY)
    .useValue(registryMetadataFixture())
    .compile();
  const app = module.createNestApplication();
  configurePlatformApp(app);
  setupWebsockets(app);
  await app.init();
  await app.listen(0);
  return {
    app,
    provider,
    url: await app.getUrl(),
    close: async () => {
      try {
        await app.close();
      } finally {
        provider.close();
        restore();
      }
    },
  };
}
