import 'reflect-metadata';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fromEpochMs } from '@platform/shared-kernel';
import { createUpgradeControlStores } from '../../../apps/api/src/platform/upgrade/control-store-factory';
import {
  UpgradeStore,
  type UpgradeCommit,
} from '../../../apps/api/src/platform/upgrade/upgrade-store';
import {
  freezeUpgradePlan,
  upgradeDigest,
} from '../../../apps/api/src/platform/upgrade/upgrade-trust';
import { planFixtureEnvelope, planFixtureSource } from '../../support/upgrade-plan-fixture';

let directory: string, sqlite: Database.Database, now: number;
const clock = { now: () => fromEpochMs(now) },
  ids = { next: randomUUID };
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'control-store-only-'));
  sqlite = new Database(join(directory, 'control.db'));
  sqlite.pragma('journal_mode = WAL');
  now = Date.parse('2026-10-20T00:00:00Z');
});
afterEach(() => {
  sqlite.close();
  rmSync(directory, { recursive: true, force: true });
});
function fixture(guard = true) {
  const stores = createUpgradeControlStores({
    sqlite,
    instanceId: 'control-store-fixture',
    clock,
    ids,
    ...(guard ? { claimGuard: () => null } : {}),
    dataFormatGuard: () => {},
  });
  const source = planFixtureSource(),
    envelope = planFixtureEnvelope(source, '0.2.1'),
    plan = freezeUpgradePlan(envelope, source);
  stores.store.bootstrap(source);
  const attempt = stores.store.accept(
    'state-fixture-admin',
    {
      requestId: randomUUID(),
      targetReleaseId: envelope.manifest.releaseId,
      targetDigest: envelope.manifestDigest,
      expectedActivationGeneration: 1,
    },
    envelope,
    plan,
  );
  return { ...stores, attempt, plan };
}
function command(
  store: UpgradeStore,
  id: string,
  kind: UpgradeCommit['kind'],
  payload: Record<string, unknown>,
): UpgradeCommit {
  const row = store.snapshot(id);
  return {
    fence: row.fence,
    generation: row.attempt.generation,
    expectedSequence: row.attempt.sequence,
    eventId: randomUUID(),
    kind,
    payload,
  };
}

