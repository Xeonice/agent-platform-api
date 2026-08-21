import { describe, it, expect } from 'vitest';
import type { ProcessStream } from '../sandbox-provider.contract';
import type {
  AuthSessionContext,
  RuntimeAdapter,
  RuntimeCredential,
  SandboxExecFn,
} from '../runtime-adapter.contract';
import { RUNTIME_AUTH_METHODS, RUNTIME_BEGIN_METHODS } from '../schemas/runtime.schema';

/** One `injectCredential` case: a credential + the plaintext that must not surface. */
export interface RuntimeAdapterInjectionCase {
  /** Shown on failure. NEVER put the secret itself here — the message is logged. */
  label: string;
  credential: RuntimeCredential;
  /** Plaintext fragments that MUST NOT appear in any argv the adapter builds. */
  secrets: string[];
}

export interface RuntimeAdapterTestOptions {
  /** The key this adapter is registered under (RA-08 pins `id` to it). */
  registryKey: string;
  /** A well-formed api-key sample; drives the RA-11 positive case and RA-14's auto case. */
  validApiKeySample?: string;
  /** Provider-specific malformed samples on top of the universal ones (RA-11). */
  extraInvalidApiKeySamples?: string[];
  /** Account-shaped credentials to drive `injectCredential` through (RA-14). */
  injectionCases?: RuntimeAdapterInjectionCase[];
}

/** Malformed for ANY conceivable key format — empty / blank / whitespace-bearing. */
const UNIVERSALLY_INVALID_API_KEYS = ['', '   ', '\n', 'not a valid key'];

interface RecordedExec {
  cmd: string[];
  stdin?: string;
}

function recordingExec(): { exec: SandboxExecFn; calls: RecordedExec[] } {
  const calls: RecordedExec[] = [];
  const exec: SandboxExecFn = async (cmd, execOpts) => {
    calls.push({ cmd, stdin: execOpts?.stdin });
    return { stdout: '', stderr: '', exitCode: 0 };
  };
  return { exec, calls };
}

/**
 * An inert pty + HOME. Enough to reach an adapter's METHOD guard (RA-03) and no
 * further — nothing here can start a CLI, touch the network or read a real HOME.
 */
function inertAuthSession(): AuthSessionContext {
  const pty: ProcessStream = {
    ref: 'testkit-inert-pty',
    onData(): void {},
    write(): void {},
    resize(): void {},
    onExit(): void {},
    async kill(): Promise<void> {},
  };
  return {
    pty,
    homeDir: '/nonexistent/testkit-home',
    challengeRef: 'testkit-challenge',
  };
}

function errorCodeOf(e: unknown): string | undefined {
  if (typeof e === 'object' && e !== null && 'code' in e && typeof e.code === 'string') {
    return e.code;
  }
  return undefined;
}

/**
 * Golden RuntimeAdapter contract suite (docs/backend/04 §10.3). Built-in
 * (`codex` / `claude-code`) and third-party adapters run the SAME suite.
 *
 * SCOPE: only clauses that need NO real CLI, no network and no sandbox host — so it
 * runs unconditionally in the `contract` vitest project. The clauses that need a live
 * CLI (04 §10.3 RA-01/RA-02 install round-trip, RA-05 challenge shape, RA-06
 * credential material) are out of scope here; RA-04's golden output fixtures live in
 * the adapters' own parser unit tests.
 */
