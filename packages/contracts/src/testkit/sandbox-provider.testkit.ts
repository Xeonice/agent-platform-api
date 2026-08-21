import { describe, it, expect } from 'vitest';
import type {
  SandboxProvider,
  SandboxProviderCapabilities,
  SandboxProviderContext,
} from '../sandbox-provider.contract';

/**
 * Runtime manifest of `SandboxProviderCapabilities` (04 §2.5). Declared as a
 * `Record<keyof …, true>` on purpose: adding a 7th capability bit to the interface
 * breaks THIS file at compile time, so the completeness check below can never
 * silently fall behind the contract.
 */
const CAPABILITY_MANIFEST: Record<keyof SandboxProviderCapabilities, true> = {
  spawnTty: true,
  volumeMount: true,
  updateResources: true,
  pauseResume: true,
  snapshot: true,
  watchEvents: true,
};
const CAPABILITY_KEYS = Object.keys(CAPABILITY_MANIFEST) as (keyof SandboxProviderCapabilities)[];

export interface SandboxProviderTestOptions {
  /** Pin the declared bits verbatim (regression guard for a built-in implementation). */
  expectedCapabilities?: Partial<SandboxProviderCapabilities>;
  /**
   * A ready-to-use provider context (image/quota already resolved). Supplying it
   * turns on the LIVE clauses — the ones that must really create a sandbox and
   * therefore need a reachable host (docker daemon / micro-VM hypervisor). Omit it
   * to run the STATIC clauses alone; the live block then reports as skipped rather
   * than silently disappearing.
   */
  context?: SandboxProviderContext;
  /** Printed in the skipped block's title so a skip is never anonymous. */
  skipLiveReason?: string;
}

/**
 * Golden contract test suite (docs/backend/04 §10). REQUIRED CI check (09 §2.3).
 * Built-in (`aio`/`boxlite`) and third-party providers run the SAME suite — no
 * double standard. Clause ids follow 04 §10.2.
 *
 * Clause split:
 *   - STATIC (always run, no host needed): SP-00, CAP-01 (structural half).
 *   - LIVE   (need `opts.context` + a reachable host): SP-01.
 */
export function runSandboxProviderContractTests(
  label: string,
  factory: () => SandboxProvider,
  opts: SandboxProviderTestOptions = {},
): void {
  describe(`SandboxProvider contract: ${label}`, () => {
    it('SP-00 (MUST): `name` is a non-empty registry key', () => {
      const provider = factory();
      expect(typeof provider.name).toBe('string');
      expect(provider.name.trim()).not.toBe('');
    });

    it('CAP-01 (MUST, structural half): capabilities is a COMPLETE boolean struct', () => {
      const caps = factory().capabilities;
      for (const key of CAPABILITY_KEYS) {
        expect(typeof caps[key], `capability bit '${key}' must be a boolean`).toBe('boolean');
      }
      if (opts.expectedCapabilities) {
        for (const [key, value] of Object.entries(opts.expectedCapabilities)) {
          expect(caps[key as keyof SandboxProviderCapabilities], `capability bit '${key}'`).toBe(
            value,
          );
        }
      }
    });

    const context = opts.context;
    if (context) {
      describe('live clauses (a real sandbox host is reachable)', () => {
        it('SP-01 (MUST): created handle.provider === provider.name', async () => {
          const provider = factory();
          const handle = await provider.create(context);
          try {
            expect(handle.provider).toBe(provider.name);
          } finally {
            await provider.destroy(handle);
          }
        });
      });
    } else {
      describe.skip(`live clauses SKIPPED — ${opts.skipLiveReason ?? 'no SandboxProviderContext supplied'}`, () => {
        it('SP-01 (MUST): created handle.provider === provider.name', () => undefined);
      });
    }
  });
}