describe('independent control schema, atomic authority and bounded receipts', () => {
  it('requires an explicit claim guard and contains no business tables or SDK startup', () => {
    const f = fixture(false);
    expect(() => f.store.claim(f.attempt.attemptId, 'fixture-controller', 30000)).toThrow(
      'CONTROL_CLAIM_GUARD_REQUIRED',
    );
    const tables = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    expect(tables).not.toContainEqual({ name: 'platform_role_leases' });
    expect(tables).not.toContainEqual({ name: 'projects' });
    expect(tables).not.toContainEqual({ name: '__drizzle_migrations' });
    const factory = resolve('apps/api/dist/platform/upgrade/control-store-factory.js');
    const output = execFileSync(
      process.execPath,
      [
        '-e',
        `require(${JSON.stringify(factory)}); require(${JSON.stringify(resolve('apps/api/dist/platform/upgrade/upgrade-service.js'))}); require(${JSON.stringify(resolve('apps/api/dist/platform/upgrade/upgrade-catalog.js'))}); require(${JSON.stringify(resolve('apps/api/dist/platform/upgrade/upgrade-projection.js'))}); require(${JSON.stringify(resolve('apps/api/dist/platform/upgrade/upgrade-contract-service.js'))}); process.stdout.write(JSON.stringify(Object.keys(require.cache).filter(p => /platform\\.module|app\\.module|boxlite|sandbox[\\/]dist/.test(p))))`,
      ],
      { encoding: 'utf8' },
    );
    expect(JSON.parse(output)).toEqual([]);
  });

  it('keeps control data out of the business handle and constructs readonly without inserting', () => {
    const f = fixture();
    const business = new Database(':memory:');
    business.exec(
      "CREATE TABLE sentinel(value TEXT); INSERT INTO sentinel VALUES('business-only')",
    );
    const readonly = new Database(join(directory, 'control.db'), { readonly: true });
    try {
      const projected = new UpgradeStore(business, clock, ids, {
        instanceId: f.store.instanceId,
        ledgerSqlite: readonly,
        readonly: true,
      });
      expect(projected.sqlite).toBe(business);
      expect(projected.snapshot(f.attempt.attemptId).attempt.attemptId).toBe(f.attempt.attemptId);
      expect(() => projected.bootstrap(planFixtureSource())).toThrow();
      expect(business.prepare('SELECT * FROM sentinel').all()).toEqual([
        { value: 'business-only' },
      ]);
      expect(
        business.prepare("SELECT name FROM sqlite_master WHERE name='upgrade_instances'").get(),
      ).toBeUndefined();
    } finally {
      readonly.close();
      business.close();
    }
    expect(() =>
      createUpgradeControlStores({ sqlite, instanceId: 'other-instance', clock, ids }),
    ).toThrow('CONTROL_SCHEMA_OR_INSTANCE_MISMATCH');
  });

  it('uses narrow indexed authority/renew/checkpoint and keeps large receipts intact', () => {
    const f = fixture(),
      id = f.attempt.attemptId,
      claim = f.store.claim(id, 'fixture-controller', 30000);
    const evidence = { fixture: 'opaque-state-proof-only', bytes: 'x'.repeat(1_800_000) };
    const material = command(f.store, id, 'step-applied', {
      stepId: 'package-download',
      completedWork: 1000,
      evidence,
      receiptDigest: upgradeDigest(evidence),
    });
    const applied = f.store.commitReceipt(id, material);
    expect(Buffer.byteLength(JSON.stringify(applied))).toBeLessThan(1024);
    const original = sqlite
      .prepare(
        'SELECT evidence,evidence_digest,receipt_digest FROM upgrade_steps WHERE attempt_id=? AND step_id=?',
      )
      .get(id, 'package-download');
    const snapshot = vi.spyOn(f.store, 'snapshot'),
      queries = vi.spyOn(sqlite, 'prepare');
    try {
      const check = f.store.authorityCheck(id, claim.fence, claim.generation);
      now += 1000;
      expect(
        f.store.leaseRenew(id, claim.fence, claim.generation, 'fixture-controller').leaseExpiresAt,
      ).toBe(now + 30000);
      const checkpoint = f.store.progressCheckpoint(id, claim.fence, claim.generation);
      expect(checkpoint.step?.evidenceDigest).toBe(upgradeDigest(evidence));
      const heartbeat: UpgradeCommit = {
        fence: claim.fence,
        generation: claim.generation,
        expectedSequence: check.sequence,
        eventId: randomUUID(),
        kind: 'progress',
        payload: {
          stepId: 'package-download',
          completedWork: 1000,
          totalWork: 1000,
          stage: check.state,
          evidenceDigest: checkpoint.step?.evidenceDigest,
        },
      };
      const receipt = f.store.commitReceipt(id, heartbeat);
      expect(receipt.eventSequence).toBe(check.sequence + 1);
      expect(f.store.commitReceipt(id, heartbeat)).toEqual(receipt);
      expect(() =>
        f.store.commitReceipt(id, {
          ...heartbeat,
          payload: { ...heartbeat.payload, evidenceDigest: upgradeDigest({ forged: true }) },
        }),
      ).toThrow('UPGRADE_EVENT_PAYLOAD_CONFLICT');
      expect(snapshot).not.toHaveBeenCalled();
      expect(
        queries.mock.calls.some(([sql]) =>
          /SELECT\s+\*|max\s*\(|SELECT[^;]*\bevidence\b/i.test(sql),
        ),
      ).toBe(false);
    } finally {
      queries.mockRestore();
      snapshot.mockRestore();
    }
    expect(
      sqlite
        .prepare(
          'SELECT evidence,evidence_digest,receipt_digest FROM upgrade_steps WHERE attempt_id=? AND step_id=?',
        )
        .get(id, 'package-download'),
    ).toEqual(original);
    for (const sql of [
      'SELECT attempt_id FROM upgrade_attempts WHERE instance_id=? ORDER BY generation DESC,rowid DESC LIMIT 1',
      "SELECT fence FROM platform_operations WHERE instance_id=? AND role='project-name-contract' ORDER BY fence DESC LIMIT 1",
    ]) {
      const details = sqlite.prepare('EXPLAIN QUERY PLAN ' + sql).all(f.store.instanceId);
      expect(JSON.stringify(details)).not.toMatch(/SCAN|TEMP B-TREE/);
    }
  });

  it('rejects stale generation, wrong holder, superseded and expired authority without resurrecting leases', () => {
    const f = fixture(),
      id = f.attempt.attemptId,
      claim = f.store.claim(id, 'fixture-controller', 30000);
    const expiry = f.store.authorityCheck(id, claim.fence).leaseExpiresAt;
    expect(() =>
      f.store.leaseRenew(id, claim.fence, claim.generation + 1, 'fixture-controller'),
    ).toThrow('UPGRADE_FENCE_EXPIRED');
    expect(() => f.store.leaseRenew(id, claim.fence, claim.generation, 'other-controller')).toThrow(
      'UPGRADE_CONTROLLER_MISMATCH',
    );
    expect(f.store.authorityCheck(id, claim.fence).leaseExpiresAt).toBe(expiry);
    now = expiry;
    expect(() =>
      f.store.leaseRenew(id, claim.fence, claim.generation, 'fixture-controller'),
    ).toThrow('UPGRADE_FENCE_EXPIRED');
    expect(
      sqlite.prepare('SELECT lease_expires_at FROM upgrade_attempts WHERE attempt_id=?').get(id),
    ).toEqual({ lease_expires_at: expiry });
    now -= 1;
    sqlite
      .prepare('INSERT INTO platform_operations VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(
        randomUUID(),
        f.store.instanceId,
        'fixture-admin',
        'project-name-contract',
        claim.fence + 1,
        'fixture-only',
        'completed',
        null,
        now,
        now,
      );
    expect(() => f.store.authorityCheck(id, claim.fence)).toThrow('UPGRADE_AUTHORITY_SUPERSEDED');
  });

  it('invalidates a digest when a legacy writer changes evidence and rejects business DB adoption', () => {
    const f = fixture(),
      id = f.attempt.attemptId,
      claim = f.store.claim(id, 'fixture-controller', 30000);
    f.store.commitReceipt(
      id,
      command(f.store, id, 'progress', {
        stepId: 'package-download',
        completedWork: 3,
        evidence: { before: true },
      }),
    );
    expect(f.store.progressCheckpoint(id, claim.fence, claim.generation).step?.evidenceDigest).toBe(
      upgradeDigest({ before: true }),
    );
    sqlite
      .prepare('UPDATE upgrade_steps SET evidence=? WHERE attempt_id=? AND step_id=?')
      .run(JSON.stringify({ legacy: true }), id, 'package-download');
    expect(
      f.store.progressCheckpoint(id, claim.fence, claim.generation).step?.evidenceDigest,
    ).toBeNull();
    const business = new Database(':memory:');
    business.exec('CREATE TABLE platform_role_leases(role TEXT)');
    try {
      expect(() =>
        createUpgradeControlStores({ sqlite: business, instanceId: 'other', clock, ids }),
      ).toThrow('CONTROL_DATABASE_MUST_BE_INDEPENDENT');
    } finally {
      business.close();
    }
  });
});
