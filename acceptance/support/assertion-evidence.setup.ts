import { appendFileSync } from 'node:fs';
import { afterEach, expect } from 'vitest';

// Vitest's actual matcher evaluation count is distinct from test count and source sites.
// Retried polling checks are evaluations too; this number is evidence, never a quality gate.
afterEach(() => {
  const target = process.env.ACCEPTANCE_ASSERTION_EVIDENCE;
  if (target === undefined) return;
  const state = expect.getState();
  appendFileSync(
    target,
    `${JSON.stringify({ test: state.currentTestName, evaluations: state.assertionCalls })}\n`,
  );
});
