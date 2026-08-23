import { describe, it, expect } from 'vitest';
import { SandboxProviderError, SandboxProviderErrorCode } from '@platform/contracts';
import type {
  ProcessSpec,
  ProcessStream,
  SandboxHandle,
  SandboxProvider,
  SandboxProviderCapabilities,
  SandboxProviderContext,
  SandboxRuntimeStatus,
} from '@platform/contracts';
import { SandboxProviderRegistry } from '../../src/infrastructure/registry/provider-registry';
import { AioSandboxProvider } from '../../src/infrastructure/providers/aio/aio-sandbox.provider';
import { BoxliteSandboxProvider } from '../../src/infrastructure/providers/boxlite/boxlite-sandbox.provider';
import { createDockerClient } from '../../src/infrastructure/providers/docker/docker-client';

/**
 * The REAL registry class (04 §8), not a double. `createDockerClient()` only builds a
 * dockerode handle (no connection) and the BoxLite SDK loads lazily on first
 * control-plane call, so constructing the built-ins here touches no daemon.
 */
const CAPS: SandboxProviderCapabilities = {
  spawnTty: true,
  volumeMount: false,
  updateResources: false,
  pauseResume: true,
  snapshot: true,
  watchEvents: false,
  headlessTask: false,
};

class ThirdPartyProvider implements SandboxProvider {
  readonly capabilities = CAPS;
  constructor(readonly name: string) {}
  async create(ctx: SandboxProviderContext): Promise<SandboxHandle> {
    return { provider: this.name, providerSandboxId: `tp-${ctx.sandboxId}` };
  }
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async destroy(): Promise<void> {}
  async inspect(): Promise<SandboxRuntimeStatus> {
    return { lifecycleState: 'instance_running' };
  }
  async spawn(_h: SandboxHandle, _s: ProcessSpec): Promise<ProcessStream> {
    throw new Error('not used');
  }
}

const makeRegistry = (): SandboxProviderRegistry =>
  new SandboxProviderRegistry(
    new AioSandboxProvider(createDockerClient()),
    new BoxliteSandboxProvider(),
  );

describe('SandboxProviderRegistry — the open extension point (04 §8)', () => {
  it('starts with the two built-ins and aio as the default', () => {
    const registry = makeRegistry();
    expect(
      registry
        .list()
        .map((p) => p.name)
        .sort(),
    ).toEqual(['aio', 'boxlite']);
    expect(registry.defaultProvider).toBe('aio');
  });

  it('register() adds a provider that get/has/list see immediately', () => {
    const registry = makeRegistry();
    expect(registry.has('acme')).toBe(false);

    registry.register(new ThirdPartyProvider('acme'));

    expect(registry.has('acme')).toBe(true);
    expect(registry.get('acme').capabilities).toEqual(CAPS);
    expect(registry.list().map((p) => p.name)).toContain('acme');
    expect(registry.defaultProvider).toBe('aio'); // registering does not steal the default
  });

  it('register(..., { default: true }) moves the default provider', () => {
    const registry = makeRegistry();
    registry.register(new ThirdPartyProvider('acme'), { default: true });
    expect(registry.defaultProvider).toBe('acme');
  });

  it('a duplicate name FAILS FAST instead of silently overwriting (04 §8)', () => {
    const registry = makeRegistry();
    const first = new ThirdPartyProvider('acme');
    registry.register(first);

    expect(() => registry.register(new ThirdPartyProvider('acme'))).toThrow(/duplicate/i);
    // and the original registration is untouched
    expect(registry.get('acme')).toBe(first);
  });

  it('shadowing a BUILT-IN name is the same fail-fast, with ALREADY_EXISTS', () => {
    const registry = makeRegistry();
    try {
      registry.register(new ThirdPartyProvider('aio'));
      throw new Error('expected a duplicate-name failure');
    } catch (e) {
      expect(e).toBeInstanceOf(SandboxProviderError);
      expect((e as SandboxProviderError).code).toBe(SandboxProviderErrorCode.ALREADY_EXISTS);
    }
    // the real aio is still the one registered under `aio`
    expect(registry.get('aio')).toBeInstanceOf(AioSandboxProvider);
  });

  it('get() on an unregistered name still reports NOT_FOUND', () => {
    const registry = makeRegistry();
    expect(() => registry.get('nope')).toThrow(SandboxProviderError);
  });
});
