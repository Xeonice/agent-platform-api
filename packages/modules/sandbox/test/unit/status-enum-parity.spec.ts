import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  SANDBOX_STATUSES as CONTRACT_STATUSES,
  SandboxProviderErrorCode,
  TaskErrorCodeSchema,
  UnknownRuntimeError,
} from '@platform/contracts';
import { SANDBOX_STATUSES as DOMAIN_STATUSES } from '../../src/domain/value-objects/sandbox-status.vo';
import { TASK_STATUSES as DOMAIN_TASK_STATUSES } from '../../src/domain/value-objects/agent-task-status.vo';

/**
 * Equivalence guard (P1-3): the 12-value SandboxStatus enum is duplicated across
 * FOUR sources — domain value object, contracts zod enum, DB CHECK, migration SQL.
 * Tests are exempt from boundaries, so this is the one place that can import both
 * domain and contracts and assert they (and the persisted CHECK) never drift.
 */

/** Parse the allowed set out of the committed migration's `sandboxes_status_ck`. */
function dbCheckStatuses(): string[] {
  const dir = resolve(process.cwd(), 'drizzle');
  const sqlFile = readdirSync(dir).find((f) => f.endsWith('.sql'));
  if (!sqlFile) throw new Error('no migration .sql found under ./drizzle');
  const sql = readFileSync(resolve(dir, sqlFile), 'utf8');
  const from = sql.indexOf('sandboxes_status_ck');
  if (from < 0) throw new Error('sandboxes_status_ck not found in migration');
  const inList = sql.slice(from).match(/IN\s*\(([^)]+)\)/i);
  if (!inList) throw new Error('IN(...) list not found for sandboxes_status_ck');
  return [...inList[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

const sorted = (xs: readonly string[]) => [...xs].sort();

describe('SandboxStatus enum parity across its 4 copies', () => {
  it('domain literals === contracts SANDBOX_STATUSES', () => {
    expect(sorted(DOMAIN_STATUSES)).toEqual(sorted(CONTRACT_STATUSES));
  });

  it('DB CHECK allowed set === contracts SANDBOX_STATUSES', () => {
    expect(sorted(dbCheckStatuses())).toEqual(sorted(CONTRACT_STATUSES));
  });

  it('all four agree on exactly 12 values', () => {
    expect(DOMAIN_STATUSES).toHaveLength(12);
    expect(CONTRACT_STATUSES).toHaveLength(12);
    expect(dbCheckStatuses()).toHaveLength(12);
  });

  it('`waiting-input` is excluded from every copy (it is a runtime sub-state only)', () => {
    expect(DOMAIN_STATUSES).not.toContain('waiting-input');
    expect(CONTRACT_STATUSES).not.toContain('waiting-input');
    expect(dbCheckStatuses()).not.toContain('waiting-input');
  });
});

/**
 * `TaskErrorCodeSchema` is the CLOSED SET the frontend generates its vocabulary from
 * (it rides `AgentTaskDto.errorCode` into openapi.json). A closed set is only useful
 * while it is actually closed, and nothing about writing `errorCode: someString` in the
 * workflow would make this file fail — so the producers are enumerated here instead.
 *
 * There are exactly three of them:
 *   `TASK_${status.toUpperCase()}` for every non-succeeded terminal status (finalize),
 *   the platform's own recovery codes (`SANDBOX_GONE`, `RESUME_FAILED`, `UNKNOWN_RUNTIME`),
 *   and every `SandboxProviderErrorCode`, because `failWith` copies `e.code` verbatim.
 */
describe('the task error-code enum is the CLOSED set the frontend can rely on', () => {
  const declared = new Set<string>(TaskErrorCodeSchema.options);

  it('covers every `TASK_<STATUS>` the finalize path can mint', () => {
    const produced = DOMAIN_TASK_STATUSES.filter((s) => s !== 'running' && s !== 'succeeded').map(
      (s) => `TASK_${s.toUpperCase()}`,
    );
    expect(produced.length).toBeGreaterThan(0);
    for (const code of produced) expect(declared).toContain(code);
  });

  it('covers every provider error code, because `failWith` copies `e.code` verbatim', () => {
    for (const code of Object.values(SandboxProviderErrorCode)) expect(declared).toContain(code);
  });

  it('covers the platform’s own recovery codes and the INTERNAL fallback', () => {
    for (const code of ['SANDBOX_GONE', 'RESUME_FAILED', 'INTERNAL']) {
      expect(declared).toContain(code);
    }
  });

  /**
   * `UNKNOWN_RUNTIME` is declared because a REAL class mints it, not because someone
   * liked the name — the code is read off the error itself, so this fails if the class
   * is renamed, retyped, or deleted.
   *
   * It reaches `AgentTaskDto.errorCode` through `failWith`, which copies `e.code`
   * verbatim: `runtimes.get(task.runtime)` throws it when a task outlives the
   * out-of-tree module that registered its adapter (04 §8). Before it existed that
   * throw was a bare `Error` and landed as `INTERNAL`; on the install path it was
   * borrowed from `INSTALL_FAILED`, which says an install failed — and is retryable,
   * which this is not.
   */
  it('covers UNKNOWN_RUNTIME, and its producer really is the error class', () => {
    expect(new UnknownRuntimeError('nope').code).toBe('UNKNOWN_RUNTIME');
    expect(new UnknownRuntimeError('nope').retryable).toBe(false);
    expect(declared).toContain('UNKNOWN_RUNTIME');
  });

  it('declares NOTHING the backend cannot produce — a code with no producer is a lie', () => {
    const producible = new Set<string>([
      ...DOMAIN_TASK_STATUSES.filter((s) => s !== 'running' && s !== 'succeeded').map(
        (s) => `TASK_${s.toUpperCase()}`,
      ),
      ...Object.values(SandboxProviderErrorCode),
      'SANDBOX_GONE',
      'RESUME_FAILED',
      new UnknownRuntimeError('x').code,
    ]);
    expect([...declared].filter((c) => !producible.has(c))).toEqual([]);
  });

  it('is a set of CODES, never sentences (P22 §1)', () => {
    for (const code of declared) expect(code).toMatch(/^[A-Z][A-Z0-9_]*$/);
  });
});
