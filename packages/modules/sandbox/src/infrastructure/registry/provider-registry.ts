import { Injectable } from '@nestjs/common';
import {
  SandboxProviderError,
  SandboxProviderErrorCode,
  type ProviderRegistry,
  type SandboxProvider,
} from '@platform/contracts';
import { AioSandboxProvider } from '../providers/aio/aio-sandbox.provider';
import { BoxliteSandboxProvider } from '../providers/boxlite/boxlite-sandbox.provider';

/**
 * 宿主平台决定默认档位 —— **用户不该关心自己用的是哪个沙箱**。
 *
 * ── 事实（都实测过，不是推断）────────────────────────────────────────────────
 * `AioSandboxProvider extends DockerContainerBackend`：**aio 就是 docker 容器**。
 * `BoxliteSandboxProvider` 是微 VM，macOS 上走 **Apple Hypervisor.framework**，
 * 与 docker 无关（本机实测：SDK 可加载、`JsBoxlite` 实例化成功，没有 Docker daemon）。
 *
 *   macOS  ⇒ boxlite 原生；aio 要 Docker Desktop（= 先跑一个 Linux VM，再在里面跑容器）
 *   Linux  ⇒ aio 原生 docker；boxlite 要 KVM
 *
 * ⚠️ 此前这里是 `private defaultName = 'aio'` —— **硬编码，完全不看宿主**。
 * 于是 Mac 用户拿到的默认，恰好是这台机器上最费劲、而且**多半根本没装**的那个：
 * 向导报「镜像尚未注册」，真正的原因却是「你选的档位需要 Docker，而这台机器没有」。
 *
 * ⚠️ 这个函数只决定**内置两个之间**的偏好。第三方 provider 显式
 * `register(p, { default: true })` 仍然赢——那是 04 §8 的开放注册语义，不该被平台判定
 * 覆盖：装了自己 provider 的部署方比我们更清楚该用哪个。
 */
function hostPreferredProvider(): string {
  return process.platform === 'darwin' ? 'boxlite' : 'aio';
}

/**
 * Open provider registry (docs/backend/04 §8): keyed by ProviderId STRING, not a
 * closed enum — third-party providers register the same way. Default follows the
 * HOST PLATFORM (see `hostPreferredProvider`).
 *
 * The two built-ins come in through the constructor but go through the SAME public
 * `register()` an out-of-tree module uses, so there is exactly one registration path
 * (and one uniqueness check) rather than a privileged internal one.
 */
@Injectable()
export class SandboxProviderRegistry implements ProviderRegistry {
  private defaultName = '';
  private readonly providers = new Map<string, SandboxProvider>();

  constructor(aio: AioSandboxProvider, boxlite: BoxliteSandboxProvider) {
    // 仍然只有一条注册路径：平台偏好通过**同一个** `register()` 的 default 位表达，
    // 而不是绕过它直接改字段。
    const preferred = hostPreferredProvider();
    this.register(aio, { default: aio.name === preferred });
    this.register(boxlite, { default: boxlite.name === preferred });

    // ⚠️ **拼错名字必须 boot 时炸，不许静默退回**。此前这里写的是
    // `private defaultName = 'aio'` 兜底：`hostPreferredProvider()` 返回一个不存在的
    // 名字时，默认会**悄悄变回 aio**——而那恰好是我们刚花力气从 macOS 上挪走的那个档位。
    // 一个静默生效的兜底，把「代码写错了」伪装成「一切正常」，正是 04 §8 里
    // duplicate name 要 fail fast 的同一个理由。
    if (this.defaultName !== preferred) {
      throw new SandboxProviderError(
        SandboxProviderErrorCode.NOT_FOUND,
        `hostPreferredProvider() 返回 '${preferred}'，但没有内置 provider 叫这个名字（04 §8）`,
      );
    }
  }

  /** 宿主平台的偏好，除非之后有 `register(p, { default: true })` 把它移走。 */
  get defaultProvider(): string {
    return this.defaultName;
  }

  /**
   * Register a provider (04 §8). A duplicate `name` FAILS FAST — two packages both
   * claiming `aio` must break at boot, not silently shadow each other at runtime.
   */
  register(p: SandboxProvider, opts?: { default?: boolean }): void {
    if (this.providers.has(p.name)) {
      throw new SandboxProviderError(
        SandboxProviderErrorCode.ALREADY_EXISTS,
        `duplicate sandbox provider name '${p.name}' — provider names must be unique (04 §8)`,
      );
    }
    this.providers.set(p.name, p);
    if (opts?.default) this.defaultName = p.name;
  }

  get(name: string): SandboxProvider {
    const provider = this.providers.get(name);
    if (!provider) {
      throw new SandboxProviderError(
        SandboxProviderErrorCode.NOT_FOUND,
        `no provider registered for '${name}' (have: ${[...this.providers.keys()].join(', ')})`,
      );
    }
    return provider;
  }

  has(name: string): boolean {
    return this.providers.has(name);
  }

  list(): SandboxProvider[] {
    return [...this.providers.values()];
  }
}
