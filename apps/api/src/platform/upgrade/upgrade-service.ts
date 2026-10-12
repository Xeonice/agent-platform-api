import { Inject, Injectable, Optional } from '@nestjs/common';
import { lstat, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { CLOCK, type Clock } from '@platform/shared-kernel';
import {
  ConfirmedServiceReleaseSchema,
  UpgradeStatusSchema,
  type ConfirmedServiceRelease,
  type UpgradeRequest,
  type UpgradeStatus,
  type UpgradeSourceActual,
} from '@platform/contracts';
import type { Request, Response } from 'express';
import { UpgradeSecurity } from '../access-passcode/upgrade-security.service';
import { UpgradeStore, type UpgradeCommit } from './upgrade-store';
import { UpgradeCatalog } from './upgrade-catalog';
import { loopbackOrigin, persistedBinding, UpgradeInspector } from './upgrade-inspector';
import {
  canonicalUpgrade,
  requireUpgrade,
  upgradeDigest,
  freezeUpgradePlan,
} from './upgrade-trust';

import {
  assertRecoveryTargets,
  qualifyWebRecovery,
  persistedFaultScope,
} from './upgrade-web-recovery';
import { UpgradeContractService } from './upgrade-contract-service';

type Json = Record<string, unknown>;

@Injectable()
export class UpgradeService {
  private registering: Promise<void> | null = null;
  constructor(
    readonly store: UpgradeStore,
    private readonly catalog: UpgradeCatalog,
    readonly security: UpgradeSecurity,
    readonly inspector: UpgradeInspector,
    @Inject(CLOCK) private readonly clock: Clock,
    @Optional() readonly contracts?: UpgradeContractService,
  ) {}
  async registerInstalled(): Promise<void> {
    if (this.store.confirmed()) return;
    if (this.registering) return this.registering;
    this.registering = (async () => {
      const path = process.env.UPGRADE_INITIAL_RELEASE_PATH;
      requireUpgrade(path, 'INITIAL_ACTIVATION_UNKNOWN');
      const stat = await lstat(path);
      requireUpgrade(
        stat.isFile() &&
          !stat.isSymbolicLink() &&
          (stat.mode & 0o022) === 0 &&
          (!process.getuid || stat.uid === process.getuid() || stat.uid === 0),
        'INSECURE_INITIAL_ACTIVATION',
      );
      const raw: unknown = JSON.parse(await readFile(path, 'utf8'));
      const receipt =
        raw && typeof raw === 'object' && 'release' in raw ? (raw as Json) : { release: raw };
      const release = ConfirmedServiceReleaseSchema.parse(receipt.release);
      const artifactRoot =
        typeof receipt.artifactRoot === 'string'
          ? resolve(receipt.artifactRoot)
          : (process.env.UPGRADE_INITIAL_ARTIFACT_ROOT ?? dirname(process.cwd()));
      await this.inspector.bootstrapProof(release, artifactRoot);
      if (!this.store.confirmed()) this.store.bootstrap(release);
    })().finally(() => {
      this.registering = null;
    });
    return this.registering;
  }
  async status(
    req: Request,
    res: Response,
    granted?: ReturnType<UpgradeSecurity['principal']>,
  ): Promise<UpgradeStatus> {
    try {
      await this.registerInstalled();
    } catch {
      /* Unknown installed data stays unknown, never a guessed ENV version. */
    }
    const principal = granted ?? this.security.principal(req, res, this.store.instanceId);
    await this.catalog.refresh();
    const row = this.store.instance(),
      last = this.store.confirmed();
    let availableWeb: UpgradeStatus['availableWeb'] = null;
    let repairableCurrent: UpgradeStatus['repairableCurrent'] = null;
    let serviceState: UpgradeStatus['serviceState'] = row.service_state;
    if (row.service_state === 'confirmed' && last) {
      try {
        const binding = await this.inspector.entryBinding(),
          proof = await this.inspector.installedProof(last, binding),
          actual = await this.inspector.webBuild(binding);
        requireUpgrade(proof.qualified === true, 'CURRENT_SERVICE_UNCONFIRMED');
        const web = binding.web as Json;
        requireUpgrade(
          web.digest === last.components.web.artifactDigest &&
            actual.webRevision === last.components.web.webRevision,
          'WEB_BINDING_CHANGED',
        );
        if (row.ready === 1)
          availableWeb = {
            releaseId: last.releaseId,
            webReleaseId: actual.releaseId,
            webRevision: actual.webRevision,
            artifactDigest: last.components.web.artifactDigest,
            instanceId: this.store.instanceId,
            activationGeneration: last.activationGeneration,
            productionBinding: last.productionWebBinding,
            ready: true,
            compatible: true,
            observedAt: this.clock.now().toISOString(),
          };
      } catch {
        serviceState =
          'unknown'; /* The trusted historical receipt cannot stand in for a current physical observation. */
      }
    }
    if (serviceState !== 'confirmed') {
      try {
        const current = await this.inspector.sourceActual();
        if (current)
          repairableCurrent = {
            baseConfirmedReleaseId: current.baseConfirmedReleaseId,
            activationGeneration: current.activationGeneration,
            observedAt: current.observedAt,
          };
      } catch {
        /* Unknown observations grant no repair capability. */
      }
    }
    const contract = (await this.contracts?.status()) ?? null;
    return UpgradeStatusSchema.parse({
      contract,
      instanceId: this.store.instanceId,
      userScope: principal.userScope,
      activationGeneration: row.activation_generation,
      confirmedServiceRelease: serviceState === 'confirmed' ? last : null,
      lastConfirmedServiceRelease: last,
      serviceState,
      catalog: this.catalog.status(),
      capabilities: {
        canUpgradeInstance: principal.canUpgrade,
        canAuthenticate: this.security.canAuthenticate,
        canContract: principal.canUpgrade && contract?.availablePlan?.eligible === true,
      },
      csrfToken: principal.csrfToken,
      attempt: this.store.latest(),
      recovery: this.store.recovery(),
      availableWeb,
      repairableCurrent,
      observedAt: this.clock.now().toISOString(),
    });
  }
  async request(req: Request, res: Response, command: UpgradeRequest) {
    const principal = this.security.principal(req, res, this.store.instanceId);
    this.security.mutation(req, principal);
    const replay = this.store.replay(principal.actorId, command);
    if (replay) {
      await this.syncIntentBarrier(replay.attemptId);
      return replay;
    }
    await this.registerInstalled();
    await this.catalog.refresh();
    const target = this.catalog.target(command.targetReleaseId, command.targetDigest);
    requireUpgrade(
      !this.store.sqlite
        .prepare('SELECT 1 FROM upgrade_online_migrations WHERE read_epoch=2 LIMIT 1')
        .get() ||
        target.envelope.manifest.components.coordinator.dataFormats?.includes(
          'project-name-v2-authority',
        ),
      'TARGET_DATA_FORMAT_INCOMPATIBLE',
    );
    const sourceActual = await this.inspector.sourceActual();
    const installed = this.store.confirmed();
    requireUpgrade(installed, 'INSTALLED_RELEASE_UNKNOWN');
    if (!sourceActual)
      requireUpgrade(
        (await this.inspector.installedProof(installed)).qualified === true,
        'CURRENT_SERVICE_UNCONFIRMED',
      );
    const plan = freezeUpgradePlan(
      target.envelope,
      sourceActual
        ? { ...installed, schema: sourceActual.schema, components: sourceActual.components }
        : installed,
      this.store.appliedBridges(),
    );
    const baseline = await this.inspector.capture();
    const binding = await this.inspector.entryBinding();
    const attempt = this.store.accept(
      principal.actorId,
      command,
      target.envelope,
      plan,
      Number(binding.fence),
      baseline,
      sourceActual,
    );
    await this.syncIntentBarrier(attempt.attemptId);
    return attempt;
  }
  private async syncIntentBarrier(id: string): Promise<void> {
    const snapshot = this.store.snapshot(id);
    if (
      snapshot.controllerId !== null ||
      snapshot.attempt.state !== 'accepted' ||
      snapshot.fence < 1 ||
      snapshot.leaseExpiresAt <= this.clock.now().getTime()
    )
      return;
    const r = await fetch(loopbackOrigin(process.env.PLATFORM_ENTRY_CONTROL_ORIGIN) + '/fence', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-platform-internal-key': process.env.PLATFORM_ENTRY_CONTROL_KEY ?? '',
      },
      body: JSON.stringify({
        instanceId: this.store.instanceId,
        attemptId: id,
        fence: snapshot.fence,
      }),
      signal: AbortSignal.timeout(2000),
    });
    requireUpgrade(r.ok, 'INTENT_BARRIER_UNCONFIRMED');
  }
  lookup(req: Request, res: Response, id: string) {
    const principal = this.security.principal(req, res, this.store.instanceId);
    requireUpgrade(principal.canUpgrade, 'UPGRADE_PERMISSION_REQUIRED', 403);
    return this.store.lookup(principal.actorId, id);
  }
  async claim(id: string, controllerId: string, leaseMs: number) {
    const currentBinding = await this.inspector.entryBinding();
    const claimed = this.store.claim(id, controllerId, leaseMs, Number(currentBinding.fence));
    // Entry serializes the durable global fence and route commits. Failure here
    // leaves a recoverable claim but NEVER returns an authorization to act.
    const r = await fetch(loopbackOrigin(process.env.PLATFORM_ENTRY_CONTROL_ORIGIN) + '/fence', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-platform-internal-key': process.env.PLATFORM_ENTRY_CONTROL_KEY ?? '',
      },
      body: JSON.stringify({
        instanceId: this.store.instanceId,
        attemptId: id,
        fence: claimed.fence,
      }),
      signal: AbortSignal.timeout(2000),
    });
    requireUpgrade(r.ok, 'ENTRY_FENCE_UNCONFIRMED');
    this.store.assertFence(id, claimed.fence, claimed.generation);
    return claimed;
  }
  async commit(id: string, command: UpgradeCommit) {
    this.store.assertControllerFence(id, command.fence, command.generation);
    let confirmed: ConfirmedServiceRelease | undefined;
    let restoredPartial: UpgradeSourceActual | undefined;
    if (command.kind === 'activation-confirmed') {
      const snapshot = this.store.snapshot(id),
        actual = await this.inspector.entryBinding();
      requireUpgrade(
        canonicalUpgrade(persistedBinding(command.payload.actual as Json)) ===
          canonicalUpgrade(persistedBinding(actual)),
        'ENTRY_BINDING_CHANGED',
      );
      const proof = await this.inspector.validateSwitch(id, command.fence, {
        actual,
        manifestDigest: snapshot.signedManifest.manifestDigest,
      });
      requireUpgrade(proof.qualified === true, 'OVERALL_ACTIVATION_UNCONFIRMED');
      // The controller's claimed compatibility/continuity never substitutes for
      // this Coordinator-owned live verification.
      requireUpgrade(
        this.inspector.schema() === snapshot.plan.migrationPath.targetSchema,
        'SCHEMA_ACTIVATION_UNCONFIRMED',
      );
      confirmed = ConfirmedServiceReleaseSchema.parse({
        releaseId: snapshot.manifest.releaseId,
        activationGeneration: this.store.instance().activation_generation + 1,
        activatedAt: this.clock.now().toISOString(),
        schema: this.inspector.schema(),
        channel: snapshot.manifest.channel,
        components: snapshot.manifest.components,
        commits: snapshot.manifest.commits,
        productionWebBinding: String((actual.web as Json).origin ?? ''),
      });
      const installed = await this.inspector.installedProof(confirmed, actual);
      requireUpgrade(installed.qualified === true, 'ACTUAL_COMPONENTS_UNCONFIRMED');
    } else if (command.kind === 'recovery-started' || command.kind === 'recovery-confirmed') {
      const eligibility = await this.fallbackEligibility(id, command.fence, {
        actual: await this.inspector.entryBinding(),
      });
      requireUpgrade(eligibility.qualified === true, 'FALLBACK_UNQUALIFIED');
      const recoveryPlan =
        command.kind === 'recovery-started'
          ? (command.payload.recoveryPlan as Json)
          : this.store.snapshot(id).recoveryPlan;
      requireUpgrade(recoveryPlan, 'RECOVERY_FIXED_PLAN_MISSING');
      assertRecoveryTargets(recoveryPlan, eligibility);
      if (
        command.kind === 'recovery-confirmed' &&
        Array.isArray(recoveryPlan.componentScope) &&
        recoveryPlan.componentScope.length === 1 &&
        recoveryPlan.componentScope[0] === 'web'
      ) {
        const current = await this.inspector.sourceActual(true);
        if (current) restoredPartial = current;
        else {
          const source = this.store.snapshot(id).sourceActivation;
          const web = (await this.inspector.entryBinding()).web as Json;
          const full = ConfirmedServiceReleaseSchema.parse({
            ...source,
            activationGeneration: this.store.instance().activation_generation + 1,
            activatedAt: this.clock.now().toISOString(),
            productionWebBinding: String(web.origin),
            schema: this.inspector.schema(),
          });
          requireUpgrade(
            (await this.inspector.installedProof(full)).qualified === true,
            'WEB_RECOVERY_ACTUAL_COMBINATION_UNCONFIRMED',
          );
          confirmed = full;
        }
      } else if (command.kind === 'recovery-confirmed') {
        const snapshot = this.store.snapshot(id),
          source = snapshot.sourceActivation;
        const installer = await this.inspector.installerIdentity();
        const retainedInstaller = [
          snapshot.sourceActual?.components.installer,
          source.components.installer,
          snapshot.manifest.components.installer,
        ].find(
          (c) =>
            c?.artifactDigest === installer.artifactDigest &&
            c?.inputFingerprint === installer.inputFingerprint,
        );
        requireUpgrade(retainedInstaller, 'RECOVERY_INSTALLER_UNKNOWN');
        const restored = ConfirmedServiceReleaseSchema.parse({
          ...source,
          components: {
            ...(snapshot.sourceActual?.components ?? source.components),
            installer: retainedInstaller,
          },
          activationGeneration: this.store.instance().activation_generation + 1,
          activatedAt: this.clock.now().toISOString(),
          schema: this.inspector.schema(),
        });
        requireUpgrade(
          (await this.inspector.installedProof(restored)).qualified === true,
          'RECOVERY_COMPONENTS_UNCONFIRMED',
        );
        if (
          canonicalUpgrade(restored.components) === canonicalUpgrade(source.components) &&
          restored.schema === source.schema
        )
          confirmed = restored;
        else {
          const current = await this.inspector.sourceActual(true);
          requireUpgrade(current, 'RECOVERY_PARTIAL_SOURCE_UNCONFIRMED');
          restoredPartial = current;
        }
      }
    }
    const result = this.store.commit(id, command, confirmed, restoredPartial);
    if (command.kind === 'recovery-started') {
      const response = await fetch(
        loopbackOrigin(process.env.PLATFORM_ENTRY_CONTROL_ORIGIN) + '/fence',
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-platform-internal-key': process.env.PLATFORM_ENTRY_CONTROL_KEY ?? '',
          },
          body: JSON.stringify({
            instanceId: this.store.instanceId,
            attemptId: id,
            fence: result.fence,
          }),
          signal: AbortSignal.timeout(2000),
        },
      );
      requireUpgrade(response.ok, 'ENTRY_FENCE_UNCONFIRMED');
      this.store.assertFence(id, result.fence);
    }
    return result;
  }
  async fallbackEligibility(id: string, fence: number, _input: Json): Promise<Json> {
    this.store.assertFence(id, fence);
    if (persistedFaultScope(this.store, id).join(',') === 'web')
      return qualifyWebRecovery(this.store, this.inspector, this.clock, id, fence);
    const snapshot = this.store.snapshot(id),
      source = snapshot.sourceActivation;
    const binding = await this.inspector.entryBinding();
    const qualification = snapshot.manifest.purpose === 'qualification';
    const fallback = snapshot.plan.policy.fallbacks.find(
      (f) =>
        f.releaseId === source.releaseId &&
        f.apiDigest === source.components.api.artifactDigest &&
        f.webDigest === source.components.web.artifactDigest &&
        (f.rehearsed || qualification),
    );
    const continuity = await this.inspector.continuity(id, fence);
    // A completed signed rehearsal binds artifacts, current schema, Web/owner
    // matrix and data epoch. Absence is not inferred safe from an old health 200.
    const rehearsal = snapshot.manifest.evidence.find(
      (e) => e.kind === 'fault-recovery' && e.result === 'passed',
    );
    const baselineRow = this.store.sqlite
      .prepare('SELECT snapshot,digest FROM upgrade_continuity_baselines WHERE attempt_id=?')
      .get(id) as { snapshot: string; digest: string } | undefined;
    requireUpgrade(baselineRow, 'CONTINUITY_BASELINE_MISSING');
    const baseline = JSON.parse(baselineRow.snapshot) as Json;
    requireUpgrade(upgradeDigest(baseline) === baselineRow.digest, 'CONTINUITY_BASELINE_CORRUPT');
    const coordinator = baseline.coordinator as Json,
      owner = baseline.ownerBinding as Json;
    let live: Json = {},
      immutable = false;
    try {
      const response = await fetch(
        loopbackOrigin(coordinator.origin) +
          '/internal/upgrades/' +
          id +
          '/coordinator-compatibility',
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-platform-internal-key': process.env.PLATFORM_CONTROLLER_RPC_KEY ?? '',
            'x-platform-instance-id': this.store.instanceId,
          },
          body: canonicalUpgrade({ fence }),
          signal: AbortSignal.timeout(2000),
        },
      );
      requireUpgrade(response.ok, 'RETAINED_COORDINATOR_UNCONFIRMED');
      live = (await response.json()) as Json;
      const prior = this.store.sqlite
        .prepare(
          "SELECT plan FROM upgrade_attempts WHERE target_release_id=? AND state='activation-confirmed' ORDER BY generation DESC LIMIT 1",
        )
        .get(source.releaseId) as { plan: string } | undefined;
      const root = prior
        ? resolve(
            process.env.UPGRADE_INSTALLER_ROOT ?? '',
            'artifacts',
            String(
              (JSON.parse(prior.plan) as { package: { digest: string } }).package.digest,
            ).slice(7),
          )
        : process.env.UPGRADE_INITIAL_ARTIFACT_ROOT;
      requireUpgrade(root, 'SOURCE_ARTIFACT_UNKNOWN');
      const bundle = JSON.parse(await readFile(resolve(root, 'upgrade-artifact.json'), 'utf8')) as {
        components: ConfirmedServiceRelease['components'];
      };
      for (const name of ['api', 'web', 'coordinator', 'owner'] as const)
        if (source.components[name])
          requireUpgrade(
            canonicalUpgrade(source.components[name]) === canonicalUpgrade(bundle.components[name]),
            'SOURCE_COMPONENT_CHANGED',
          );
      await this.inspector.verifyArtifact(root, bundle.components);
      immutable = true;
    } catch {
      /* Old process/schema/artifact absent is not a safe rollback. */
    }
    let healthy = false;
    const api = binding.oldApi as Json;
    try {
      const identity = await this.inspector.controlIdentity(api.origin);
      healthy =
        api.digest === source.components.api.artifactDigest &&
        identity.artifactDigest === source.components.api.artifactDigest &&
        (await this.inspector.authenticationContinuity(id, fence, api.origin)) &&
        identity.controlOnly === true &&
        identity.noRuntimeSideEffects === true;
    } catch {
      /* Unknown fallback remains disqualified. */
    }
    const webCandidates = [
      binding.web,
      ...(Array.isArray(binding.retainedWeb) ? binding.retainedWeb : []),
    ] as Json[];
    const web =
      webCandidates.find((w) => w.digest === source.components.web.artifactDigest) ?? null;
    let webHealthy = false;
    if (web) {
      try {
        const actual = await this.inspector.webBuild({ web });
        webHealthy = actual.webRevision === source.components.web.webRevision;
      } catch {
        /* Retained artifacts also require a living server. */
      }
    }
    const sourceApiProtocol = source.components.api.protocol;
    const loadedWebCompatible = [source.components.web, snapshot.manifest.components.web].every(
      (w) => sourceApiProtocol.min <= w.protocol.max && sourceApiProtocol.max >= w.protocol.min,
    );
    const ownersEvidence = continuity.owner as Json | null,
      allOwners = Array.isArray(ownersEvidence?.owners) ? (ownersEvidence.owners as Json[]) : [];
    const allOwnersCompatible =
      allOwners.length > 0 &&
      allOwners.every((o) => {
        const range = o.protocol as Json | undefined,
          coor = (source.components.coordinator ?? source.components.api).protocol;
        return range && Number(range.min) <= coor.max && Number(range.max) >= coor.min;
      }) &&
      continuity.qualified === true;
    const sharedHealthy = this.store.sqlite.pragma('quick_check', { simple: true }) === 'ok';
    // Qualification is a separately signed, isolated installation purpose: its
    // first real rehearsal is not represented as a production passed receipt.
    const rehearsalDigest = rehearsal?.reportDigest ?? (qualification ? baselineRow.digest : null);
    const qualified = Boolean(
      fallback &&
      rehearsalDigest &&
      immutable &&
      healthy &&
      webHealthy &&
      live.qualified === true &&
      loadedWebCompatible &&
      allOwnersCompatible &&
      sharedHealthy,
    );
    return {
      qualified,
      instanceId: this.store.instanceId,
      fence,
      releaseId: source.releaseId,
      apiDigest: source.components.api.artifactDigest,
      webDigest: source.components.web.artifactDigest,
      observedAt: this.clock.now().toISOString(),
      migrationCommitKnown: live.migrationCommitKnown === true,
      sharedStateHealthy: sharedHealthy,
      artifactImmutable: immutable,
      healthy: healthy && webHealthy,
      capacitySufficient: live.capacitySufficient === true,
      latestDatabaseCompatible: live.latestDatabaseCompatible === true,
      newWritesCompatible: live.newWritesCompatible === true,
      loadedWebCompatible,
      allOwnersCompatible,
      coordinatorCompatible: live.qualified === true,
      authContinuous: healthy,
      originalResourcesAddressable: continuity.qualified,
      dedupCancellationCursorPreserved: continuity.qualified,
      rehearsalDigest,
      qualificationOnly: qualification,
      currentDataEpoch: this.inspector.schema(),
      api,
      web,
      coordinator: snapshot.plan.coordinatorReused ? null : coordinator,
      owner: snapshot.plan.ownerReused ? null : owner,
      componentScope: [
        ...(!snapshot.plan.apiReused ? ['api'] : []),
        ...(!snapshot.plan.webReused ? ['web'] : []),
        ...(!snapshot.plan.coordinatorReused ? ['coordinator'] : []),
        ...(!snapshot.plan.ownerReused ? ['owner'] : []),
      ],
    };
  }
  probe(input: { attemptId: string; fence: number; requestId: string; value: string }) {
    this.store.assertFence(input.attemptId, input.fence);
    return this.store.sqlite
      .transaction(() => {
        const prior = this.store.sqlite
          .prepare('SELECT request_id,value,revision FROM upgrade_probe_records WHERE request_id=?')
          .get(input.requestId) as Json | undefined;
        if (prior) {
          requireUpgrade(prior.value === input.value, 'PROBE_ID_CONFLICT');
          return prior;
        }
        const revision =
          (
            this.store.sqlite
              .prepare('SELECT count(*) AS n FROM upgrade_probe_records WHERE attempt_id=?')
              .get(input.attemptId) as { n: number }
          ).n + 1;
        this.store.sqlite
          .prepare('INSERT INTO upgrade_probe_records VALUES(?,?,?,?,?)')
          .run(input.requestId, input.attemptId, input.value, revision, this.clock.now().getTime());
        return this.store.sqlite
          .prepare('SELECT request_id,value,revision FROM upgrade_probe_records WHERE request_id=?')
          .get(input.requestId);
      })
      .immediate();
  }
  readProbe(requestId: string) {
    const value = this.store.sqlite
      .prepare('SELECT request_id,value,revision FROM upgrade_probe_records WHERE request_id=?')
      .get(requestId);
    requireUpgrade(value, 'PROBE_RECORD_NOT_FOUND', 404);
    return value;
  }
}
