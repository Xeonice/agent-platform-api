import 'reflect-metadata';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { Sse } from '@nestjs/common';
import { resolve } from 'node:path';
import { CoordinatorWorkRegistry } from '../../../packages/shared-kernel/src/ports/coordinator-work-registry';
import {
  expectedCoordinatorWorkers,
  sealCoordinatorWorkerManifest,
  type CoordinatorWorkerManifestOptions,
} from '../../../apps/api/src/platform/upgrade/coordinator-worker-manifest';
const requireApi = createRequire(resolve('apps/api/package.json'));
const { DiscoveryService, ModulesContainer, NestFactory } = requireApi('@nestjs/core');
type App = Parameters<typeof sealCoordinatorWorkerManifest>[0];
type Wrapper = {
  token: unknown;
  metatype: unknown;
  host: unknown;
  inject?: unknown[];
  isAlias?: boolean;
};
let providers: Wrapper[], controllers: Wrapper[], modules: Map<unknown, unknown>;
const previousRole = process.env.PLATFORM_PROCESS_ROLE;
beforeAll(async () => {
  process.env.PLATFORM_PROCESS_ROLE = 'coordinator';
  const { AppModule } = await import('../../../apps/api/src/app.module');
  // Actual Nest module graph; preview does not construct providers, call hooks,
  // open SQLite, or create an Owner/Guest. These are structural coverage tests.
  const module = await NestFactory.createApplicationContext(AppModule, {
    preview: true,
    logger: false,
    abortOnError: false,
  });
  modules = module.get(ModulesContainer);
  const discovery = new DiscoveryService(modules);
  providers = discovery.getProviders();
  controllers = discovery.getControllers();
}, 30000);
afterAll(() => {
  if (previousRole === undefined) delete process.env.PLATFORM_PROCESS_ROLE;
  else process.env.PLATFORM_PROCESS_ROLE = previousRole;
  // Do not invoke close hooks on intentionally unconstructed preview providers.
});
function app(
  overrides: {
    providers?: Wrapper[];
    controllers?: Wrapper[];
    modules?: Map<unknown, unknown>;
  } = {},
): App {
  const result: App = {
    get: <T>(token: unknown): T => {
      if (token === DiscoveryService) {
        const discovery = {
          getProviders: () => overrides.providers ?? providers,
          getControllers: () => overrides.controllers ?? controllers,
        };
        return discovery as T;
      }
      if (token === ModulesContainer) return (overrides.modules ?? modules) as T;
      throw new Error('unexpected dependency');
    },
  };
  return result;
}
function registry(
  options: CoordinatorWorkerManifestOptions,
  omit?: string,
): CoordinatorWorkRegistry {
  const value = new CoordinatorWorkRegistry();
  for (const id of expectedCoordinatorWorkers(options)) if (id !== omit) value.register(id);
  return value;
}
function named(name: string): { new (): object } {
  return { [name]: class {} }[name];
}
describe('reviewed actual Coordinator DI and worker manifest', () => {
  it('accepts the actual production remote-Coordinator DI graph and each exact lifecycle manifest', () => {
    for (const options of [
      { prepared: false },
      { prepared: true },
      { prepared: true, dormant: true },
    ]) {
      const result = sealCoordinatorWorkerManifest(app(), registry(options), options);
      expect(result.unreviewed).toEqual([]);
      expect(result.qualified).toBe(true);
      expect(result.manifestDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    }
    expect(expectedCoordinatorWorkers({ prepared: false })).toHaveLength(35);
    expect(expectedCoordinatorWorkers({ prepared: true })).toHaveLength(36);
    expect(expectedCoordinatorWorkers({ prepared: true, dormant: true })).toHaveLength(35);
  });
  it('rejects actual @Sse metadata added to an already reviewed production controller without invoking its source', () => {
    const actual = controllers.find(
      (row) => typeof row.metatype === 'function' && row.metatype.name === 'SystemController',
    );
    if (!actual || typeof actual.metatype !== 'function')
      throw new Error('Production SystemController not scanned');
    const prototype: object = actual.metatype.prototype;
    const key = 'manifestUnreviewedPermanentStream';
    let invoked = false;
    const method = () => {
      invoked = true;
      throw new Error('Stream source must not be executed');
    };
    Object.defineProperty(prototype, key, { configurable: true, value: method });
    const descriptor = Object.getOwnPropertyDescriptor(prototype, key);
    if (!descriptor) throw new Error('Own method descriptor missing');
    Sse('unreviewed-permanent-stream')(prototype, key, descriptor);
    try {
      for (const options of [
        { prepared: false },
        { prepared: true },
        { prepared: true, dormant: true },
      ]) {
        const value = registry(options),
          result = sealCoordinatorWorkerManifest(app(), value, options);
        expect(result.qualified).toBe(false);
        expect(result.unreviewed).toContain(
          'sse-controller-lifecycle-unreviewed:controller|SystemModule|class:SystemController',
        );
        expect(value.snapshot()).toMatchObject({ coverageComplete: false, state: 'unknown' });
      }
      expect(invoked).toBe(false);
    } finally {
      Reflect.deleteProperty(prototype, key);
    }
    expect(
      sealCoordinatorWorkerManifest(app(), registry({ prepared: false }), { prepared: false })
        .qualified,
    ).toBe(true);
  });
  it('keeps real adoption unqualified until the newly registered writer is sealed after transition', () => {
    const dormant = { prepared: true, dormant: true };
    const value = registry(dormant);
    expect(sealCoordinatorWorkerManifest(app(), value, dormant).qualified).toBe(true);
    value.beginLifecycleTransition();
    expect(value.snapshot()).toMatchObject({
      state: 'starting',
      sealed: false,
      coverageComplete: false,
    });
    value.register('platform.writer-renewal');
    expect(value.snapshot().coverageComplete).toBe(false);
    const adopted = sealCoordinatorWorkerManifest(app(), value, { prepared: true });
    expect(adopted).toMatchObject({ qualified: true, unreviewed: [] });
  });
  it('rejects new no-op providers/factories or duplicate tokens even when all known workers are idle', () => {
    const actual = providers.find(
      (row) => (row.host as { metatype: { name: string } }).metatype.name === 'UpgradeModule',
    );
    if (!actual) throw new Error('Production UpgradeModule not scanned');
    const host = actual.host;
    for (const unknown of [
      { token: named('UnreviewedWorker'), metatype: named('UnreviewedWorker'), host },
      { token: Symbol('NewTimer'), metatype: () => ({}), inject: [], host },
      { token: Symbol('UpgradeStore'), metatype: named('UpgradeStore'), host },
      providers[0],
    ]) {
      const value = registry({ prepared: false });
      expect(
        sealCoordinatorWorkerManifest(app({ providers: [...providers, unknown] }), value, {
          prepared: false,
        }).qualified,
      ).toBe(false);
      expect(value.snapshot()).toMatchObject({ coverageComplete: false, state: 'unknown' });
    }
  });
  it('rejects missing logging/workers, extras, invalid dormant scope and preserves prior unknown', () => {
    const options = { prepared: false };
    expect(
      sealCoordinatorWorkerManifest(app(), registry(options, 'platform.logging'), options)
        .qualified,
    ).toBe(false);
    const extra = registry(options);
    extra.register('new.unreviewed');
    expect(sealCoordinatorWorkerManifest(app(), extra, options).qualified).toBe(false);
    const invalid = { prepared: false, dormant: true };
    expect(sealCoordinatorWorkerManifest(app(), registry(invalid), invalid).qualified).toBe(false);
    const failed = registry(options);
    failed.invalidateCoverage();
    expect(sealCoordinatorWorkerManifest(app(), failed, options).qualified).toBe(false);
  });
  it('rejects vendor MCP timers/sessions and local SDK providers instead of marking them passive', () => {
    for (const id of [
      'McpSseService',
      'McpStreamableHttpService',
      'SsePingService',
      'StdioService',
      'RuntimeReconciler',
      'BoxliteSandboxProvider',
    ]) {
      const worker = named(id);
      expect(
        sealCoordinatorWorkerManifest(
          app({
            providers: [...providers, { token: worker, metatype: worker, host: providers[0].host }],
          }),
          registry({ prepared: false }),
          { prepared: false },
        ).qualified,
      ).toBe(false);
    }
  });
  it('rejects missing modules, unknown controllers/enhancers and oversized inventories', () => {
    const options = { prepared: false },
      missing = new Map(modules);
    missing.delete([...missing.keys()][0]);
    const target = [...modules.values()][0] as { injectables: Map<unknown, unknown> };
    const unknown = named('UnreviewedController');
    for (const subject of [
      app({ modules: missing }),
      app({
        controllers: [
          ...controllers,
          { token: unknown, metatype: unknown, host: providers[0].host },
        ],
      }),
      app({ providers: Array.from({ length: 513 }, () => providers[0]) }),
    ])
      expect(sealCoordinatorWorkerManifest(subject, registry(options), options).qualified).toBe(
        false,
      );
    target.injectables.set(unknown, {});
    try {
      expect(sealCoordinatorWorkerManifest(app(), registry(options), options).qualified).toBe(
        false,
      );
    } finally {
      target.injectables.delete(unknown);
    }
  });
});
