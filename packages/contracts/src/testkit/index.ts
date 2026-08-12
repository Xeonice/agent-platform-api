import { describe, it, expect } from 'vitest';
import type {
  SandboxProviderContract,
  SandboxProviderCapabilities,
} from '../sandbox-provider.contract';
import { UNSUPPORTED_CAPABILITY } from '../sandbox-provider.contract';

/**
 * Golden contract test suite (docs/backend/04 §10).
 *
 * Any third-party (or built-in aio/boxlite) SandboxProvider that passes this
 * suite is a conformant plugin — no manual review. Built-in implementations run
 * the SAME suite in CI (no double standard, §10). This is a REQUIRED CI check
 * (shared/09 §2.3): it must NOT be demoted to optional.
 *
 * This is the executor skeleton. Clauses are keyed by the ids in 04 §10.2
 * (SP-01…, CAP-01). The golden-fixture directory convention for RuntimeAdapter
 * output parsers lives under ./fixtures (RA-04) with a CLI-VERSION-MATRIX
 * placeholder — every new supported CLI version MUST add a fixture there.
 */

export interface SandboxProviderTestOptions {
  /** capabilities the factory promises — CAP-01 asserts declared === actual. */
  expectedCapabilities?: Partial<SandboxProviderCapabilities>;
}

export function runSandboxProviderContractTests(
  label: string,
  factory: () => SandboxProviderContract,
  opts: SandboxProviderTestOptions = {},
): void {
  describe(`SandboxProvider contract: ${label}`, () => {
    it('SP-01 (MUST): created handle.provider === provider.name', async () => {
      const provider = factory();
      const handle = await provider.create({ sandboxId: 'sbx-testkit-1' });
      expect(handle.provider).toBe(provider.name);
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

/** re-export so plugin CIs can assert against the same sentinel (04 §10.2 CAP-01). */
export { UNSUPPORTED_CAPABILITY };
