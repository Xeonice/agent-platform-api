import { assertDefined } from '../../support/assert-defined';
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UpgradeSourceActualSchema, type UpgradeSourceActual } from '@platform/contracts';
import { upgradeDigest } from '../../../apps/api/src/platform/upgrade/upgrade-trust';
import { UpgradeStore } from '../../../apps/api/src/platform/upgrade/upgrade-store';
import { UpgradeProjection } from '../../../apps/api/src/platform/upgrade/upgrade-projection';
import type { UpgradeInspector } from '../../../apps/api/src/platform/upgrade/upgrade-inspector';
import { currentDatabase } from '../../support/sqlite';
import { deferred, useEnv } from '../../support/strict-ports';
import { planFixtureSource } from '../../support/upgrade-plan-fixture';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
async function fixture() {
  const server = createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end('{"status":"ok"}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const restore = useEnv({
    PLATFORM_INSTANCE_ID: 'projection-physical-fixture',
    PLATFORM_ENTRY_ORIGIN: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
  });
  let now = Date.now();
  const clock = { now: () => new Date(now) },
    db = currentDatabase(),
    store = new UpgradeStore(db.sqlite, clock, { next: randomUUID }),
    source = planFixtureSource();
  store.bootstrap(source);
  const proof = deferred<{ qualified: boolean }>();
  const inspectorBoundary: Partial<UpgradeInspector> = {
    entryBinding: async () => ({ web: { digest: source.components.web.artifactDigest } }),
    installedProof: () => proof.promise,
    webBuild: async () => ({
      webRevision: source.components.web.webRevision,
      releaseId: source.releaseId,
    }),
    sourceActual: async () => null,
  };
  const inspector = inspectorBoundary as UpgradeInspector;
  const projection = new UpgradeProjection(store, undefined as never, inspector, clock);
  cleanups.push(async () => {
    proof.resolve({ qualified: false });
    projection.onModuleDestroy();
    db.sqlite.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    restore();
  });
  return {
    db,
    store,
    source,
    proof,
    projection,
    inspector,
    clock,
    advance: (ms: number) => {
      now += ms;
    },
  };
}
describe('lightweight durable UI facts, separate from live installation gates', () => {
  it('does not persist authentication data and withdraws ready after five seconds without refreshing evidence on read', async () => {
    const f = await fixture();
    expect(f.projection.view()).toMatchObject({
      serviceState: 'unknown',
      observation: { state: 'checking', confirmedAt: null },
    });
    f.proof.resolve({ qualified: true });
    await f.projection.refreshPhysical();
    const fresh = f.projection.view();
    expect(fresh).toMatchObject({
      serviceState: 'confirmed',
      availableWeb: { ready: true },
      serviceAvailability: { state: 'available' },
      observation: { state: 'fresh' },
    });
    const row = f.db.sqlite
      .prepare("SELECT result FROM platform_operations WHERE role='upgrade-observation'")
      .get() as { result: string };
    expect(row.result).not.toMatch(/csrfToken|userScope|principal|capabilities|actorId|cookie/i);
    f.advance(5001);
    expect(f.projection.view()).toMatchObject({
      serviceState: 'unknown',
      availableWeb: null,
      repairableCurrent: null,
      observation: { state: 'stale', confirmedAt: fresh.observation.confirmedAt },
    });
    expect(f.projection.view().observation.confirmedAt).toBe(fresh.observation.confirmedAt);
    const resumed = new UpgradeProjection(f.store, undefined as never, undefined as never, {
      now: () => new Date(Date.parse(assertDefined(fresh.observation.confirmedAt)) + 5002),
    });
    expect(resumed.view().observation.state).toBe('stale');
  });
  it('a healthy entry does not prove the target installed, and an await racing ready revocation never restores ready', async () => {
    const f = await fixture();
    const refreshing = f.projection.refreshPhysical();
    f.db.sqlite
      .prepare(
        "UPDATE upgrade_instances SET ready=0,service_state='transitioning' WHERE instance_id=?",
      )
      .run(f.store.instanceId);
    f.proof.resolve({ qualified: true });
    await refreshing;
    expect(f.projection.view()).toMatchObject({
      serviceState: 'transitioning',
      availableWeb: null,
      observation: { state: 'checking' },
    });
    expect(
      f.db.sqlite
        .prepare("SELECT count(*) n FROM platform_operations WHERE role='upgrade-observation'")
        .get(),
    ).toEqual({ n: 0 });
  });
  it('a long proof cannot use its completion time to make old evidence fresh', async () => {
    const f = await fixture();
    const refreshing = f.projection.refreshPhysical();
    f.advance(6000);
    f.proof.resolve({ qualified: true });
    await refreshing;
    expect(f.projection.view()).toMatchObject({
      serviceState: 'unknown',
      availableWeb: null,
      observation: { state: 'stale' },
    });
  });
  it('a newly measured partial tuple can become fresh after a long check without granting a full confirmed release or keeping repair past five seconds', async () => {
    const f = await fixture();
    f.db.sqlite
      .prepare(
        "UPDATE upgrade_instances SET ready=0,service_state='transitioning' WHERE instance_id=?",
      )
      .run(f.store.instanceId);
    const partial = deferred<UpgradeSourceActual | null>();
    vi.spyOn(f.inspector, 'sourceActual').mockImplementation(() => partial.promise);
    const refreshing = f.projection.refreshPhysical();
    f.advance(6000);
    const facts = {
      schemaVersion: 1,
      qualified: true,
      partial: true,
      instanceId: f.store.instanceId,
      baseConfirmedReleaseId: f.source.releaseId,
      activationGeneration: 1,
      schema: f.source.schema,
      components: f.source.components,
      observedAt: f.clock.now().toISOString(),
    };
    partial.resolve(
      UpgradeSourceActualSchema.parse({ ...facts, proofDigest: upgradeDigest(facts) }),
    );
    await refreshing;
    expect(f.projection.view()).toMatchObject({
      serviceState: 'transitioning',
      availableWeb: null,
      repairableCurrent: { observedAt: facts.observedAt },
      observation: { state: 'fresh', confirmedAt: facts.observedAt },
    });
    f.advance(5001);
    expect(f.projection.view()).toMatchObject({
      availableWeb: null,
      repairableCurrent: null,
      observation: { state: 'stale' },
    });
  });
});
