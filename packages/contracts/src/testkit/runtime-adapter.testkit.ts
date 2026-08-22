import { describe, it, expect } from 'vitest';
import { RUNTIME_REFRESH_TOKEN_PLACEHOLDER } from '@platform/shared-kernel';
import type { ProcessStream } from '../sandbox-provider.contract';
import type {
  AuthSessionContext,
  InjectableRuntimeCredential,
  RuntimeAdapter,
  SandboxExecFn,
} from '../runtime-adapter.contract';
import { RUNTIME_AUTH_METHODS, RUNTIME_BEGIN_METHODS } from '../schemas/runtime.schema';

/**
 * What the PLATFORM holds for a credential and must NEVER let reach a sandbox
 * (RA-15/16/17, 05 §4.3 裁决 D-18). This is supplied OUT OF BAND rather than on the
 * credential itself, because that is the whole point of the decision:
 * `InjectableRuntimeCredential` has no `authFile` field, so a test could not put a real
 * refresh token on the injected credential even if it wanted to.
 */
export interface RuntimeAdapterPlatformOnlySecret {
  /**
   * The REAL `refresh_token` value the vault holds for this credential. Must be
   * non-empty — an empty sentinel would make every assertion below vacuous.
   */
  realRefreshToken: string;
  /**
   * The COMPLETE provider auth file carrying that token — i.e. the `authFile` the
   * credential record really has (RA-17's「`authFile` 非空」case). Supplying it turns
   * on the extra "a credential that DOES have one still leaks nothing" clause.
   */
  platformAuthFile?: string;
  /**
   * Set false for a runtime that injects NO provider auth file (claude's env-only
   * form). RA-16 then does not demand a placeholder-bearing file. Defaults to true.
   */
  expectsSanitizedAuthFile?: boolean;
}

/** One `injectCredential` case: a credential + the plaintext that must not surface. */
export interface RuntimeAdapterInjectionCase {
  /** Shown on failure. NEVER put the secret itself here — the message is logged. */
  label: string;
  credential: InjectableRuntimeCredential;
  /** Plaintext fragments that MUST NOT appear in any argv the adapter builds. */
  secrets: string[];
  /** Enables RA-15/16/17 for this case (see the type doc above). */
  platformOnly?: RuntimeAdapterPlatformOnlySecret;
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
  env?: Record<string, string>;
  cwd?: string;
}

/**
 * A fake `exec` that captures EVERY channel an adapter can push bytes through — argv,
 * stdin, env and cwd. RA-15 needs all of them: RA-14 only inspects argv because env is
 * a legitimate channel for a short-lived token, but a refresh token entering a sandbox
 * through ANY channel is the violation.
 *
 * `$HOME` probes are answered with a plausible HOME so an adapter that expands
 * `~/`-relative paths at inject time (裁决 D-19) can proceed to actually write.
 */
function recordingExec(homeProbeAnswer = '/home/gem'): {
  exec: SandboxExecFn;
  calls: RecordedExec[];
} {
  const calls: RecordedExec[] = [];
  const exec: SandboxExecFn = async (cmd, execOpts) => {
    calls.push({ cmd, stdin: execOpts?.stdin, env: execOpts?.env, cwd: execOpts?.cwd });
    const stdout = cmd.some((token) => token.includes('$HOME')) ? homeProbeAnswer : '';
    return { stdout, stderr: '', exitCode: 0 };
  };
  return { exec, calls };
}

/** EVERY string an adapter handed to `exec` — the search space for RA-15/16/17. */
function allBytesGivenToExec(calls: RecordedExec[]): string[] {
  const out: string[] = [];
  for (const call of calls) {
    out.push(...call.cmd);
    if (call.stdin !== undefined) out.push(call.stdin);
    if (call.cwd !== undefined) out.push(call.cwd);
    for (const [key, value] of Object.entries(call.env ?? {})) out.push(key, value);
  }
  return out;
}