export function runRuntimeAdapterContractTests(
  label: string,
  factory: () => RuntimeAdapter,
  opts: RuntimeAdapterTestOptions,
): void {
  // Collection-time probe: which optional surfaces this adapter DECLARES decides
  // which conditional clauses become mandatory (04 §10.1 能力位一致性).
  const probe = factory();
  const declaredMethods = probe.getAuthMethods();
  const illegalMethod = RUNTIME_AUTH_METHODS.find((m) => !declaredMethods.includes(m));
  const declaresApiKeyCheck = typeof probe.validateApiKey === 'function';
  const declaresTtl = probe.credentialTtlMs !== undefined;
  const declaresRefresh = probe.refreshCapability !== undefined;
  const canAutoBuildApiKeyCase =
    opts.validApiKeySample !== undefined &&
    declaredMethods.includes('api-key') &&
    typeof probe.createCredentialFromSecret === 'function';
  const hasInjectionCases = (opts.injectionCases?.length ?? 0) > 0 || canAutoBuildApiKeyCase;

  describe(`RuntimeAdapter contract: ${label}`, () => {
    it('RA-08 (MUST): id/displayName/vendor are non-empty and id === the registry key', () => {
      const adapter = factory();
      const identity: ReadonlyArray<readonly [string, string]> = [
        ['id', adapter.id],
        ['displayName', adapter.displayName],
        ['vendor', adapter.vendor],
      ];
      for (const [field, value] of identity) {
        expect(typeof value, `${field} must be a string`).toBe('string');
        expect(value.trim(), `${field} must be non-empty`).not.toBe('');
      }
      // The registry is keyed by `id`; a mismatch routes every lookup to nothing.
      expect(adapter.id).toBe(opts.registryKey);
    });

    it('RA-09 (MUST): getAuthMethods() is non-empty, duplicate-free and ⊆ RUNTIME_AUTH_METHODS', () => {
      const methods = factory().getAuthMethods();
      expect(Array.isArray(methods)).toBe(true);
      expect(methods.length, 'an adapter with no auth method cannot be configured').toBeGreaterThan(
        0,
      );
      expect(new Set(methods).size, 'duplicate auth method').toBe(methods.length);
      for (const m of methods) {
        expect(
          RUNTIME_AUTH_METHODS,
          `'${m}' is outside the contract's closed method set`,
        ).toContain(m);
      }
    });

    it('RA-10 (MUST): loginCommand() returns a non-empty, pure argv for every interactive method', () => {
      const adapter = factory();
      const interactive = adapter
        .getAuthMethods()
        .filter((m) => RUNTIME_BEGIN_METHODS.some((begin) => begin === m));
      for (const method of interactive) {
        const argv = adapter.loginCommand(method);
        expect(Array.isArray(argv), `${method}: loginCommand must return an argv array`).toBe(true);
        expect(argv.length, `${method}: argv must not be empty`).toBeGreaterThan(0);
        for (const token of argv) {
          expect(typeof token, `${method}: argv token must be a string`).toBe('string');
          expect(token.trim(), `${method}: argv token must be non-empty`).not.toBe('');
        }
        // pure: same input ⇒ same output, no IO (04 §10.3 RA-07 discipline)
        expect(adapter.loginCommand(method), `${method}: loginCommand must be pure`).toEqual(argv);
      }
    });

    if (illegalMethod) {
      it('RA-03 (MUST): beginAuth() rejects a method outside getAuthMethods()', async () => {
        let resolved = false;
        let thrown: unknown;
        try {
          await factory().beginAuth(illegalMethod, inertAuthSession());
          resolved = true;
        } catch (e) {
          thrown = e;
        }
        expect(
          resolved,
          `beginAuth('${illegalMethod}') must reject — it is not in getAuthMethods()`,
        ).toBe(false);
        // `contracts` defines no adapter error CLASS, so a plain Error is tolerated;
        // but an error that DOES carry a code must carry the right one (04 §4).
        const code = errorCodeOf(thrown);
        if (code !== undefined) expect(code).toBe('UNSUPPORTED_METHOD');
      });
    } else {
      it.skip('RA-03 (MUST) SKIPPED — the adapter declares every contract method, so there is no illegal one to probe', () =>
        undefined);
    }

    if (declaresApiKeyCheck) {
      it('RA-11 (MUST, declared validateApiKey): malformed keys rejected, the fixture accepted', () => {
        const adapter = factory();
        const validate = adapter.validateApiKey;
        expect(validate, 'validateApiKey disappeared between construction and use').toBeTypeOf(
          'function',
        );
        if (!validate) return;
        const malformed = [
          ...UNIVERSALLY_INVALID_API_KEYS,
          ...(opts.extraInvalidApiKeySamples ?? []),
        ];
        for (const sample of malformed) {
          expect(
            validate.call(adapter, sample).ok,
            `expected ${JSON.stringify(sample)} to be rejected`,
          ).toBe(false);
        }
        const valid = opts.validApiKeySample;
        if (valid !== undefined) {
          expect(
            validate.call(adapter, valid).ok,
            'the supplied well-formed sample must be accepted',
          ).toBe(true);
        }
      });
    } else {
      it.skip('RA-11 (MUST when declared) SKIPPED — adapter declares no api-key format check', () =>
        undefined);
    }

    if (declaresTtl) {
      it('RA-12 (MUST, declared credentialTtlMs): keys are offered methods, values positive finite ms', () => {
        const adapter = factory();
        const methods = adapter.getAuthMethods();
        for (const [method, value] of Object.entries(adapter.credentialTtlMs ?? {})) {
          // an explicitly-undefined entry means "no expiry" — same as absent (04 §3)
          if (value === undefined) continue;
          expect(RUNTIME_AUTH_METHODS, `'${method}' is not a contract auth method`).toContain(
            method,
          );
          expect(
            methods,
            `'${method}' carries a TTL but getAuthMethods() never offers it`,
          ).toContain(method);
          expect(typeof value, `${method}: TTL must be a number`).toBe('number');
          expect(Number.isFinite(value), `${method}: TTL must be finite`).toBe(true);
          expect(value, `${method}: TTL must be > 0 (use absence for "no expiry")`).toBeGreaterThan(
            0,
          );
        }
      });
    } else {
      it.skip('RA-12 (MUST when declared) SKIPPED — adapter declares no credentialTtlMs table', () =>
        undefined);
    }

    if (declaresRefresh) {
      it('RA-13 (MUST, declared refreshCapability): probeCommand non-empty + parser is a function', () => {
        const capability = factory().refreshCapability;
        expect(capability).toBeDefined();
        if (!capability) return;
        expect(Array.isArray(capability.probeCommand)).toBe(true);
        expect(capability.probeCommand.length, 'the refresh scanner needs a probe').toBeGreaterThan(
          0,
        );
        for (const token of capability.probeCommand) {
          expect(typeof token).toBe('string');
          expect(token.trim(), 'probeCommand token must be non-empty').not.toBe('');
        }
        expect(typeof capability.parseRefreshedAuth).toBe('function');
      });
    } else {
      it.skip('RA-13 (MUST when declared) SKIPPED — adapter declares no refreshCapability', () =>
        undefined);
    }

    if (hasInjectionCases) {
      it('RA-14 (MUST): injectCredential() never puts credential plaintext into argv (05 §4)', async () => {
        const cases: RuntimeAdapterInjectionCase[] = [...(opts.injectionCases ?? [])];
        const valid = opts.validApiKeySample;
        if (canAutoBuildApiKeyCase && valid !== undefined) {
          const builder = factory();
          const fromSecret = builder.createCredentialFromSecret;
          if (fromSecret) {
            cases.push({
              label: 'api-key (built from validApiKeySample)',
              credential: await fromSecret.call(builder, 'api-key', valid),
              secrets: [valid],
            });
          }
        }
        for (const testCase of cases) {
          const adapter = factory();
          const { exec, calls } = recordingExec();
          await adapter.injectCredential(testCase.credential, exec);
          for (const secret of testCase.secrets) {
            expect(
              secret.length,
              `${testCase.label}: an empty secret makes this vacuous`,
            ).toBeGreaterThan(0);
            for (const call of calls) {
              // /proc/<pid>/cmdline is world-readable inside the sandbox — a secret in
              // argv is a leak no matter how short-lived the process is (05 §4/§7 #3).
              expect(
                call.cmd.join(' '),
                `${testCase.label}: credential plaintext leaked into argv`,
              ).not.toContain(secret);
            }
          }
        }
      });
    } else {
      it.skip('RA-14 (MUST) SKIPPED — no injectable credential fixture supplied (pass opts.injectionCases or opts.validApiKeySample)', () =>
        undefined);
    }
  });
}
