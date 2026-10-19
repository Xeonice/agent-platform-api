import { coordinatorWorker } from '@platform/shared-kernel';
import { z } from 'zod';
import { requiredUpgradeValue } from './upgrade-values';
import { optionalUpgradeRecord, upgradeRecord, upgradeRecords } from './upgrade-values';
import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { performance } from 'node:perf_hooks';
import { CLOCK, fromEpochMs, type Clock } from '@platform/shared-kernel';
import {
  type UpgradeContractPlan,
  type UpgradeContractRequest,
  type UpgradeContractStatus,
} from '@platform/contracts';
import { UpgradeContractStore, type ContractRecord } from './upgrade-contract-store';
import {
  UPGRADE_CONTRACT_BUSINESS,
  type UpgradeContractBusinessPort,
} from './upgrade-contract-business.port';
import { UPGRADE_INSPECTOR, type UpgradeInspectionPort } from './upgrade-inspection.port';
import { loopbackOrigin } from './upgrade-inspection-boundary';
import { UpgradeSecurity } from '../access-passcode/upgrade-security.service';
import {
  readUpgradeTrustRoot,
  canonicalUpgrade,
  verifyUpgradeEnvelope,
  requireUpgrade,
  upgradeDigest,
  upgradeRunInputFingerprint,
  UpgradeError,
} from './upgrade-trust';
import { withCoordinatorBusinessEpoch } from '../persistence/coordinator-lease';
import type { Request, Response } from 'express';

