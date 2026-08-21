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
 * Open provider registry (docs/backend/04 §8): keyed by ProviderId STRING, not a
 * closed enum — third-party providers register the same way. Default is `aio`.
 *
 * The two built-ins come in through the constructor but go through the SAME public
 * `register()` an out-of-tree module uses, so there is exactly one registration path
 * (and one uniqueness check) rather than a privileged internal one.
 */
@Injectable()
export class SandboxProviderRegistry implements ProviderRegistry {
  private defaultName = 'aio';
  private readonly providers = new Map<string, SandboxProvider>();

  constructor(aio: AioSandboxProvider, boxlite: BoxliteSandboxProvider) {
    this.register(aio, { default: true });
    this.register(boxlite);
  }

  /** `aio` unless a later `register(p, { default: true })` moved it. */
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
