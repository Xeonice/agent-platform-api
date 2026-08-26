/**
 * Golden contract testkit (docs/backend/04 §10). REQUIRED CI check (09 §2.3).
 *
 * The SAME suites run against the built-in implementations and against any
 * third-party one — no double standard:
 *   - `runSandboxProviderContractTests` — `aio` / `boxlite` / a fake / yours.
 *     Static clauses always run; the live ones need `opts.context` + a reachable
 *     sandbox host and report as SKIPPED (with a reason) otherwise.
 *   - `runRuntimeAdapterContractTests` — `codex` / `claude-code` / yours. Covers
 *     only clauses that need no real CLI and no network, so it runs everywhere.
 *   - `runImageSpecContractTests` — the built-in OCI provider / yours (04 §10.4
 *     IS-01..IS-05). The caller supplies a fixture registry, so no network either.
 *
 * The RuntimeAdapter golden-output fixtures live under ./fixtures (04 §10.3 RA-04)
 * with a CLI-VERSION-MATRIX placeholder.
 */
export {
  runSandboxProviderContractTests,
  type SandboxProviderTestOptions,
} from './sandbox-provider.testkit';
export { runImageSpecContractTests, type ImageSpecTestCase } from './image-spec.testkit';
export {
  runRuntimeAdapterContractTests,
  type RuntimeAdapterInjectionCase,
  type RuntimeAdapterTestOptions,
} from './runtime-adapter.testkit';

export { UNSUPPORTED_CAPABILITY } from '../sandbox-provider.contract';
