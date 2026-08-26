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

/**
 * 在指定的宿主平台上建一个 registry。
 *
 * ⚠️ `process.platform` 是只读属性，只能 `defineProperty` 覆盖 —— 而这正是**必须**
 * 覆盖它的理由：默认档位的选择依据就是它，只在当前这台机器上跑，等于只测了一半，
 * 另一半（Linux）要等 CI 或用户装机时才发现。
 */
function registryOn(platform: NodeJS.Platform): SandboxProviderRegistry {
  const real = process.platform;
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  try {
    return makeRegistry();
  } finally {
    Object.defineProperty(process, 'platform', { value: real, configurable: true });
  }
}

describe('SandboxProviderRegistry — the open extension point (04 §8)', () => {
  it('starts with the two built-ins', () => {
    expect(
      makeRegistry()
        .list()
        .map((p) => p.name)
        .sort(),
    ).toEqual(['aio', 'boxlite']);
  });

  it('⭐ 默认档位跟随宿主平台 —— 用户不该关心自己用的是哪个沙箱', () => {
    // ⚠️ 此前这里写死 `expect(registry.defaultProvider).toBe('aio')`，而实现也写死
    //    `defaultName = 'aio'`：断言与实现抄的是同一个常量，谁都没在回答
    //    「这个默认对这台机器合适吗」。真实后果：Mac 用户拿到的默认是 aio，
    //    而 `AioSandboxProvider extends DockerContainerBackend` —— 它要 Docker Desktop，
    //    多半没装，于是向导报「镜像尚未注册」，真正的原因却是档位选错了。
    //
    // MUTATION: `hostPreferredProvider()` 改成恒返回 'aio' ⇒ darwin 那条红。
    expect(registryOn('darwin').defaultProvider).toBe('boxlite');
    expect(registryOn('linux').defaultProvider).toBe('aio');
  });

  it('两个平台的默认都是**真的注册过**的 provider，不是一个悬空名字', () => {
    // ⚠️ 这条与上一条守的不是同一件事。上一条比对字符串；这条要的是
    //    「默认名拿得到 provider」——否则错误要等到用户点下发起、建沙箱时才炸。
    //    实现侧配套改成 boot 时 fail fast（此前是静默退回 'aio'，
    //    那会把「代码写错了」伪装成「一切正常」，而退回的恰好是我们刚从 macOS 挪走的档位）。
    for (const platform of ['darwin', 'linux'] as const) {
      const registry = registryOn(platform);
      expect(registry.has(registry.defaultProvider), `${platform} 的默认档位没注册`).toBe(true);
    }
  });

  it('register() adds a provider that get/has/list see immediately', () => {
    const registry = makeRegistry();
    expect(registry.has('acme')).toBe(false);

    registry.register(new ThirdPartyProvider('acme'));

    expect(registry.has('acme')).toBe(true);
    expect(registry.get('acme').capabilities).toEqual(CAPS);
    expect(registry.list().map((p) => p.name)).toContain('acme');
    // 注册**不会**抢走默认（不管当前平台偏好的是哪个）。
    expect(registry.defaultProvider).not.toBe('acme');
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