/**
 * Every `"refresh_token": <value>` occurrence in whatever the adapter sent, decoded.
 * A regex rather than `JSON.parse` on purpose: it finds the field however deeply it is
 * nested, and it still finds it when the payload is a shell heredoc, a concatenation,
 * or any format that is not a bare JSON document.
 */
const REFRESH_TOKEN_FIELD_RE =
  /"refresh_token"\s*:\s*(?:"((?:\\.|[^"\\])*)"|(null|true|false|-?\d+(?:\.\d+)?))/g;

function refreshTokenValuesIn(payloads: string[]): Array<string | null> {
  const found: Array<string | null> = [];
  for (const payload of payloads) {
    REFRESH_TOKEN_FIELD_RE.lastIndex = 0;
    let match = REFRESH_TOKEN_FIELD_RE.exec(payload);
    while (match !== null) {
      // `null` marks a non-string value (null/number/bool) — never acceptable material.
      found.push(match[1] === undefined ? null : (JSON.parse(`"${match[1]}"`) as string));
      match = REFRESH_TOKEN_FIELD_RE.exec(payload);
    }
  }
  return found;
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
  // RA-15/16 need a case that declares what the PLATFORM holds but must never inject;
  // RA-17 additionally needs one whose credential record really carries a full authFile.
  const platformOnlyCases = (opts.injectionCases ?? []).filter((c) => c.platformOnly !== undefined);
  const authFileBearingCases = platformOnlyCases.filter(
    (c) => c.platformOnly?.platformAuthFile !== undefined,
  );

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

    it('RA-07 (MUST): buildStartCommand()/buildAttachCommand() are non-empty and PURE', () => {
      const adapter = factory();
      const task = { prompt: 'do the thing', headless: false, workdir: '/workspace' };
      for (const [label, build] of [
        ['buildStartCommand', () => adapter.buildStartCommand(task)],
        ['buildAttachCommand', () => adapter.buildAttachCommand()],
      ] as const) {
        const command = build();
        expect(Array.isArray(command.cmd), `${label}: cmd must be an argv array`).toBe(true);
        expect(command.cmd.length, `${label}: cmd must not be empty`).toBeGreaterThan(0);
        for (const token of command.cmd) {
          expect(typeof token, `${label}: argv token must be a string`).toBe('string');
        }
        // Pure ⇒ same input, same output, no IO. The platform calls these inside the
        // provision workflow AND on the terminal attach path; a hidden IO or a
        // non-deterministic result would make those two disagree.
        expect(build(), `${label} must be pure`).toEqual(command);
      }
    });

    it('RA-07 (MUST): getInstallPlan() is a PURE, well-formed verdict on the image', () => {
      const adapter = factory();
      const image = { ref: 'example.invalid/some/image:tag', digest: 'sha256:deadbeef' };
      const plan = adapter.getInstallPlan(image);
      expect(['preinstalled', 'install-on-start', 'sidecar-inject']).toContain(plan.strategy);
      // requiredBinaries[0] is what the platform runs `--version` on to fill
      // `runtime_installations.version_detected` (13 §2.3.2) — without it the platform
      // would have to hard-code a per-runtime executable name.
      expect(plan.requiredBinaries.length, 'requiredBinaries must name the CLI').toBeGreaterThan(0);
      expect(Array.isArray(plan.packageManagerCmds)).toBe(true);
      if (plan.strategy === 'install-on-start') {
        expect(plan.packageManagerCmds.length, 'install-on-start needs commands').toBeGreaterThan(
          0,
        );
      }
      expect(adapter.getInstallPlan(image), 'getInstallPlan must be pure').toEqual(plan);
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

    if (platformOnlyCases.length > 0) {
      it('RA-15 (MUST): no real refresh_token in ANY byte injectCredential() hands to exec (P0-3)', async () => {
        for (const testCase of platformOnlyCases) {
          const platformOnly = testCase.platformOnly;
          if (!platformOnly) continue;
          expect(
            platformOnly.realRefreshToken.length,
            `${testCase.label}: an empty realRefreshToken makes RA-15 vacuous`,
          ).toBeGreaterThan(0);
          const adapter = factory();
          const { exec, calls } = recordingExec();
          await adapter.injectCredential(testCase.credential, exec);
          for (const payload of allBytesGivenToExec(calls)) {
            // A refresh token inside a sandbox is a credential the platform CANNOT
            // revoke upstream — so unlike RA-14 (argv only, because env is a legitimate
            // channel for a short-lived token), EVERY channel counts here.
            expect(
              payload,
              `${testCase.label}: the real refresh_token reached the sandbox`,
            ).not.toContain(platformOnly.realRefreshToken);
          }
        }
      });

      it('RA-16 (MUST): the injected auth file keeps refresh_token, valued EXACTLY the placeholder', async () => {
        for (const testCase of platformOnlyCases) {
          const platformOnly = testCase.platformOnly;
          if (!platformOnly || platformOnly.expectsSanitizedAuthFile === false) continue;
          const adapter = factory();
          const { exec, calls } = recordingExec();
          await adapter.injectCredential(testCase.credential, exec);
          const values = refreshTokenValuesIn(allBytesGivenToExec(calls));
          // NOT missing: deleting the field makes codex fail with `missing field
          // 'refresh_token'` (05 §1★★ 実測), so "just drop it" is not a valid fix.
          expect(
            values.length,
            `${testCase.label}: no refresh_token field was injected at all — the field must be KEPT`,
          ).toBeGreaterThan(0);
          for (const value of values) {
            // NOT empty, NOT null, NOT the real one: exactly the shared-kernel constant.
            expect(
              value,
              `${testCase.label}: refresh_token must be exactly the shared-kernel placeholder`,
            ).toBe(RUNTIME_REFRESH_TOKEN_PLACEHOLDER);
          }
        }
      });
    } else {
      it.skip('RA-15 / RA-16 (MUST) SKIPPED — no injection case declares `platformOnly` (the real refresh_token this adapter must never inject)', () =>
        undefined);
    }

    if (authFileBearingCases.length > 0) {
      it('RA-17 (MUST): a credential whose record DOES carry a full authFile still leaks nothing', async () => {
        for (const testCase of authFileBearingCases) {
          const platformOnly = testCase.platformOnly;
          const platformAuthFile = platformOnly?.platformAuthFile;
          if (!platformOnly || platformAuthFile === undefined) continue;
          // Non-vacuity first: the fixture must really be the dangerous case.
          expect(
            platformAuthFile,
            `${testCase.label}: the platform auth file fixture must contain the real refresh_token`,
          ).toContain(platformOnly.realRefreshToken);

          const adapter = factory();
          const { exec, calls } = recordingExec();
          await adapter.injectCredential(testCase.credential, exec);
          const payloads = allBytesGivenToExec(calls);
          for (const payload of payloads) {
            expect(
              payload,
              `${testCase.label}: the platform-only auth file reached the sandbox verbatim`,
            ).not.toContain(platformAuthFile);
            expect(
              payload,
              `${testCase.label}: the real refresh_token reached the sandbox`,
            ).not.toContain(platformOnly.realRefreshToken);
          }
          if (platformOnly.expectsSanitizedAuthFile !== false) {
            const values = refreshTokenValuesIn(payloads);
            expect(
              values.length,
              `${testCase.label}: the injected auth file must KEEP the refresh_token field`,
            ).toBeGreaterThan(0);
            for (const value of values) {
              expect(
                value,
                `${testCase.label}: refresh_token must be exactly the shared-kernel placeholder`,
              ).toBe(RUNTIME_REFRESH_TOKEN_PLACEHOLDER);
            }
          }
        }
      });
    } else {
      it.skip('RA-17 (MUST) SKIPPED — no injection case supplies `platformOnly.platformAuthFile` (a credential record that really carries a full auth file)', () =>
        undefined);
    }
  });
}
