import { describe, it, expect } from 'vitest';
import { buildChildEnv } from '../../src/infrastructure/git/git-spawn';

/**
 * ★ 03 §7.3 G — the credential context spawns git with a MATERIALIZED token in env.
 * That makes it the path where a host-set trace costs the most: `GIT_TRACE_CURL` prints
 * `Authorization: Basic base64(x-access-token:<PAT>)`, and the trace lands in stderr,
 * which the platform tails into `stderrTail`.
 *
 * The guard here mirrored project's — including its bug. Both listed FOUR literals under
 * a comment promising 「the GIT_TRACE* family」, and both therefore let through:
 *
 *   · `GIT_TRACE2_ENV_VARS=GIT_TOKEN` — writes the token's VALUE into the trace, no
 *     redaction involved because git is being asked to print it on purpose;
 *   · `GIT_TRACE2_REDACT=0` — turns OFF the redaction that would otherwise mask the
 *     `Authorization:` header, i.e. re-opens exactly the hole the four literals closed.
 *
 * ⚠️ TWO GUARDS, ONE RULE. This file exists as a SEPARATE spec (not a shared helper)
 * because the two lists live in two modules that must not import each other — and a
 * divergence between them is invisible in either module's own tests. The project-side
 * twin is in `project/test/unit/git-clone.spec.ts`; if you change one, this one is the
 * thing that notices you did not change the other.
 *
 * MUTATION: delete `GIT_TRACE_PREFIX.test(upper)` from `cleanAmbientEnv` ⇒ red.
 */
const TRACE_FAMILY = [
  'GIT_TRACE',
  'GIT_TRACE_CURL',
  'GIT_TRACE_PACKET',
  'GIT_TRACE2',
  'GIT_TRACE2_EVENT',
  'GIT_TRACE2_PERF',
  'GIT_TRACE2_ENV_VARS',
  'GIT_TRACE2_REDACT',
  'GIT_TRACE_REDACT',
  'GIT_TRACE_SETUP',
  'GIT_TRACE_PERFORMANCE',
  'GIT_TRACE_PACK_ACCESS',
  'GIT_TRACE_SHALLOW',
  'GIT_TRACE_REFS',
];

describe('buildChildEnv strips the whole GIT_TRACE* family (03 §7.3 G)', () => {
  const names = [...TRACE_FAMILY, 'GIT_CURL_VERBOSE'];

  it('no trace variable survives into a credentialed git child', () => {
    const saved = new Map(names.map((k) => [k, process.env[k]]));
    for (const k of names) process.env[k] = '1';
    process.env.GIT_TRACE2_ENV_VARS = 'GIT_TOKEN'; // "print $GIT_TOKEN into the trace"
    process.env.GIT_TRACE2_REDACT = '0'; // "and don't redact the Authorization header"
    try {
      // a realistic injected auth: the materialized token IS in the child's env, which
      // is the whole reason a trace must not be.
      const env = buildChildEnv({ env: { GIT_TOKEN: 'ghp_secret', GIT_CONFIG_COUNT: '1' } });
      for (const k of names) {
        expect(env[k], `${k} would print the injected GIT_TOKEN into stderrTail`).toBeUndefined();
      }
      // the token itself is still delivered — the guard strips the trace, not the auth.
      expect(env.GIT_TOKEN).toBe('ghp_secret');
      expect(env.GIT_TERMINAL_PROMPT).toBe('0');
    } finally {
      for (const [k, v] of saved) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it('a var that merely contains the prefix later in its name is kept', () => {
    const saved = process.env.MY_GIT_TRACE_HELPER;
    process.env.MY_GIT_TRACE_HELPER = 'keep-me';
    try {
      expect(buildChildEnv({}).MY_GIT_TRACE_HELPER).toBe('keep-me');
    } finally {
      if (saved === undefined) delete process.env.MY_GIT_TRACE_HELPER;
      else process.env.MY_GIT_TRACE_HELPER = saved;
    }
  });
});
