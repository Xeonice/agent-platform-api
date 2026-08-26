import { Injectable } from '@nestjs/common';
import { SandboxProviderError, SandboxProviderErrorCode } from '@platform/contracts';
import type { ImageSpecProvider, ImageSpecRegistry } from '@platform/contracts';
import { OciImageSpecProvider } from '../spec/oci-image-spec.provider';

/**
 * Open image-spec registry (docs/backend/04 §8 方式一) — the third extension point,
 * finally not a bare Symbol.
 *
 * The built-in `oci` provider arrives through the constructor but registers through
 * the SAME public `register()` a third-party module calls from its `onModuleInit`,
 * so there is exactly ONE registration path and ONE uniqueness check — no privileged
 * internal door (mirrors `SandboxProviderRegistry`).
 *
 * A duplicate name FAILS FAST at boot: two packages both claiming `oci` must break
 * loudly, not silently shadow each other at the first `POST /api/images`.
 */
@Injectable()
export class DefaultImageSpecRegistry implements ImageSpecRegistry {
  private defaultName = 'oci';
  private readonly providers = new Map<string, ImageSpecProvider>();

  constructor(oci: OciImageSpecProvider) {
    this.register(oci, { default: true });
  }

  get defaultProvider(): string {
    return this.defaultName;
  }

  register(impl: ImageSpecProvider, opts?: { default?: boolean }): void {
    if (this.providers.has(impl.name)) {
      throw new SandboxProviderError(
        SandboxProviderErrorCode.ALREADY_EXISTS,
        `duplicate image-spec provider name '${impl.name}' — names must be unique (04 §8)`,
      );
    }
    this.providers.set(impl.name, impl);
    if (opts?.default) this.defaultName = impl.name;
  }

  get(name: string): ImageSpecProvider {
    const found = this.providers.get(name);
    if (!found) {
      throw new SandboxProviderError(
        SandboxProviderErrorCode.NOT_FOUND,
        `no image-spec provider registered for '${name}' (have: ${[...this.providers.keys()].join(', ')})`,
      );
    }
    return found;
  }

  has(name: string): boolean {
    return this.providers.has(name);
  }

  list(): ImageSpecProvider[] {
    return [...this.providers.values()];
  }
}
