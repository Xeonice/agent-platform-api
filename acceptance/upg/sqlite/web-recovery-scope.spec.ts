import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fromEpochMs } from '@platform/shared-kernel';
import {
  createConnection,
  runMigrations,
  type Connection,
} from '../../../apps/api/src/platform/persistence/drizzle.connection';
import { UpgradeStore } from '../../../apps/api/src/platform/upgrade/upgrade-store';
import {
  assertRecoveryTargets,
  persistedFaultScope,
} from '../../../apps/api/src/platform/upgrade/upgrade-web-recovery';
import { useEnv } from '../../support/strict-ports';

// Actual SQLite fault history and the production fixed-target guard only.
// These checks do not fabricate positive artifact/health/owner qualification.
let connection: Connection, store: UpgradeStore, restore: () => void;
beforeEach(() => {
  restore = useEnv({ PLATFORM_INSTANCE_ID: 'web-recovery-scope-state-only' });
  connection = createConnection(':memory:');
  runMigrations(connection.db, connection.sqlite);
  store = new UpgradeStore(
    connection.sqlite,
    { now: () => fromEpochMs(1_760_000_000_000) },
    { next: randomUUID },
  );
  // The narrow history table fixture intentionally omits upgrade intent FK;
  // intent acceptance/activation/recovery is covered by the real Store suite.
  connection.sqlite.exec(
    'DROP TABLE upgrade_events; CREATE TABLE upgrade_events(attempt_id TEXT,sequence INTEGER,kind TEXT,payload TEXT);',
  );
});
afterEach(() => {
  connection.sqlite.close();
  restore();
});
function event(sequence: number, kind: string, payload: unknown) {
  connection.sqlite
    .prepare('INSERT INTO upgrade_events VALUES(?,?,?,?)')
    .run('attempt-state-only', sequence, kind, JSON.stringify(payload));
}
describe('web-only recovery authority cannot grow beyond measured history or fixed plan', () => {
  it('requires a persisted failure, ignoring progress/caller-like evidence and preserving its exact single component scope', () => {
    event(1, 'progress', { evidence: { componentScope: ['web'] } });
    expect(persistedFaultScope(store, 'attempt-state-only')).toEqual([]);
    event(2, 'failed', { reason: 'web-build unavailable', evidence: { componentScope: ['web'] } });
    expect(persistedFaultScope(store, 'attempt-state-only')).toEqual(['web']);
    event(3, 'ready-revoked', {
      reason: 'shared state unknown',
      evidence: { componentScope: ['web', 'coordinator'] },
    });
    expect(persistedFaultScope(store, 'attempt-state-only')).toEqual([]);
  });
  it('does not borrow a fault from another attempt or an older narrow failure after a newer unknown failure', () => {
    event(1, 'failed', { evidence: { componentScope: ['web'] } });
    expect(persistedFaultScope(store, randomUUID())).toEqual([]);
    event(2, 'failed', { reason: 'unknown failure domain' });
    expect(persistedFaultScope(store, 'attempt-state-only')).toEqual([]);
  });
  it('allows only the same retained Web pointer with no API, coordinator or owner action', () => {
    const fixed = {
      api: null,
      coordinator: null,
      owner: null,
      web: { origin: 'http://127.0.0.1:7101', digest: 'retained-web-A' },
      componentScope: ['web'],
    };
    expect(() =>
      assertRecoveryTargets(fixed, { ...fixed, observedAt: 'live-proof-time', healthy: true }),
    ).not.toThrow();
    for (const field of ['api', 'coordinator', 'owner'])
      expect(() =>
        assertRecoveryTargets(fixed, { ...fixed, [field]: { origin: 'http://127.0.0.1:7102' } }),
      ).toThrow('RECOVERY_TARGET_OR_SCOPE_CHANGED');
    expect(() =>
      assertRecoveryTargets(fixed, { ...fixed, componentScope: ['web', 'api'] }),
    ).toThrow('RECOVERY_TARGET_OR_SCOPE_CHANGED');
    expect(() =>
      assertRecoveryTargets(fixed, { ...fixed, web: { ...fixed.web, digest: 'another-Web' } }),
    ).toThrow('RECOVERY_TARGET_OR_SCOPE_CHANGED');
    expect(() =>
      assertRecoveryTargets(fixed, {
        ...fixed,
        web: { ...fixed.web, origin: 'http://127.0.0.1:7103' },
      }),
    ).toThrow('RECOVERY_TARGET_OR_SCOPE_CHANGED');
  });
});
