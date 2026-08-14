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
 */
@Injectable()
export class SandboxProviderRegistry implements ProviderRegistry {
  readonly defaultProvider = 'aio';
  private readonly providers = new Map<string, SandboxProvider>();

  constructor(aio: AioSandboxProvider, boxlite: BoxliteSandboxProvider) {
    this.register(aio);
    this.register(boxlite);
  }

  private register(p: SandboxProvider): void {
    this.providers.set(p.name, p);
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
