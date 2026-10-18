import { UpgradePlanSchema } from '@platform/contracts';
import {
  nullableUpgradeRecord,
  optionalUpgradeRecord,
  requiredUpgradeValue,
  upgradeRecord,
  upgradeRecords,
} from './upgrade-values';
import {
  Inject,
  Injectable,
  Optional,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
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
  readUpgradeTrustRoot,
  verifyUpgradeEnvelope,
  UpgradeError,
} from './upgrade-trust';

import {
  assertRecoveryTargets,
  qualifyWebRecovery,
  persistedFaultScope,
} from './upgrade-web-recovery';
import { UpgradeContractService } from './upgrade-contract-service';
import { withUpgradeObservation } from './upgrade-observation';
import {
  UpgradeOperationStore,
  type UpgradeOperationRecord,
  type DefaultImageSnapshot,
} from './upgrade-operation-store';
import { UpgradeProjection } from './upgrade-projection';
import { withCoordinatorBusinessEpoch } from '../persistence/coordinator-lease';

type Json = Record<string, unknown>;
export const UPGRADE_OPERATION_DATA_FORMATS = ['upgrade-plan-v1'] as const;

@Injectable()
export class UpgradeService implements OnApplicationBootstrap, OnModuleDestroy {
  private registering: Promise<void> | null = null;
  private operationTimer?: ReturnType<typeof setInterval>;
  private advancing = false;
  private stopped = false;
  constructor(
    readonly store: UpgradeStore,
    private readonly catalog: UpgradeCatalog,
    readonly security: UpgradeSecurity,
    readonly inspector: UpgradeInspector,
    @Inject(CLOCK) private readonly clock: Clock,
    @Optional() readonly contracts?: UpgradeContractService,
    @Optional() readonly operations?: UpgradeOperationStore,
    @Optional() private readonly projection?: UpgradeProjection,
  ) {}
  onApplicationBootstrap(): void {
    if (process.env.PLATFORM_PROCESS_ROLE && process.env.PLATFORM_PROCESS_ROLE !== 'coordinator')
      return;
    setImmediate(() => {
      if (!this.stopped) {
        try {
          void withCoordinatorBusinessEpoch(this.store.sqlite, () =>
            this.registerInstalled(),
          ).catch(() => undefined);
        } catch {
          /* No writer authority. */
        }
      }
    });
    this.operationTimer = setInterval(() => {
      this.scheduleOperation();
    }, 250);
    this.operationTimer.unref();
  }
  onModuleDestroy(): void {
    this.stopped = true;
    if (this.operationTimer) clearInterval(this.operationTimer);
  }
  private scheduleOperation(): void {
    if (
      this.stopped ||
      !this.operations ||
      (process.env.PLATFORM_PROCESS_ROLE === 'coordinator' &&
        process.env.COORDINATOR_WRITER_FENCE_VALID !== 'true')
    )
      return;
    setImmediate(() => {
      if (this.stopped) return;
      try {
        void withCoordinatorBusinessEpoch(this.store.sqlite, () => this.advanceOperation()).catch(
          () => undefined,
        );
      } catch {
        /* Retired writer cannot queue work. */
      }
    });
  }
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
        raw && typeof raw === 'object' && 'release' in raw ? upgradeRecord(raw) : { release: raw };
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
    if (this.projection) {
      const principal = granted ?? this.security.principal(req, res, this.store.instanceId);
      res.setHeader('X-Upgrade-User-Scope', principal.userScope);
      res.setHeader('Cache-Control', 'no-store');
      const row = this.store.instance(),
        last = this.store.confirmed(),
        physical = this.projection.view(),
        attempt = this.store.latest();
      this.projection.schedule();
      return UpgradeStatusSchema.parse({
        ...physical,
        instanceId: this.store.instanceId,
        userScope: principal.userScope,
        activationGeneration: row.activation_generation,
        confirmedServiceRelease: physical.serviceState === 'confirmed' ? last : null,
        lastConfirmedServiceRelease: last,
        catalog: this.catalog.status(),
        capabilities: {
          canUpgradeInstance: principal.canUpgrade,
          canAuthenticate: this.security.canAuthenticate,
          canContract: principal.canUpgrade && physical.contract?.availablePlan?.eligible === true,
        },
        csrfToken: principal.csrfToken,
        attempt,
        recovery: this.store.recovery(),
        operation: this.operations?.latest()?.operation ?? null,
        currentStageProgress: attempt ? this.store.stageProgress(attempt.attemptId) : null,
        observedAt: this.clock.now().toISOString(),
      });
    }
    return withUpgradeObservation(() => this.observeStatus(req, res, granted));
  }
  private async observeStatus(
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
    res.setHeader('X-Upgrade-User-Scope', principal.userScope);
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
        const web = upgradeRecord(binding.web);
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
    res.setHeader('Vary', 'Prefer');
    res.setHeader('Cache-Control', 'no-store');
    const asyncRequested = this.preferAsync(req);
    const operation = this.operations?.replay(principal.actorId, command);
    if (operation) {
      if (asyncRequested) return operation.operation;
      return this.legacyOperationAttempt(operation);
    }
    const replay = this.store.replay(principal.actorId, command);
    if (replay) {
      await this.syncIntentBarrier(replay.attemptId);
      return replay;
    }
    if (asyncRequested) {
      requireUpgrade(this.operations, 'UPGRADE_ASYNC_UNAVAILABLE');
      const target = this.catalog.target(command.targetReleaseId, command.targetDigest);
      requireUpgrade(
        target.chain.every((stage) =>
          stage.envelope.manifest.components.coordinator.upgradeOperationFormats?.includes(
            'upgrade-plan-v1',
          ),
        ),
        'UPGRADE_PLAN_RESUME_UNSUPPORTED',
      );
      const accepted = this.operations.accept(
        principal.actorId,
        command,
        target.chain,
        this.defaultImagesSnapshot(),
      );
      res.setHeader('Preference-Applied', 'respond-async');
      this.scheduleOperation();
      return accepted.operation;
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
    const operation = this.operations?.find(principal.actorId, id);
    const attempt = operation
      ? this.preferAsync(req)
        ? operation.operation
        : this.legacyOperationAttempt(operation)
      : this.store.lookup(principal.actorId, id);
    res.setHeader('X-Upgrade-User-Scope', principal.userScope);
    res.setHeader('Vary', 'Prefer');
    res.setHeader('Cache-Control', 'no-store');
    return attempt;
  }
  private preferAsync(req: Request): boolean {
    return String(req.headers.prefer ?? '')
      .split(',')
      .some((preference) => preference.trim().toLowerCase() === 'respond-async');
  }
  private defaultImagesSnapshot(): DefaultImageSnapshot[] {
    try {
      return this.inspector.defaultImagesSnapshot();
    } catch {
      return [];
    }
  }
  private legacyOperationAttempt(record: UpgradeOperationRecord) {
    const final = record.operation.stages[record.operation.stages.length - 1];
    requireUpgrade(final.attemptId, 'UPGRADE_OPERATION_REQUIRES_ASYNC');
    return this.store.attempt(final.attemptId);
  }
  async advanceOperation(): Promise<void> {
    if (!this.operations || this.advancing || this.stopped) return;
    const record = this.operations.active();
    if (!record) return;
    this.advancing = true;
    try {
      const id = record.operation.operationId,
        index = record.operation.currentStageIndex,
        stage = record.operation.stages[index];
      if (stage.attemptId) {
        const attempt = this.store.attempt(stage.attemptId);
        if (['failed', 'deferred', 'candidate-rejected', 'reverted'].includes(attempt.state)) {
          this.operations.update(id, (next) => {
            next.operation.state = attempt.state === 'deferred' ? 'deferred' : 'failed';
            next.operation.reason = attempt.reason;
            next.operation.stages[index].state =
              attempt.state === 'deferred' ? 'deferred' : 'failed';
          });
          return;
        }
        if (attempt.state !== 'activation-confirmed') {
          await this.syncIntentBarrier(attempt.attemptId);
          return;
        }
        const current = this.store.confirmed(),
          instance = this.store.instance();
        requireUpgrade(
          current?.releaseId === stage.releaseId &&
            instance.service_state === 'confirmed' &&
            instance.ready === 1,
          'UPGRADE_STAGE_ACTIVATION_UNCONFIRMED',
        );
        requireUpgrade(
          (await this.inspector.installedProof(current)).qualified === true,
          'UPGRADE_STAGE_ACTIVATION_UNCONFIRMED',
        );
        this.operations.update(id, (next) => {
          const live = this.store.instance(),
            confirmed = this.store.confirmed(),
            technical = this.store.attempt(attempt.attemptId);
          requireUpgrade(
            live.ready === 1 &&
              live.service_state === 'confirmed' &&
              confirmed &&
              canonicalUpgrade(confirmed) === canonicalUpgrade(current) &&
              technical.state === 'activation-confirmed' &&
              next.operation.currentStageIndex === index &&
              next.operation.stages[index].attemptId === attempt.attemptId,
            'UPGRADE_STAGE_ACTIVATION_UNCONFIRMED',
          );
          next.operation.stages[index].state = 'confirmed';
          if (index === next.operation.stages.length - 1) {
            next.operation.state = 'completed';
            next.operation.percent = 100;
            const after = this.defaultImagesSnapshot();
            const images = after.flatMap((image) => {
              const before = next.defaultImagesBefore.find(
                (old) => old.provider === image.provider,
              );
              return before?.managed &&
                image.managed &&
                (before.ref !== image.ref || before.digest !== image.digest)
                ? [
                    {
                      provider: image.provider,
                      previousRef: before.ref,
                      previousDigest: before.digest,
                      ref: image.ref,
                      digest: image.digest,
                      runtimeVersions: image.runtimeVersions,
                    },
                  ]
                : [];
            });
            next.operation.defaultImageUpdate = images.length
              ? { scope: 'managed-default', images, observedAt: this.clock.now().toISOString() }
              : null;
          } else {
            next.operation.currentStageIndex = index + 1;
            next.operation.state = 'preparing';
          }
        });
        return;
      }
      this.operations.update(id, (next) => {
        next.operation.state = 'preparing';
      });
      const fixed = record.chain[index];
      const roots = await readUpgradeTrustRoot(process.env.UPGRADE_TRUST_ROOT_PATH ?? '');
      const envelope = verifyUpgradeEnvelope(fixed.envelope, roots, this.clock.now().getTime());
      const current = this.store.confirmed();
      requireUpgrade(current, 'INSTALLED_RELEASE_UNKNOWN');
      const sourceActual = await this.inspector.sourceActual();
      if (!sourceActual)
        requireUpgrade(
          (await this.inspector.installedProof(current)).qualified === true,
          'CURRENT_SERVICE_UNCONFIRMED',
        );
      const source = sourceActual
        ? { ...current, schema: sourceActual.schema, components: sourceActual.components }
        : current;
      const plan = freezeUpgradePlan(envelope, source, this.store.appliedBridges());
      requireUpgrade(
        canonicalUpgrade(plan) === canonicalUpgrade(fixed.plan),
        'FROZEN_SOURCE_PLAN_CONFLICT',
      );
      const baseline = await this.inspector.capture(),
        binding = await this.inspector.entryBinding();
      const accepted = this.operations.update(id, (next) => {
        requireUpgrade(
          next.operation.currentStageIndex === index &&
            next.operation.stages[index].attemptId === null,
          'UPGRADE_OPERATION_CHANGED',
        );
        const attempt = this.store.accept(
          next.actorId,
          {
            requestId: fixed.requestId,
            targetReleaseId: envelope.manifest.releaseId,
            targetDigest: envelope.manifestDigest,
            expectedActivationGeneration: current.activationGeneration,
          },
          envelope,
          plan,
          Number(binding.fence),
          baseline,
          sourceActual,
          id,
        );
        next.operation.stages[index].attemptId = attempt.attemptId;
        next.operation.stages[index].state = 'running';
        next.operation.state = 'running';
      });
      await this.syncIntentBarrier(
        requiredUpgradeValue(accepted.operation.stages[index].attemptId),
      );
    } catch (error) {
      // An epoch loss cannot commit even this failure. A new actual writer resumes
      // the same immutable record; it never replays an already-created attempt.
      const current = this.operations.active();
      if (current && !current.operation.stages[current.operation.currentStageIndex].attemptId) {
        this.operations.update(current.operation.operationId, (next) => {
          next.operation.state = 'deferred';
          next.operation.reason =
            error instanceof UpgradeError ? error.code : 'UPGRADE_PREPARATION_UNCONFIRMED';
          next.operation.stages[next.operation.currentStageIndex].state = 'deferred';
        });
      } else if (current) {
        const actual = this.store.attempt(
          requiredUpgradeValue(
            current.operation.stages[current.operation.currentStageIndex].attemptId,
          ),
        );
        if (actual.state === 'activation-confirmed')
          this.operations.update(current.operation.operationId, (next) => {
            next.operation.state = 'deferred';
            next.operation.reason =
              error instanceof UpgradeError ? error.code : 'UPGRADE_STAGE_ACTIVATION_UNCONFIRMED';
            next.operation.stages[next.operation.currentStageIndex].state = 'deferred';
          });
      }
    } finally {
      this.advancing = false;
    }
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
        canonicalUpgrade(persistedBinding(upgradeRecord(command.payload.actual))) ===
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
        productionWebBinding: loopbackOrigin(upgradeRecord(actual.web).origin),
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
          ? upgradeRecord(command.payload.recoveryPlan)
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
          const web = upgradeRecord((await this.inspector.entryBinding()).web);
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
      .prepare<unknown[], { snapshot: string; digest: string }>(
        'SELECT snapshot,digest FROM upgrade_continuity_baselines WHERE attempt_id=?',
      )
      .get(id);
    requireUpgrade(baselineRow, 'CONTINUITY_BASELINE_MISSING');
    const baseline = upgradeRecord(JSON.parse(baselineRow.snapshot));
    requireUpgrade(upgradeDigest(baseline) === baselineRow.digest, 'CONTINUITY_BASELINE_CORRUPT');
    const coordinator = upgradeRecord(baseline.coordinator),
      owner = upgradeRecord(baseline.ownerBinding);
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
      live = upgradeRecord(await response.json());
      const prior = this.store.sqlite
        .prepare<unknown[], { plan: string }>(
          "SELECT plan FROM upgrade_attempts WHERE instance_id=? AND target_release_id=? AND state='activation-confirmed' ORDER BY generation DESC LIMIT 1",
        )
        .get(this.store.instanceId, source.releaseId);
      const root = prior
        ? resolve(
            process.env.UPGRADE_INSTALLER_ROOT ?? '',
            'artifacts',
            UpgradePlanSchema.parse(JSON.parse(prior.plan)).package.digest.slice(7),
          )
        : process.env.UPGRADE_INITIAL_ARTIFACT_ROOT;
      requireUpgrade(root, 'SOURCE_ARTIFACT_UNKNOWN');
      await this.inspector.verifySourceArtifact(root, source.components);
      immutable = true;
    } catch {
      /* Old process/schema/artifact absent is not a safe rollback. */
    }
    let healthy = false;
    const api = upgradeRecord(binding.oldApi);
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
    const webCandidates = upgradeRecords([
      binding.web,
      ...(Array.isArray(binding.retainedWeb) ? upgradeRecords(binding.retainedWeb) : []),
    ]);
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
    const ownersEvidence = nullableUpgradeRecord(continuity.owner),
      allOwners = Array.isArray(ownersEvidence?.owners)
        ? upgradeRecords(ownersEvidence.owners)
        : [];
    const allOwnersCompatible =
      allOwners.length > 0 &&
      allOwners.every((o) => {
        const range = optionalUpgradeRecord(o.protocol),
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
          .prepare<unknown[], Json>(
            'SELECT request_id,value,revision FROM upgrade_probe_records WHERE request_id=?',
          )
          .get(input.requestId);
        if (prior) {
          requireUpgrade(prior.value === input.value, 'PROBE_ID_CONFLICT');
          return prior;
        }
        const revision =
          requiredUpgradeValue(
            this.store.sqlite
              .prepare<unknown[], { n: number }>(
                'SELECT count(*) AS n FROM upgrade_probe_records WHERE attempt_id=?',
              )
              .get(input.attemptId),
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
