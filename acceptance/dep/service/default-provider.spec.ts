import { afterEach, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import {
  SandboxProviderRegistry,
  preferredSandboxProvider,
} from '../../../packages/modules/sandbox/src/infrastructure/registry/provider-registry';
import { AioSandboxProvider } from '../../../packages/modules/sandbox/src/infrastructure/providers/aio/aio-sandbox.provider';
import { BoxliteSandboxProvider } from '../../../packages/modules/sandbox/src/infrastructure/providers/boxlite/boxlite-sandbox.provider';
import { ScriptedProvider } from '../../support/external-provider';

const original = process.env.SANDBOX_DEFAULT_PROVIDER;
afterEach(() => {
  if (original === undefined) delete process.env.SANDBOX_DEFAULT_PROVIDER;
  else process.env.SANDBOX_DEFAULT_PROVIDER = original;
});

async function registryModule() {
  return Test.createTestingModule({
    providers: [
      SandboxProviderRegistry,
      { provide: AioSandboxProvider, useValue: new ScriptedProvider() },
      { provide: BoxliteSandboxProvider, useValue: new BoxliteSandboxProvider() },
    ],
  }).compile();
}

describe('deployment default provider selects the registered driver before work starts', () => {
  it.each([
    { platform: 'darwin' as const, value: undefined, expected: 'boxlite' },
    { platform: 'darwin' as const, value: '', expected: 'boxlite' },
    { platform: 'linux' as const, value: '', expected: 'aio' },
    { platform: 'linux' as const, value: ' boxlite ', expected: 'boxlite' },
    { platform: 'darwin' as const, value: 'aio', expected: 'aio' },
  ])('chooses $expected on $platform for the configured value', ({ platform, value, expected }) => {
    delete process.env.SANDBOX_DEFAULT_PROVIDER;
    expect(preferredSandboxProvider(platform, value)).toBe(expected);
  });

  it('actual Nest registration uses the BoxLite microVM provider for explicit Linux deployment config', async () => {
    process.env.SANDBOX_DEFAULT_PROVIDER = 'boxlite';
    const module = await registryModule();
    try {
      const registry = module.get(SandboxProviderRegistry);
      expect(registry.defaultProvider).toBe('boxlite');
      expect(registry.get(registry.defaultProvider)).toBe(module.get(BoxliteSandboxProvider));
      expect(registry.list().map((provider) => provider.name)).toEqual(['aio', 'boxlite']);
      expect(registry.get('boxlite').capabilities.headlessTask).toBe(true);
    } finally {
      await module.close();
    }
  });

  it.each(['docker', 'BoxLite', 'boxlite,aio', 'unknown-provider'])(
    'fails Nest bootstrap for invalid %s instead of falling back',
    async (value) => {
      process.env.SANDBOX_DEFAULT_PROVIDER = value;
      await expect(registryModule()).rejects.toThrow(
        'SANDBOX_DEFAULT_PROVIDER must be aio or boxlite',
      );
    },
  );
});
