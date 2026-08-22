import { expect } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { PasscodeService } from '../../src/platform/access-passcode/passcode.service';

/**
 * Process-env handling for the e2e suite — the ONE place `process.env` is mutated.
 *
 * WHY A HELPER AT ALL: the `e2e` project runs with `poolOptions.forks.singleFork`
 * (BoxLite permits one runtime per home, so every spec shares ONE process). Module
 * state is re-created per file, but `process.env` is process-global and survives —
 * so a spec that ends with a bare `delete process.env.X` does not restore the world,
 * it ERASES it. If the value came from the developer's shell or from CI, every later
 * spec (and every later run in a watch session) silently sees a different platform.
 *
 * The failures that causes are the worst kind: they depend on FILE ORDER, which
 * vitest varies with its duration cache, so CI goes red on a machine that has "always
 * been green" and people learn to just re-run. Save-and-restore removes the whole
 * class rather than the instance.
 *
 * `env-hygiene.e2e-spec.ts` mechanically enforces that this file is the only one
 * doing it.
 */
export type EnvPatch = Record<string, string | undefined>;

/**
 * Apply `patch` (a value of `undefined` UNSETS the key) and return a restore function
 * that puts every touched key back EXACTLY as it was — including "was not set at all",
 * which is what a bare `delete` cannot distinguish from "was set to something".
 */
export function useEnv(patch: EnvPatch): () => void {
  const saved: EnvPatch = {};
  for (const key of Object.keys(patch)) saved[key] = process.env[key];
  apply(patch);
  return () => apply(saved);
}

function apply(vars: EnvPatch): void {
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

/**
 * Assert the app under test really got the passcode configuration the spec assumes.
 *
 * `PasscodeService.enabled` is a CONSTRUCTION-TIME snapshot of `ACCESS_PASSCODE`, so
 * if the env was wrong at `app.init()` the spec does not fail where the mistake is —
 * it fails much later with something baffling like `expected 200 to be 401` (a guard
 * that silently allows everything, an unlock endpoint that accepts any passcode).
 * Checking the precondition converts that into a message that names the cause.
 */
export function expectPasscodeEnabled(app: INestApplication, enabled: boolean): void {
  const actual = app.get(PasscodeService).enabled;
  expect(
    actual,
    `PasscodeService.enabled is ${actual} but this spec requires ${enabled}. ` +
      '`enabled` is snapshotted from ACCESS_PASSCODE when the Nest app is built, so ' +
      'this means the env was wrong at app.init() — check that every spec mutates ' +
      'process.env through useEnv() from _env.ts (bare `delete process.env.X` leaks ' +
      'across files: the e2e project shares ONE process, singleFork).',
  ).toBe(enabled);
}
