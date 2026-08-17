import { describe, it, expect } from 'vitest';
import type {
  SandboxProvider,
  SandboxProviderCapabilities,
  SandboxProviderContext,
} from '../sandbox-provider.contract';
import { UNSUPPORTED_CAPABILITY } from '../sandbox-provider.contract';

/**
 * Golden contract test suite (docs/backend/04 §10). REQUIRED CI check (09 §2.3).
 * Built-in (aio/boxlite) and third-party providers run the SAME suite — no double
 * standard. This is the executor skeleton keyed by the clause ids in 04 §10.2.
 * The RuntimeAdapter golden-output fixtures live under ./fixtures (RA-04) with a
 * CLI-VERSION-MATRIX placeholder.
 */

export interface SandboxProviderTestOptions {
  expectedCapabilities?: Partial<SandboxProviderCapabilities>;
  /** a ready-to-use provider context (image/quota already resolved). */
  context: SandboxProviderContext;
}

export function runSandboxProviderContractTests(
  label: string,
  factory: () => SandboxProvider,
  opts: SandboxProviderTestOptions,
): void {
  describe(`SandboxProvider contract: ${label}`, () => {
    it('SP-01 (MUST): created handle.provider === provider.name', async () => {
      const provider = factory();
      const handle = await provider.create(opts.context);
      expect(handle.provider).toBe(provider.name);
      await provider.destroy(handle);
    });

    it('CAP-01 (MUST): declared capability bits are a boolean struct', () => {
      const provider = factory();
      const caps = provider.capabilities;
      for (const key of Object.keys(caps) as (keyof SandboxProviderCapabilities)[]) {
        expect(typeof caps[key]).toBe('boolean');
      }
      if (opts.expectedCapabilities) {
        for (const [key, value] of Object.entries(opts.expectedCapabilities)) {
          expect(caps[key as keyof SandboxProviderCapabilities]).toBe(value);
        }
      }
    });
  });
}

export { UNSUPPORTED_CAPABILITY };
