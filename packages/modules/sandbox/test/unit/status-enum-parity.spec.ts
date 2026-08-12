import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import { SANDBOX_STATUSES as CONTRACT_STATUSES } from '@platform/contracts';
import { SANDBOX_STATUSES as DOMAIN_STATUSES } from '../../src/domain/value-objects/sandbox-status.vo';

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
