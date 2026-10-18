import { UpgradePlanSchema } from '@platform/contracts';
import { optionalUpgradeRecord, upgradeRecord, upgradeRecords } from './upgrade-values';
import { statfs } from 'node:fs/promises';
import { resolve } from 'node:path';
import { freemem } from 'node:os';
import { getHeapStatistics } from 'node:v8';
import type { Clock } from '@platform/shared-kernel';
import { ConfirmedServiceReleaseSchema, SignedUpgradeManifestSchema } from '@platform/contracts';
import type { UpgradeStore } from './upgrade-store';
import type { UpgradeInspector } from './upgrade-inspector';
import { loopbackOrigin } from './upgrade-inspector';
import { canonicalUpgrade, requireUpgrade, upgradeDigest } from './upgrade-trust';
import { env } from '../config/env';
import { initialSourceActivation } from './upgrade-artifact-proof';

type Json = Record<string, unknown>;
/** Every action stays within the independently persisted recovery plan. */
export function assertRecoveryTargets(plan: Json, eligibility: Json): void {
  for (const field of ['api', 'web', 'coordinator', 'owner', 'componentScope'])
    requireUpgrade(
      canonicalUpgrade(plan[field] ?? null) === canonicalUpgrade(eligibility[field] ?? null),
      'RECOVERY_TARGET_OR_SCOPE_CHANGED',
    );
}
/** A measured failure domain cannot expand a fixed user's recovery authority. */
export function persistedFaultScope(store: UpgradeStore, id: string): string[] {
  const row = store.sqlite
    .prepare<unknown[], { payload: string }>(
      "SELECT payload FROM upgrade_events WHERE attempt_id=? AND kind IN ('failed','ready-revoked') ORDER BY sequence DESC LIMIT 1",
    )
    .get(id);
  if (!row) return [];
  const payload = upgradeRecord(JSON.parse(row.payload)),
    fault = optionalUpgradeRecord(payload.evidence);
  const scope = fault?.componentScope;
  return Array.isArray(scope) && scope.length === 1 && scope[0] === 'web' ? ['web'] : [];
}
export async function qualifyWebRecovery(
  store: UpgradeStore,
  inspector: UpgradeInspector,
  clock: Clock,
  id: string,
  fence: number,
): Promise<Json> {
  store.assertFence(id, fence);
  const snapshot = store.snapshot(id),
    source = snapshot.sourceActivation,
    m = snapshot.manifest,
    sourceWeb = snapshot.sourceActual?.components.web ?? source.components.web;
  requireUpgrade(persistedFaultScope(store, id).join(',') === 'web', 'WEB_FAULT_SCOPE_UNCONFIRMED');
  const fallback = snapshot.plan.policy.fallbacks.find(
    (p) =>
      p.webDigest === sourceWeb.artifactDigest && (p.rehearsed || m.purpose === 'qualification'),
  );
  requireUpgrade(fallback, 'WEB_FALLBACK_POLICY_UNQUALIFIED');
  const binding = await inspector.entryBinding();
  const retained = upgradeRecords([
    binding.web,
    ...(Array.isArray(binding.retainedWeb) ? upgradeRecords(binding.retainedWeb) : []),
  ]);
  const web = retained.find((w) => w.digest === sourceWeb.artifactDigest);
  requireUpgrade(web, 'RETAINED_WEB_UNAVAILABLE');
  const producerResponse = await fetch(loopbackOrigin(web.origin) + '/web-process', {
    signal: AbortSignal.timeout(2000),
  });
  requireUpgrade(producerResponse.ok, 'RETAINED_WEB_PROCESS_UNCONFIRMED');
  const producer = upgradeRecord(await producerResponse.json());
  requireUpgrade(
    producer.instanceId === store.instanceId &&
      producer.artifactDigest === sourceWeb.artifactDigest &&
      producer.webRevision === sourceWeb.webRevision &&
      Number.isSafeInteger(producer.pid) &&
      Number(producer.pid) > 0 &&
      typeof producer.startIdentity === 'string' &&
      producer.startIdentity.length > 0,
    'RETAINED_WEB_PROCESS_UNCONFIRMED',
  );

  // Install the hypothetical pointer into a READ-ONLY proof, never the real route.
  const expected = ConfirmedServiceReleaseSchema.parse({
    releaseId: m.releaseId,
    activationGeneration: store.instance().activation_generation,
    activatedAt: clock.now().toISOString(),
    schema: inspector.schema(),
    channel: m.channel,
    components: { ...m.components, web: sourceWeb },
    commits: m.commits,
    productionWebBinding: String(web.origin),
  });
  const proof = await inspector.installedProof(expected, { ...binding, web });
  requireUpgrade(proof.qualified === true, 'HEALTHY_CURRENT_API_COMBINATION_UNCONFIRMED');
  const api = upgradeRecord(binding.weight === 100 ? binding.candidateApi : binding.oldApi);
  const auth = await inspector.authenticationContinuity(id, fence, api.origin);
  const continuity = await inspector.continuity(id, fence);
  const compatible = [sourceWeb, m.components.web].every(
    (w) =>
      m.components.api.protocol.min <= w.protocol.max &&
      m.components.api.protocol.max >= w.protocol.min,
  );
  requireUpgrade(
    auth &&
      compatible &&
      continuity.qualified === true &&
      store.sqlite.pragma('quick_check', { simple: true }) === 'ok',
    'WEB_RECOVERY_SHARED_STATE_UNCONFIRMED',
  );
  const owners = optionalUpgradeRecord(continuity.owner)?.owners;
  const allOwnersCompatible =
    Array.isArray(owners) &&
    owners.length > 0 &&
    owners.every((o) => {
      const range = optionalUpgradeRecord(upgradeRecord(o).protocol);
      return (
        range &&
        Number(range.min) <= m.components.coordinator.protocol.max &&
        Number(range.max) >= m.components.coordinator.protocol.min
      );
    });
  const migration = snapshot.plan.migrationPath.migrationPlanDigest;
  const migrationRow = migration
    ? store.sqlite
        .prepare<unknown[], { stage: string; degraded: number }>(
          'SELECT stage,degraded FROM upgrade_online_migrations WHERE plan_digest=?',
        )
        .get(migration)
    : null;
  const pending = migration
    ? store.sqlite
        .prepare(
          'SELECT 1 FROM upgrade_projection_changes WHERE plan_digest=? AND projected=0 LIMIT 1',
        )
        .get(migration)
    : null;
  requireUpgrade(
    allOwnersCompatible &&
      inspector.schema() === snapshot.plan.migrationPath.targetSchema &&
      (!migration || (migrationRow?.stage === 'complete' && !migrationRow.degraded && !pending)),
    'WEB_RECOVERY_DATA_OR_OWNER_UNCONFIRMED',
  );
  const baseline = store.sqlite
    .prepare<unknown[], { snapshot: string; digest: string }>(
      'SELECT snapshot,digest FROM upgrade_continuity_baselines WHERE attempt_id=?',
    )
    .get(id);
  requireUpgrade(baseline, 'CONTINUITY_BASELINE_CORRUPT');
  requireUpgrade(
    baseline.digest === upgradeDigest(JSON.parse(baseline.snapshot)),
    'CONTINUITY_BASELINE_CORRUPT',
  );
  const previous = store.sqlite
    .prepare<unknown[], { manifest: string; plan: string }>(
      "SELECT manifest,plan FROM upgrade_attempts WHERE instance_id=? AND target_release_id=? AND state='activation-confirmed' ORDER BY generation DESC LIMIT 1",
    )
    .get(store.instanceId, fallback.releaseId);
  const root = previous
    ? resolve(
        process.env.UPGRADE_INSTALLER_ROOT ?? '',
        'artifacts',
        UpgradePlanSchema.parse(JSON.parse(previous.plan)).package.digest.slice(7),
      )
    : process.env.UPGRADE_INITIAL_ARTIFACT_ROOT;
  requireUpgrade(root, 'RETAINED_WEB_ARTIFACT_UNKNOWN');
  const retainedRelease = previous
    ? SignedUpgradeManifestSchema.parse(JSON.parse(previous.manifest)).manifest
    : await initialSourceActivation(store);
  requireUpgrade(retainedRelease.releaseId === fallback.releaseId, 'RETAINED_WEB_ARTIFACT_CHANGED');
  await inspector.verifySourceArtifact(root, retainedRelease.components);
  requireUpgrade(
    upgradeDigest(retainedRelease.components.web) === upgradeDigest(sourceWeb) &&
      retainedRelease.components.api.artifactDigest === fallback.apiDigest,
    'RETAINED_WEB_ARTIFACT_CHANGED',
  );
  const fs = await statfs(env.dataRoot),
    memory = process.memoryUsage();
  const capacity =
    fs.bavail * fs.bsize >= snapshot.plan.policy.minFreeBytes &&
    freemem() > memory.rss &&
    getHeapStatistics().heap_size_limit > memory.heapUsed;
  const rehearsal = m.evidence.find((e) => e.kind === 'fault-recovery' && e.result === 'passed');
  const rehearsalDigest =
    rehearsal?.reportDigest ?? (m.purpose === 'qualification' ? baseline.digest : null);
  requireUpgrade(rehearsalDigest && capacity, 'WEB_RECOVERY_QUALIFICATION_MISSING');
  return {
    qualified: true,
    instanceId: store.instanceId,
    fence,
    releaseId: fallback.releaseId,
    apiDigest: m.components.api.artifactDigest,
    webDigest: sourceWeb.artifactDigest,
    observedAt: clock.now().toISOString(),
    migrationCommitKnown: true,
    sharedStateHealthy: true,
    artifactImmutable: true,
    healthy: true,
    capacitySufficient: true,
    latestDatabaseCompatible: true,
    newWritesCompatible: true,
    loadedWebCompatible: true,
    allOwnersCompatible: true,
    coordinatorCompatible: true,
    authContinuous: true,
    originalResourcesAddressable: true,
    dedupCancellationCursorPreserved: true,
    rehearsalDigest,
    qualificationOnly: m.purpose === 'qualification',
    currentDataEpoch: inspector.schema(),
    fallbackPolicyAnchor: {
      releaseId: fallback.releaseId,
      apiDigest: fallback.apiDigest,
      webDigest: fallback.webDigest,
    },
    api: null,
    coordinator: null,
    owner: null,
    web,
    componentScope: ['web'],
  };
}