type Json = Record<string, unknown>;
/** Independent irreversible user intent. Normal upgrade/CD has no call to this executor. */
@Injectable()
export class UpgradeContractService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly worker = coordinatorWorker('upgrade.contract');

  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private readonly syncing = new Map<string, Promise<ContractRecord>>();
  private readonly windows = new Map<string, number>();
  constructor(
    readonly store: UpgradeContractStore,
    @Inject(UPGRADE_CONTRACT_BUSINESS) private readonly business: UpgradeContractBusinessPort,
    @Inject(UPGRADE_INSPECTOR) private readonly inspector: UpgradeInspectionPort,
    private readonly security: UpgradeSecurity,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}
  onApplicationBootstrap() {
    if (this.store.upgrades.ledgerReadonly) return;
    if (process.env.PLATFORM_PROCESS_ROLE !== 'coordinator') return;
    this.timer = this.worker.ownInterval(
      setInterval(() => {
        if (process.env.COORDINATOR_WRITER_FENCE_VALID !== 'true') return;
        try {
          void withCoordinatorBusinessEpoch(this.store.sqlite, () => this.tick()).catch(
            () => undefined,
          );
        } catch {
          /* The old writer has no execution authority. */
        }
      }, 100),
    );
    this.timer.unref();
  }
  onModuleDestroy() {
    if (this.timer) this.worker.cancel(this.timer);
  }
  private async supervisor(path: string, body?: Json): Promise<Json> {
    return this.worker.run(async () => {
      const stableRetirement = Boolean(
        process.env.UPGRADE_CONTROL_DATABASE_PATH &&
        process.env.UPGRADE_CONTROL_ORIGIN &&
        path === '/retire-reader',
      );
      const r = await fetch(
        stableRetirement
          ? loopbackOrigin(process.env.UPGRADE_CONTROL_ORIGIN) +
              '/internal/control/contracts/retire-reader'
          : loopbackOrigin(process.env.PLATFORM_INSTALLER_SUPERVISOR_ORIGIN) + path,
        {
          method: body ? 'POST' : 'GET',
          headers: {
            'content-type': 'application/json',
            'x-platform-internal-key': stableRetirement
              ? (process.env.PLATFORM_CONTROLLER_RPC_KEY ?? '')
              : (process.env.PLATFORM_INSTALLER_SUPERVISOR_KEY ?? ''),
            ...(stableRetirement
              ? { 'x-platform-instance-id': this.store.upgrades.instanceId }
              : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
          signal: AbortSignal.timeout(2000),
        },
      );
      requireUpgrade(r.ok, 'CONTRACT_SUPERVISOR_UNCONFIRMED');
      return upgradeRecord(await r.json());
    });
  }
  private async installedPlan(digest?: string) {
    return this.worker.run(async () => {
      const latest = this.store.upgrades.latest(),
        current = this.store.upgrades.confirmed();
      requireUpgrade(
        latest &&
          current &&
          latest.state === 'activation-confirmed' &&
          this.store.upgrades.instance().service_state === 'confirmed',
        'CONTRACT_INSTALLED_RELEASE_UNCONFIRMED',
      );
      const snapshot = this.store.upgrades.snapshot(latest.attemptId);
      requireUpgrade(
        snapshot.manifest.releaseId === current.releaseId,
        'CONTRACT_INSTALLED_RELEASE_UNCONFIRMED',
      );
      const roots = await readUpgradeTrustRoot(process.env.UPGRADE_TRUST_ROOT_PATH ?? '');
      const signedManifest = verifyUpgradeEnvelope(
        snapshot.signedManifest,
        roots,
        this.clock.now().getTime(),
      );
      const plan = signedManifest.manifest.contractPlans?.find(
        (p) => !digest || p.planDigest === digest,
      );
      requireUpgrade(plan, 'CONTRACT_PLAN_UNAVAILABLE');
      const { planDigest, ...facts } = plan;
      requireUpgrade(
        upgradeDigest(facts) === planDigest &&
          plan.artifactInputFingerprint === upgradeRunInputFingerprint(signedManifest.manifest),
        'CONTRACT_PLAN_IDENTITY_INVALID',
      );
      const evidence = signedManifest.manifest.evidence.find(
        (e) =>
          e.kind === 'semantic-contract' &&
          e.contractPlanDigest === plan.planDigest &&
          e.inputFingerprint === plan.artifactInputFingerprint,
      );
      requireUpgrade(
        evidence &&
          (evidence.result === 'passed' ||
            (signedManifest.manifest.purpose === 'qualification' && evidence.result === 'not-run')),
        'CONTRACT_QUALIFICATION_MISSING',
      );
      requireUpgrade(
        snapshot.plan.migrationPath.migrationPlanDigest === plan.expandPlanDigest,
        'CONTRACT_EXPAND_PLAN_CHANGED',
      );
      return { plan, signedManifest, expandAttemptId: latest.attemptId, current };
    });
  }
  private async readers(): Promise<Json[]> {
    return this.worker.run(async () => {
      const response = await this.supervisor('/retained-readers');
      requireUpgrade(
        response.instanceId === this.store.upgrades.instanceId && Array.isArray(response.readers),
        'CONTRACT_READERS_UNKNOWN',
      );
      const records = upgradeRecords(response.readers);
      const ids = new Set<string>();
      for (const r of records) {
        requireUpgrade(
          r.kind === 'coordinator' &&
            r.instanceId === this.store.upgrades.instanceId &&
            typeof r.readerId === 'string' &&
            !ids.has(r.readerId) &&
            typeof r.startIdentity === 'string' &&
            typeof r.artifactDigest === 'string' &&
            Number.isSafeInteger(r.pid) &&
            Number(r.pid) > 0 &&
            ['/internal/application/identity', '/internal/coordinator/identity'].includes(
              String(r.metadataPath),
            ),
          'CONTRACT_READERS_UNKNOWN',
        );
        loopbackOrigin(r.managementOrigin ?? r.origin);
        ids.add(r.readerId);
      }
      // Current writer is not a retireable reader. It is separately physically verified.
      const currentStartIdentity = await this.business.currentStartIdentity();
      return records.filter((r) => r.startIdentity !== currentStartIdentity);
    });
  }
  private async qualify(
    plan: UpgradeContractPlan,
    readers: Json[],
    generation: number,
    skipWindow = false,
    retired: Record<string, unknown> = {},
  ): Promise<Json> {
    return this.worker.run(async () => {
      const current = this.store.upgrades.confirmed();
      requireUpgrade(
        current?.activationGeneration === generation &&
          this.store.upgrades.instance().service_state === 'confirmed' &&
          this.store.upgrades.pending().attempts.length === 0 &&
          this.store.upgrades.recovery()?.state !== 'recovering',
        'CONTRACT_ACTIVATION_CONFLICT',
      );
      requireUpgrade(
        (await this.inspector.installedProof(current)).qualified === true,
        'CONTRACT_CURRENT_WRITER_UNCONFIRMED',
      );
      const expandAttemptId = await this.business.expandAttemptId(plan.expandPlanDigest);
      requireUpgrade(expandAttemptId, 'CONTRACT_EXPAND_UNCONFIRMED');
      const upgrade = this.store.upgrades.snapshot(expandAttemptId);
      const windowKey = String(generation) + ':' + plan.planDigest;
      const anchor = this.windows.get(windowKey) ?? performance.now();
      this.windows.set(windowKey, anchor);
      const windowMs = Math.max(plan.rollbackWindowMs, upgrade.plan.policy.retentionMs);
      const elapsed = performance.now() - anchor;
      requireUpgrade(skipWindow || elapsed >= windowMs, 'CONTRACT_ROLLBACK_WINDOW_OPEN');
      const facts = await this.business.contractFacts(plan);
      requireUpgrade(facts.newReadsConfirmed, 'CONTRACT_NEW_READS_UNCONFIRMED');
      const baseline = this.store.ledgerSqlite
        .prepare<unknown[], { snapshot: string }>(
          'SELECT snapshot FROM upgrade_continuity_baselines WHERE attempt_id=?',
        )
        .get(expandAttemptId);
      requireUpgrade(baseline, 'CONTRACT_READER_INVENTORY_UNCONFIRMED');
      const source = upgradeRecord(upgradeRecord(JSON.parse(baseline.snapshot)).coordinator);
      requireUpgrade(
        source.startIdentity === (await this.business.currentStartIdentity()) ||
          readers.some(
            (r) =>
              r.startIdentity === source.startIdentity &&
              r.artifactDigest === source.artifactDigest,
          ),
        'CONTRACT_READER_INVENTORY_UNCONFIRMED',
      );
      for (const reader of readers) {
        if (retired[String(reader.readerId)]) {
          const fresh = await this.supervisor('/retire-reader', {
            ...upgradeRecord(upgradeRecord(retired[String(reader.readerId)]).lookup),
            readerId: String(reader.readerId),
          });
          requireUpgrade(
            fresh.retired === true && fresh.originalResourcesPreserved === true,
            'CONTRACT_RETIREMENT_UNKNOWN',
          );
          continue;
        }
        if (reader.retired === true) {
          const physical = optionalUpgradeRecord(reader.retirementEvidence);
          requireUpgrade(
            physical?.qualified === true && physical.definitelyAbsent === true,
            'CONTRACT_RETIREMENT_UNKNOWN',
          );
          continue;
        }
        const management = reader.metadataPath === '/internal/coordinator/identity';
        const url =
          loopbackOrigin(
            management
              ? (reader.managementOrigin ?? reader.origin)
              : (reader.applicationOrigin ?? reader.origin),
          ) + String(reader.metadataPath);
        const response = await fetch(url, {
          headers: {
            'x-platform-internal-key': management
              ? (process.env.PLATFORM_CONTROLLER_RPC_KEY ?? '')
              : (process.env.PLATFORM_CONTROL_RPC_KEY ?? ''),
            'x-platform-instance-id': this.store.upgrades.instanceId,
          },
          signal: AbortSignal.timeout(1500),
        });
        requireUpgrade(response.ok, 'CONTRACT_READER_UNCONFIRMED');
        const identity = upgradeRecord(await response.json());
        requireUpgrade(
          identity.instanceId === this.store.upgrades.instanceId &&
            identity.role === 'coordinator' &&
            identity.startIdentity === reader.startIdentity &&
            identity.artifactDigest === reader.artifactDigest &&
            identity.pid === reader.pid &&
            identity.writerFenceValid === false &&
            identity.activeTransportConnections === 0 &&
            identity.activeRequests === 0 &&
            identity.activeStreams === 0 &&
            identity.activeMutations === 0,
          'CONTRACT_READER_STILL_DEPENDENT',
        );
      }
      const owners = await this.business.ownerRoutes();
      for (const owner of owners) {
        const response = await fetch(loopbackOrigin(owner.endpoint) + '/runtime/metadata', {
          headers: {
            'x-platform-internal-key': process.env.PLATFORM_COORDINATOR_RPC_KEY ?? '',
            'x-platform-instance-id': this.store.upgrades.instanceId,
          },
          signal: AbortSignal.timeout(1500),
        });
        requireUpgrade(response.ok, 'CONTRACT_OWNER_DEPENDENCY_UNKNOWN');
        const actual = upgradeRecord(await response.json());
        requireUpgrade(
          actual.instanceId === this.store.upgrades.instanceId &&
            actual.ownerId === owner.ownerId &&
            actual.role === 'runtime-owner' &&
            actual.databaseScope === 'owner-private' &&
            actual.noBusinessDatabaseAccess === true,
          'CONTRACT_OWNER_STILL_DEPENDENT',
        );
      }
      const isolation = await this.supervisor('/owner-isolation');
      const ownerIds = owners.map((owner) => owner.ownerId).sort();
      requireUpgrade(
        isolation.instanceId === this.store.upgrades.instanceId &&
          isolation.qualified === true &&
          Array.isArray(isolation.ownerIds) &&
          JSON.stringify(z.array(z.string()).parse(isolation.ownerIds).sort()) ===
            JSON.stringify(ownerIds) &&
          typeof isolation.evidenceDigest === 'string',
        'CONTRACT_OWNER_ISOLATION_UNCONFIRMED',
      );
      return {
        windowClosed: true,
        newRepresentationComplete: true,
        newReadsConfirmed: true,
        ownersNoBusinessDB: true,
        currentWriterConfirmed: true,
        allowedRole: 'coordinator',
        observedAt: this.clock.now().toISOString(),
      };
    });
  }
  async status(): Promise<UpgradeContractStatus> {
    return this.worker.run(async () => {
      const last = this.store.latest();
      const base: UpgradeContractStatus = {
        authority: (await this.business.projectNameAuthoritative()) ? 'new' : 'legacy',
        availablePlan: null,
        attempt: last?.attempt ?? null,
      };
      if (base.authority === 'new' && (!last || last.attempt.state === 'completed')) return base;
      try {
        const fixed = await this.installedPlan();
        const key = String(fixed.current.activationGeneration) + ':' + fixed.plan.planDigest;
        if (!this.windows.has(key)) this.windows.set(key, performance.now());
        let records: Json[] = [];
        let eligible = false,
          reason: string | null = null;
        try {
          records = await this.readers();
          await this.qualify(fixed.plan, records, fixed.current.activationGeneration);
          eligible = true;
        } catch (error) {
          reason = error instanceof UpgradeError ? error.code : 'CONTRACT_OBSERVATION_UNKNOWN';
        }
        const ms = Math.max(
          fixed.plan.rollbackWindowMs,
          fixed.signedManifest.manifest.policy.retentionMs,
        );
        base.availablePlan = {
          planDigest: fixed.plan.planDigest,
          releaseId: fixed.current.releaseId,
          expandPlanDigest: fixed.plan.expandPlanDigest,
          rollbackWindowClosesAt: fromEpochMs(
            this.clock.now().getTime() +
              Math.max(0, ms - (performance.now() - requiredUpgradeValue(this.windows.get(key)))),
          ).toISOString(),
          eligible,
          reason,
          legacyReaderCount: records.length,
          irreversible: true,
        };
      } catch {
        /* Missing signed installed plan grants no irreversible capability. */
      }
      return base;
    });
  }
  async request(req: Request, res: Response, command: UpgradeContractRequest) {
    return this.worker.run(async () => {
      const principal = this.security.principal(req, res, this.store.upgrades.instanceId);
      this.security.mutation(req, principal);
      const replay = this.store.replay(principal.actorId, command);
      if (replay) return replay.attempt;
      const fixed = await this.installedPlan(command.targetPlanDigest),
        readers = await this.readers();
      requireUpgrade(
        fixed.current.activationGeneration === command.expectedActivationGeneration,
        'CONTRACT_ACTIVATION_CONFLICT',
      );
      const eligibility = await this.qualify(
        fixed.plan,
        readers,
        command.expectedActivationGeneration,
      );
      const entry = await this.inspector.entryBinding();
      let record = this.store.accept(
        principal.actorId,
        command,
        {
          plan: fixed.plan,
          signedManifest: fixed.signedManifest,
          expandAttemptId: fixed.expandAttemptId,
          readers,
          eligibility: { ...eligibility, entryFenceSynchronized: false },
        },
        Number(entry.fence),
      );
      record = await this.syncEntryFence(record);
      return record.attempt;
    });
  }
  private async syncEntryFence(record: ContractRecord): Promise<ContractRecord> {
    return this.worker.run(async () => {
      const id = record.attempt.contractAttemptId;
      const existing = this.syncing.get(id);
      if (existing) return existing;
      const work = this.performEntryFence(this.store.snapshot(id));
      this.syncing.set(id, work);
      try {
        return await work;
      } finally {
        if (this.syncing.get(id) === work) this.syncing.delete(id);
      }
    });
  }
  private async performEntryFence(record: ContractRecord): Promise<ContractRecord> {
    return this.worker.run(async () => {
      if (record.eligibility.entryFenceSynchronized === true) return record;
      this.store.assertFence(record.attempt.contractAttemptId, record.fence);
      const response = await fetch(
        loopbackOrigin(process.env.PLATFORM_ENTRY_CONTROL_ORIGIN) + '/contract-fence',
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-platform-internal-key': process.env.PLATFORM_ENTRY_CONTROL_KEY ?? '',
          },
          body: JSON.stringify({
            instanceId: this.store.upgrades.instanceId,
            contractAttemptId: record.attempt.contractAttemptId,
            fence: record.fence,
          }),
          signal: AbortSignal.timeout(2000),
        },
      );
      requireUpgrade(response.ok, 'CONTRACT_ENTRY_FENCE_UNCONFIRMED');
      return this.store.save(
        record,
        {},
        { eligibility: { ...record.eligibility, entryFenceSynchronized: true } },
      );
    });
  }
  lookup(req: Request, res: Response, id: string) {
    const principal = this.security.principal(req, res, this.store.upgrades.instanceId);
    requireUpgrade(principal.canUpgrade, 'INSTANCE_UPGRADE_PERMISSION_REQUIRED', 403);
    return this.store.lookup(principal.actorId, id);
  }
  check(id: string, fence: number) {
    const record = this.store.assertFence(id, fence);
    requireUpgrade(
      ['accepted', 'retiring-readers', 'authority-active', 'clearing'].includes(
        record.attempt.state,
      ),
      'CONTRACT_TERMINAL_INTENT',
    );
    return { qualified: true, record };
  }
  async tick(): Promise<void> {
    return this.worker.run(async () => {
      if (
        this.running ||
        (process.env.PLATFORM_PROCESS_ROLE !== 'upgrade-control' &&
          process.env.COORDINATOR_WRITER_FENCE_VALID !== 'true')
      )
        return;
      this.running = true;
      try {
        for (let record of this.store.active()) {
          try {
            this.store.assertFence(record.attempt.contractAttemptId, record.fence);
            record = await this.syncEntryFence(record);
            // Fixed target remains signed and accepted; no catalog latest lookup.
            const roots = await readUpgradeTrustRoot(process.env.UPGRADE_TRUST_ROOT_PATH ?? '');
            const verified = verifyUpgradeEnvelope(
              record.signedManifest,
              roots,
              this.clock.now().getTime(),
            );
            requireUpgrade(
              record.command.targetPlanDigest === record.plan.planDigest &&
                verified.manifest.contractPlans?.some(
                  (plan) => canonicalUpgrade(plan) === canonicalUpgrade(record.plan),
                ),
              'CONTRACT_SIGNED_PLAN_CHANGED',
            );
            await this.business.budget(record.plan);
            if (
              record.attempt.state === 'accepted' ||
              record.attempt.state === 'retiring-readers'
            ) {
              // Accepted window proof is durable, but current representation/writer/owners/readers
              // are measured again. A crash never restarts the rollback window as authorization.
              await this.qualify(
                record.plan,
                record.readers,
                record.attempt.activationGeneration,
                true,
                record.retirementReceipts,
              );
              if (record.attempt.state === 'accepted')
                record = this.store.save(record, {
                  state: 'retiring-readers',
                  stage: '核验并退出旧数据读取进程',
                });
              for (const reader of record.readers) {
                const readerId = String(reader.readerId);
                if (record.retirementReceipts[readerId]) continue;
                this.store.assertFence(record.attempt.contractAttemptId, record.fence);
                const receipt = await this.supervisor('/retire-reader', {
                  contractAttemptId: record.attempt.contractAttemptId,
                  fence: record.fence,
                  operationId: record.attempt.contractAttemptId + ':retire:' + readerId,
                  readerId,
                });
                requireUpgrade(
                  receipt.retired === true && receipt.originalResourcesPreserved === true,
                  'CONTRACT_RETIREMENT_UNKNOWN',
                );
                record = this.store.save(
                  record,
                  {},
                  {
                    retirementReceipts: {
                      ...record.retirementReceipts,
                      [readerId]: {
                        ...receipt,
                        lookup: {
                          contractAttemptId: record.attempt.contractAttemptId,
                          fence: record.fence,
                          operationId: record.attempt.contractAttemptId + ':retire:' + readerId,
                        },
                      },
                    },
                  },
                );
              }
              await this.business.activate(record, (total) => {
                record = this.store.save(record, {
                  state: 'authority-active',
                  stage: '新数据格式已成为唯一权威',
                  totalRows: total,
                });
              });
            }
            if (
              record.attempt.state === 'authority-active' ||
              record.attempt.state === 'clearing'
            ) {
              await this.business.clear(record, (batch) => {
                record = this.store.save(record, {
                  state: batch.complete ? 'completed' : 'clearing',
                  stage: batch.complete ? '旧用户数据表示已清理' : '分批清理旧用户数据表示',
                  completedRows: record.attempt.completedRows + batch.cleared,
                  ...(batch.complete
                    ? { totalRows: record.attempt.completedRows + batch.cleared }
                    : {}),
                });
              });
            }
          } catch (error) {
            const current = this.store.snapshot(record.attempt.contractAttemptId);
            if (
              ['accepted', 'retiring-readers', 'authority-active', 'clearing'].includes(
                current.attempt.state,
              )
            ) {
              const reason =
                error instanceof UpgradeError ? error.code : 'CONTRACT_OPERATION_UNKNOWN';
              // Stop this intent; no automatic new request/retry and never restore old data.
              this.store.save(current, {
                state: (await this.business.projectNameAuthoritative()) ? 'failed' : 'deferred',
                stage: '独立清理已停止推进',
                reason,
              });
            }
          }
        }
      } finally {
        this.running = false;
      }
    });
  }
}
