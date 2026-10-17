import { Inject, Injectable } from '@nestjs/common';
import type Database from 'better-sqlite3';
import {
  CLOCK,
  ID_GENERATOR,
  fromEpochMs,
  type Clock,
  type IdGenerator,
} from '@platform/shared-kernel';
import { platformInstanceId } from '@platform/sandbox';
import {
  ConfirmedServiceReleaseSchema,
  UpgradePlanSchema,
  UpgradeAttemptSchema,
  UpgradeSourceActualSchema,
  type ConfirmedServiceRelease,
  type SignedUpgradeManifest,
  type UpgradeAttempt,
  type UpgradePlan,
  type UpgradeRequest,
  type UpgradeRecovery,
  type UpgradeSourceActual,
} from '@platform/contracts';
import { PLATFORM_SQLITE } from '../persistence/platform.module';
import {
  requireUpgrade,
  upgradeDigest,
  canonicalUpgrade,
  freezeUpgradePlan,
} from './upgrade-trust';

import { contractActive, contractFenceFloor } from './upgrade-contract-authority';

interface AttemptRow {
  attempt_id: string;
  instance_id: string;
  actor_id: string;
  request_id: string;
  request_digest: string;
  target_release_id: string;
  target_digest: string;
  manifest: string;
  plan: string;
  source_activation: string;
  source_actual: string | null;
  generation: number;
  sequence: number;
  state: UpgradeAttempt['state'];
  stage: string;
  reason: string | null;
  controller_id: string | null;
  fence: number;
  lease_expires_at: number;
  accepted_at: number;
  observed_at: number;
}
interface InstanceRow {
  instance_id: string;
  activation_generation: number;
  confirmed_release: string | null;
  service_state: 'confirmed' | 'transitioning' | 'unknown';
  ready: number;
  updated_at: number;
}
interface StepRow {
  step_id: string;
  completed_work: number;
  applied: number;
  receipt_digest: string | null;
  evidence: string | null;
  applied_at: number | null;
}
export interface UpgradeCommit {
  fence: number;
  generation: number;
  expectedSequence: number;
  eventId: string;
  kind:
    | 'progress'
    | 'step-applied'
    | 'deferred'
    | 'failed'
    | 'activation-confirmed'
    | 'ready-revoked'
    | 'recovery-started'
    | 'recovery-confirmed'
    | 'recovery-failed';
  payload: Record<string, unknown>;
}
const ACTIVE =
  "('accepted','downloading','package-verified','migrating','prepared','candidate-ready','routing-switched','observing','api-activated')";

/** All methods run on the Coordinator's actual business SQLite connection. */
@Injectable()
export class UpgradeStore {
  readonly instanceId = platformInstanceId();
  constructor(
    @Inject(PLATFORM_SQLITE) readonly sqlite: Database.Database,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
  ) {
    if (!sqlite.prepare('SELECT 1 FROM upgrade_instances WHERE instance_id=?').get(this.instanceId))
      sqlite
        .prepare('INSERT INTO upgrade_instances(instance_id,updated_at) VALUES(?,?)')
        .run(this.instanceId, this.now());
  }
  private now(): number {
    return this.clock.now().getTime();
  }
  private iso(value: number): string {
    return fromEpochMs(value).toISOString();
  }
  instance(): InstanceRow {
    return this.sqlite
      .prepare('SELECT * FROM upgrade_instances WHERE instance_id=?')
      .get(this.instanceId) as InstanceRow;
  }
  confirmed(): ConfirmedServiceRelease | null {
    const value = this.instance().confirmed_release;
    return value ? ConfirmedServiceReleaseSchema.parse(JSON.parse(value)) : null;
  }
  appliedBridges(): string[] {
    const rows = this.sqlite
      .prepare(
        "SELECT target_release_id FROM upgrade_attempts WHERE instance_id=? AND state='activation-confirmed'",
      )
      .all(this.instanceId) as { target_release_id: string }[];
    return [
      ...new Set([
        ...(this.confirmed() ? [this.confirmed()!.releaseId] : []),
        ...rows.map((r) => r.target_release_id),
      ]),
    ];
  }
  bootstrap(release: ConfirmedServiceRelease): void {
    this.sqlite
      .transaction(() => {
        const current = this.instance();
        requireUpgrade(
          current.activation_generation === 0 && current.confirmed_release === null,
          'INSTANCE_ALREADY_REGISTERED',
        );
        requireUpgrade(release.activationGeneration === 1, 'INVALID_INITIAL_GENERATION');
        this.sqlite
          .prepare(
            'UPDATE upgrade_instances SET activation_generation=1,confirmed_release=?,service_state=?,ready=1,updated_at=? WHERE instance_id=?',
          )
          .run(JSON.stringify(release), 'confirmed', this.now(), this.instanceId);
      })
      .immediate();
  }
  private row(id: string): AttemptRow {
    const row = this.sqlite
      .prepare('SELECT * FROM upgrade_attempts WHERE attempt_id=? AND instance_id=?')
      .get(id, this.instanceId) as AttemptRow | undefined;
    requireUpgrade(row, 'UPGRADE_ATTEMPT_NOT_FOUND', 404);
    return row;
  }
  plan(id: string): UpgradePlan {
    return UpgradePlanSchema.parse(JSON.parse(this.row(id).plan));
  }
  private steps(id: string): StepRow[] {
    return this.sqlite
      .prepare('SELECT * FROM upgrade_steps WHERE attempt_id=?')
      .all(id) as StepRow[];
  }
  attempt(id: string): UpgradeAttempt {
    const row = this.row(id),
      plan = this.plan(id),
      steps = this.steps(id);
    let completedWork = 0,
      totalWork = 0,
      fraction = 0,
      unknown = false;
    for (const step of plan.steps) {
      const actual = steps.find((s) => s.step_id === step.stepId);
      const work = actual?.completed_work ?? 0;
      requireUpgrade(
        Number.isFinite(work) && work >= 0 && (step.totalWork === null || work <= step.totalWork),
        'UPGRADE_WORK_CONFLICT',
      );
      completedWork += work;
      if (step.totalWork === null) {
        let completedTotal: number | null = null;
        if (
          actual?.applied === 1 &&
          actual.receipt_digest &&
          actual.evidence &&
          actual.applied_at !== null &&
          Number.isFinite(actual.applied_at)
        ) {
          try {
            const receipt = JSON.parse(actual.evidence) as Record<string, unknown>;
            if (
              receipt?.commitKnown === true &&
              receipt.complete === true &&
              receipt.integrityValid === true &&
              receipt.budgetExceeded === false &&
              receipt.completedWork === work &&
              upgradeDigest(receipt) === actual.receipt_digest
            )
              completedTotal = work;
          } catch {
            /* An invalid completion receipt cannot resolve an unknown total. */
          }
        }
        unknown ||= completedTotal === null;
        if (completedTotal !== null) totalWork += completedTotal;
        fraction += actual?.applied === 1 ? 1 : 0;
      } else {
        totalWork += step.totalWork;
        fraction +=
          step.totalWork === 0 ? Number(actual?.applied === 1) : Math.min(1, work / step.totalWork);
      }
    }
    const percent =
      row.state === 'activation-confirmed'
        ? 100
        : unknown
          ? null
          : Math.min(99, Math.floor((100 * fraction) / plan.steps.length));
    return UpgradeAttemptSchema.parse({
      instanceId: row.instance_id,
      attemptId: row.attempt_id,
      requestId: row.request_id,
      targetReleaseId: row.target_release_id,
      targetDigest: row.target_digest,
      generation: row.generation,
      sequence: row.sequence,
      state: row.state,
      stage: row.stage,
      percent,
      completedWork,
      totalWork: unknown ? null : totalWork,
      planDigest: plan.planDigest,
      acceptedAt: this.iso(row.accepted_at),
      observedAt: this.iso(row.observed_at),
      reason: row.reason,
    });
  }
  private latestAttemptId(): string | null {
    const row = this.sqlite
      .prepare(
        'SELECT attempt_id FROM upgrade_attempts WHERE instance_id=? ORDER BY generation DESC,rowid DESC LIMIT 1',
      )
      .get(this.instanceId) as { attempt_id: string } | undefined;
    return row?.attempt_id ?? null;
  }
  latest(): UpgradeAttempt | null {
    const id = this.latestAttemptId();
    return id ? this.attempt(id) : null;
  }
  /** Current probe inputs only. Historical observation receipts can be megabytes
   * each; the 20 Hz sampler must never load or decode them to choose a lane. */
  latestProbeSnapshot() {
    const row = this.sqlite
      .prepare(
        'SELECT attempt_id,fence,lease_expires_at,plan,manifest,source_activation,source_actual FROM upgrade_attempts WHERE instance_id=? ORDER BY generation DESC,rowid DESC LIMIT 1',
      )
      .get(this.instanceId) as
      | Pick<
          AttemptRow,
          | 'attempt_id'
          | 'fence'
          | 'lease_expires_at'
          | 'plan'
          | 'manifest'
          | 'source_activation'
          | 'source_actual'
        >
      | undefined;
    if (!row) return null;
    const candidate = this.sqlite
      .prepare(
        "SELECT step_id,receipt_digest,completed_work,evidence FROM upgrade_steps WHERE attempt_id=? AND step_id='candidate' AND applied=1",
      )
      .get(row.attempt_id) as
      Pick<StepRow, 'step_id' | 'receipt_digest' | 'completed_work' | 'evidence'> | undefined;
    return {
      attempt: { attemptId: row.attempt_id },
      fence: row.fence,
      leaseExpiresAt: row.lease_expires_at,
      plan: UpgradePlanSchema.parse(JSON.parse(row.plan)),
      manifest: (JSON.parse(row.manifest) as SignedUpgradeManifest).manifest,
      sourceActivation: ConfirmedServiceReleaseSchema.parse(JSON.parse(row.source_activation)),
      sourceActual: row.source_actual
        ? UpgradeSourceActualSchema.parse(JSON.parse(row.source_actual))
        : null,
      appliedSteps: candidate
        ? [
            {
              stepId: candidate.step_id,
              receiptDigest: candidate.receipt_digest,
              completedWork: candidate.completed_work,
              evidence: candidate.evidence ? (JSON.parse(candidate.evidence) as unknown) : null,
            },
          ]
        : [],
    };
  }
  lookup(actorId: string, requestId: string): UpgradeAttempt {
    const row = this.sqlite
      .prepare(
        'SELECT attempt_id FROM upgrade_attempts WHERE instance_id=? AND actor_id=? AND request_id=?',
      )
      .get(this.instanceId, actorId, requestId) as { attempt_id: string } | undefined;
    requireUpgrade(row, 'UPGRADE_REQUEST_NOT_FOUND', 404);
    return this.attempt(row.attempt_id);
  }
  replay(actorId: string, request: UpgradeRequest): UpgradeAttempt | null {
    const prior = this.sqlite
      .prepare('SELECT * FROM upgrade_attempts WHERE instance_id=? AND actor_id=? AND request_id=?')
      .get(this.instanceId, actorId, request.requestId) as AttemptRow | undefined;
    if (!prior) return null;
    requireUpgrade(
      prior.request_digest === upgradeDigest(request),
      'UPGRADE_REQUEST_PAYLOAD_CONFLICT',
    );
    return this.attempt(prior.attempt_id);
  }
  accept(
    actorId: string,
    request: UpgradeRequest,
    envelope: SignedUpgradeManifest,
    plan: UpgradePlan,
    entryFenceFloor?: number,
    continuityBaseline?: Record<string, unknown>,
    sourceActual?: UpgradeSourceActual | null,
  ): UpgradeAttempt {
    return this.sqlite
      .transaction(() => {
        const digest = upgradeDigest(request);
        const prior = this.sqlite
          .prepare(
            'SELECT * FROM upgrade_attempts WHERE instance_id=? AND actor_id=? AND request_id=?',
          )
          .get(this.instanceId, actorId, request.requestId) as AttemptRow | undefined;
        if (prior) {
          requireUpgrade(prior.request_digest === digest, 'UPGRADE_REQUEST_PAYLOAD_CONFLICT');
          return this.attempt(prior.attempt_id);
        }
        const installed = this.instance();
        requireUpgrade(!contractActive(this.sqlite, this.instanceId), 'INSTANCE_CONTRACT_ACTIVE');
        if (sourceActual) {
          sourceActual = UpgradeSourceActualSchema.parse(sourceActual);
          const { proofDigest, ...facts } = sourceActual;
          requireUpgrade(
            upgradeDigest(facts) === proofDigest &&
              sourceActual.instanceId === this.instanceId &&
              sourceActual.activationGeneration === installed.activation_generation &&
              sourceActual.baseConfirmedReleaseId === this.confirmed()?.releaseId &&
              this.now() - Date.parse(sourceActual.observedAt) >= 0 &&
              this.now() - Date.parse(sourceActual.observedAt) <= 5000,
            'REPAIR_SOURCE_UNCONFIRMED',
          );
          const latest = this.latest();
          requireUpgrade(
            latest &&
              [
                'deferred',
                'failed',
                'reverted',
                'candidate-rejected',
                'activation-confirmed',
              ].includes(latest.state),
            'REPAIR_SOURCE_NOT_TERMINAL',
          );
        }
        requireUpgrade(
          installed.activation_generation === request.expectedActivationGeneration &&
            (installed.service_state === 'confirmed' || sourceActual),
          'UPGRADE_ACTIVATION_CONFLICT',
        );
        requireUpgrade(
          envelope.manifest.releaseId === request.targetReleaseId &&
            envelope.manifestDigest === request.targetDigest,
          'UPGRADE_TARGET_CHANGED',
        );
        requireUpgrade(
          plan.sourceActivationGeneration === installed.activation_generation,
          'UPGRADE_ACTIVATION_CONFLICT',
        );
        const history = this.confirmed();
        requireUpgrade(history, 'INSTALLED_RELEASE_UNKNOWN');
        requireUpgrade(
          canonicalUpgrade(plan) ===
            canonicalUpgrade(
              freezeUpgradePlan(
                envelope,
                sourceActual
                  ? { ...history, schema: sourceActual.schema, components: sourceActual.components }
                  : history,
                this.appliedBridges(),
              ),
            ),
          'FROZEN_SOURCE_PLAN_CONFLICT',
        );
        const active = this.sqlite
          .prepare(
            `SELECT attempt_id FROM upgrade_attempts WHERE instance_id=? AND state IN ${ACTIVE}`,
          )
          .get(this.instanceId);
        requireUpgrade(!active, 'UPGRADE_ALREADY_ACTIVE');
        requireUpgrade(
          !this.sqlite
            .prepare("SELECT 1 FROM upgrade_recoveries WHERE instance_id=? AND state='recovering'")
            .get(this.instanceId),
          'UPGRADE_ALREADY_ACTIVE',
        );
        const max = this.sqlite
          .prepare(
            'SELECT coalesce(max(generation),0) AS generation FROM upgrade_attempts WHERE instance_id=?',
          )
          .get(this.instanceId) as { generation: number };
        const id = this.ids.next(),
          generation = Math.max(max.generation, installed.activation_generation) + 1,
          now = this.now();
        requireUpgrade(installed.confirmed_release, 'INSTALLED_RELEASE_UNKNOWN');
        // A new explicit intent supersedes ALL older controller authority, including
        // post-activation retention monitoring. Their immutable receipts remain readable.
        this.sqlite
          .prepare(
            'UPDATE upgrade_attempts SET lease_expires_at=0,controller_id=NULL WHERE instance_id=?',
          )
          .run(this.instanceId);
        const highFence = this.sqlite
          .prepare('SELECT coalesce(max(fence),0) AS n FROM upgrade_attempts WHERE instance_id=?')
          .get(this.instanceId) as { n: number };
        requireUpgrade(
          entryFenceFloor === undefined ||
            (Number.isSafeInteger(entryFenceFloor) && entryFenceFloor >= 0),
          'ENTRY_FENCE_UNKNOWN',
        );
        const intentFence =
          entryFenceFloor === undefined
            ? contractFenceFloor(this.sqlite, this.instanceId) > 0
              ? Math.max(highFence.n, contractFenceFloor(this.sqlite, this.instanceId)) + 1
              : 0
            : Math.max(
                highFence.n,
                entryFenceFloor,
                contractFenceFloor(this.sqlite, this.instanceId),
              ) + 1;
        this.sqlite
          .prepare(
            `INSERT INTO upgrade_attempts(attempt_id,instance_id,actor_id,request_id,request_digest,target_release_id,target_digest,manifest,plan,source_activation,source_actual,generation,accepted_at,observed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          )
          .run(
            id,
            this.instanceId,
            actorId,
            request.requestId,
            digest,
            request.targetReleaseId,
            request.targetDigest,
            JSON.stringify(envelope),
            JSON.stringify(plan),
            installed.confirmed_release,
            sourceActual ? JSON.stringify(sourceActual) : null,
            generation,
            now,
            now,
          );
        if (intentFence)
          this.sqlite
            .prepare('UPDATE upgrade_attempts SET fence=?,lease_expires_at=? WHERE attempt_id=?')
            .run(intentFence, now + 30_000, id);
        if (continuityBaseline)
          this.sqlite
            .prepare('INSERT INTO upgrade_continuity_baselines VALUES(?,?,?,?)')
            .run(id, JSON.stringify(continuityBaseline), upgradeDigest(continuityBaseline), now);
        const insert = this.sqlite.prepare(
          'INSERT INTO upgrade_steps(attempt_id,step_id) VALUES(?,?)',
        );
        for (const step of plan.steps) insert.run(id, step.stepId);
        return this.attempt(id);
      })
      .immediate();
  }
  snapshot(id: string) {
    const row = this.row(id);
    const recovery = this.recovery();
    const activeRecovery = recovery?.triggeringAttemptId === id ? recovery : null;
    const recoveryRow = activeRecovery
      ? (this.sqlite
          .prepare('SELECT plan FROM upgrade_recoveries WHERE recovery_attempt_id=?')
          .get(activeRecovery.recoveryAttemptId) as { plan: string })
      : undefined;
    return {
      attempt: { ...this.attempt(id), actorId: row.actor_id },
      signedManifest: JSON.parse(row.manifest) as SignedUpgradeManifest,
      manifest: (JSON.parse(row.manifest) as SignedUpgradeManifest).manifest,
      plan: this.plan(id),
      sourceActivation: ConfirmedServiceReleaseSchema.parse(JSON.parse(row.source_activation)),
      sourceActual: row.source_actual
        ? UpgradeSourceActualSchema.parse(JSON.parse(row.source_actual))
        : null,
      appliedBridgeReleases: this.appliedBridges(),
      appliedSteps: this.steps(id)
        .filter((s) => s.applied === 1)
        .map((s) => ({
          stepId: s.step_id,
          receiptDigest: s.receipt_digest,
          completedWork: s.completed_work,
          evidence: s.evidence ? (JSON.parse(s.evidence) as unknown) : null,
        })),
      fence: row.fence,
      controllerId: row.controller_id,
      leaseExpiresAt: row.lease_expires_at,
      recovery: activeRecovery,
      recoveryPlan: recoveryRow ? (JSON.parse(recoveryRow.plan) as Record<string, unknown>) : null,
    };
  }
  pending() {
    const rows = this.sqlite
      .prepare(
        `SELECT attempt_id FROM upgrade_attempts a WHERE instance_id=? AND (state IN ${ACTIVE} OR EXISTS(SELECT 1 FROM upgrade_recoveries r WHERE r.triggering_attempt_id=a.attempt_id AND r.state='recovering')) ORDER BY generation DESC,rowid DESC`,
      )
      .all(this.instanceId) as { attempt_id: string }[];
    return {
      instanceId: this.instanceId,
      attempts: rows.map((row) => this.snapshot(row.attempt_id)),
    };
  }
  preserveCriticalAuthority(id: string, fence: number): void {
    this.assertControllerFence(id, fence);
    this.sqlite
      .prepare(
        'UPDATE upgrade_attempts SET lease_expires_at=max(lease_expires_at,?) WHERE attempt_id=? AND fence=?',
      )
      .run(this.now() + 10_000, id, fence);
  }
  claim(id: string, controllerId: string, leaseMs: number, entryFenceFloor = 0) {
    requireUpgrade(
      /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,180}$/.test(controllerId) &&
        Number.isSafeInteger(leaseMs) &&
        leaseMs >= 500 &&
        leaseMs <= 120_000,
      'INVALID_CONTROLLER_LEASE',
      400,
    );
    return this.sqlite
      .transaction(() => {
        const row = this.row(id),
          now = this.now();
        const critical =
          this.sqlite
            .prepare(
              "SELECT stage FROM coordinator_handoffs WHERE attempt_id=? AND stage IN ('quiesced','releasing','adopting')",
            )
            .get(id) ??
          this.sqlite
            .prepare(
              "SELECT stage FROM coordinator_recoveries WHERE triggering_attempt_id=? AND stage IN ('quiesced','releasing','adopting')",
            )
            .get(id);
        requireUpgrade(
          !critical || (row.controller_id === controllerId && row.lease_expires_at > now),
          'COORDINATOR_HANDOFF_CRITICAL',
        );
        const latest = this.latest();
        requireUpgrade(
          contractFenceFloor(this.sqlite, this.instanceId) === 0 ||
            row.fence > contractFenceFloor(this.sqlite, this.instanceId),
          'UPGRADE_AUTHORITY_SUPERSEDED',
        );
        requireUpgrade(latest?.attemptId === id, 'UPGRADE_AUTHORITY_SUPERSEDED');
        const recovery = this.recovery();
        requireUpgrade(
          !['failed', 'deferred', 'candidate-rejected', 'reverted'].includes(row.state) ||
            (recovery?.triggeringAttemptId === id && recovery.state === 'recovering'),
          'UPGRADE_TERMINAL_ATTEMPT',
        );
        requireUpgrade(
          !row.controller_id || row.controller_id === controllerId || row.lease_expires_at <= now,
          'UPGRADE_CONTROLLER_BUSY',
        );
        const high = this.sqlite
          .prepare(
            'SELECT coalesce(max(fence),0) AS fence FROM upgrade_attempts WHERE instance_id=?',
          )
          .get(this.instanceId) as { fence: number };
        requireUpgrade(
          Number.isSafeInteger(entryFenceFloor) && entryFenceFloor >= 0,
          'ENTRY_FENCE_UNKNOWN',
        );
        const fence =
          row.controller_id === controllerId && row.lease_expires_at > now
            ? row.fence
            : Math.max(
                high.fence,
                entryFenceFloor,
                contractFenceFloor(this.sqlite, this.instanceId),
              ) + 1;
        this.sqlite
          .prepare(
            'UPDATE upgrade_attempts SET controller_id=?,fence=?,lease_expires_at=? WHERE attempt_id=?',
          )
          .run(controllerId, fence, now + leaseMs, id);
        return { fence, generation: row.generation, snapshot: this.snapshot(id) };
      })
      .immediate();
  }
  assertFence(id: string, fence: number, generation?: number): AttemptRow {
    const row = this.row(id);
    requireUpgrade(
      this.latestAttemptId() === id &&
        (contractFenceFloor(this.sqlite, this.instanceId) === 0 ||
          row.fence > contractFenceFloor(this.sqlite, this.instanceId)),
      'UPGRADE_AUTHORITY_SUPERSEDED',
    );
    requireUpgrade(
      Number.isSafeInteger(fence) &&
        row.fence === fence &&
        row.lease_expires_at > this.now() &&
        (generation === undefined || row.generation === generation),
      'UPGRADE_FENCE_EXPIRED',
    );
    return row;
  }
  assertControllerFence(id: string, fence: number, generation?: number): AttemptRow {
    const row = this.assertFence(id, fence, generation);
    requireUpgrade(row.controller_id !== null, 'CONTROLLER_CLAIM_REQUIRED');
    return row;
  }
  renew(id: string, fence: number, controllerId: string | null, checkOnly = false) {
    const row = this.assertFence(id, fence);
    requireUpgrade(checkOnly || row.controller_id === controllerId, 'UPGRADE_CONTROLLER_MISMATCH');
    if (!checkOnly)
      this.sqlite
        .prepare('UPDATE upgrade_attempts SET lease_expires_at=? WHERE attempt_id=? AND fence=?')
        .run(this.now() + 30_000, id, fence);
    return { fence: row.fence, generation: row.generation, snapshot: this.snapshot(id) };
  }
  transferController(id: string, fence: number): void {
    this.sqlite
      .transaction(() => {
        this.assertFence(id, fence);
        this.sqlite
          .prepare(
            'UPDATE upgrade_attempts SET controller_id=NULL,lease_expires_at=0 WHERE attempt_id=? AND fence=?',
          )
          .run(id, fence);
      })
      .immediate();
  }
  step(
    id: string,
    stepId: string,
  ): {
    stepId: string;
    applied: boolean;
    completedWork: number;
    receiptDigest: string | null;
    evidence: unknown;
  } {
    const row = this.steps(id).find((s) => s.step_id === stepId);
    requireUpgrade(row, 'UPGRADE_STEP_NOT_FOUND', 404);
    return {
      stepId,
      applied: row.applied === 1,
      completedWork: row.completed_work,
      receiptDigest: row.receipt_digest,
      evidence: row.evidence ? (JSON.parse(row.evidence) as unknown) : null,
    };
  }
  commit(
    id: string,
    command: UpgradeCommit,
    confirmed?: ConfirmedServiceRelease,
    restoredPartial?: UpgradeSourceActual,
  ) {
    return this.sqlite
      .transaction(() => {
        const digest = upgradeDigest(command);
        const prior = this.sqlite
          .prepare('SELECT event_digest FROM upgrade_events WHERE event_id=? AND attempt_id=?')
          .get(command.eventId, id) as { event_digest: string } | undefined;
        if (prior) {
          requireUpgrade(prior.event_digest === digest, 'UPGRADE_EVENT_PAYLOAD_CONFLICT');
          return this.snapshot(id);
        }
        const row = this.assertControllerFence(id, command.fence, command.generation);
        requireUpgrade(row.sequence === command.expectedSequence, 'UPGRADE_SEQUENCE_CONFLICT');
        const p = command.payload,
          plan = this.plan(id),
          now = this.now(),
          next = row.sequence + 1;
        requireUpgrade(
          typeof command.eventId === 'string' &&
            command.eventId.length >= 1 &&
            command.eventId.length <= 200,
          'INVALID_EVENT_ID',
          400,
        );
        if (command.kind === 'progress' || command.kind === 'step-applied') {
          requireUpgrade(
            row.state !== 'activation-confirmed' &&
              !['failed', 'reverted', 'deferred', 'candidate-rejected'].includes(row.state),
            'UPGRADE_TERMINAL_ATTEMPT',
          );
          const step = plan.steps.find((s) => s.stepId === p.stepId);
          requireUpgrade(step, 'UPGRADE_STEP_NOT_FOUND', 400);
          const existing = this.step(id, step.stepId);
          requireUpgrade(
            typeof p.completedWork === 'number' &&
              Number.isFinite(p.completedWork) &&
              p.completedWork >= existing.completedWork &&
              (step.totalWork === null || p.completedWork <= step.totalWork),
            'UPGRADE_WORK_CONFLICT',
            400,
          );
          const index = plan.steps.indexOf(step);
          requireUpgrade(
            plan.steps.slice(0, index).every((s) => this.step(id, s.stepId).applied),
            'UPGRADE_STEP_DEPENDENCY',
          );
          if (command.kind === 'step-applied') {
            requireUpgrade(
              typeof p.receiptDigest === 'string' &&
                p.evidence !== undefined &&
                p.receiptDigest === upgradeDigest(p.evidence) &&
                (step.totalWork === null || p.completedWork === step.totalWork),
              'UPGRADE_RECEIPT_INVALID',
            );
            requireUpgrade(
              !existing.applied || existing.receiptDigest === p.receiptDigest,
              'UPGRADE_RECEIPT_CONFLICT',
            );
            this.sqlite
              .prepare(
                'UPDATE upgrade_steps SET completed_work=?,applied=1,receipt_digest=?,evidence=?,applied_at=? WHERE attempt_id=? AND step_id=?',
              )
              .run(
                p.completedWork,
                p.receiptDigest,
                JSON.stringify(p.evidence ?? null),
                now,
                id,
                step.stepId,
              );
          } else
            this.sqlite
              .prepare(
                'UPDATE upgrade_steps SET completed_work=?,evidence=? WHERE attempt_id=? AND step_id=? AND applied=0',
              )
              .run(p.completedWork, JSON.stringify(p.evidence ?? null), id, step.stepId);
          const states: Record<string, UpgradeAttempt['state']> = {
            download: 'downloading',
            verify: 'package-verified',
            'installer-handoff': 'prepared',
            migration: 'migrating',
            'owner-candidate': 'prepared',
            candidate: 'candidate-ready',
            'coordinator-handoff': 'prepared',
            route: 'routing-switched',
            observe: 'observing',
            web: 'api-activated',
            activation: 'api-activated',
          };
          this.sqlite
            .prepare('UPDATE upgrade_attempts SET state=?,stage=? WHERE attempt_id=?')
            .run(states[step.kind], step.stepId, id);
          if (
            step.kind === 'route' ||
            step.kind === 'web' ||
            (command.kind === 'step-applied' &&
              ['coordinator-handoff', 'owner-candidate', 'installer-handoff', 'migration'].includes(
                step.kind,
              ))
          )
            this.sqlite
              .prepare(
                'UPDATE upgrade_instances SET service_state=?,ready=0,updated_at=? WHERE instance_id=?',
              )
              .run('transitioning', now, this.instanceId);
        } else if (command.kind === 'activation-confirmed') {
          requireUpgrade(
            confirmed && plan.steps.every((step) => this.step(id, step.stepId).applied),
            'OVERALL_ACTIVATION_UNCONFIRMED',
          );
          confirmed = ConfirmedServiceReleaseSchema.parse(confirmed);
          requireUpgrade(
            confirmed.releaseId === row.target_release_id &&
              confirmed.activationGeneration > this.instance().activation_generation,
            'ACTIVATION_IDENTITY_CONFLICT',
          );
          this.sqlite
            .prepare(
              'UPDATE upgrade_instances SET activation_generation=?,confirmed_release=?,service_state=?,ready=1,updated_at=? WHERE instance_id=?',
            )
            .run(
              confirmed.activationGeneration,
              JSON.stringify(confirmed),
              'confirmed',
              now,
              this.instanceId,
            );
          this.sqlite
            .prepare('UPDATE upgrade_attempts SET state=?,stage=?,reason=NULL WHERE attempt_id=?')
            .run('activation-confirmed', 'activation-confirmed', id);
        } else if (
          command.kind === 'failed' ||
          command.kind === 'deferred' ||
          command.kind === 'ready-revoked'
        ) {
          requireUpgrade(
            typeof p.reason === 'string' || typeof p.code === 'string',
            'UPGRADE_FAILURE_REASON_REQUIRED',
          );
          const reason = String(p.reason ?? p.code).slice(0, 500);
          // An activation-confirmed success is never rewritten as if it originally failed.
          if (row.state !== 'activation-confirmed')
            this.sqlite
              .prepare('UPDATE upgrade_attempts SET state=?,stage=?,reason=? WHERE attempt_id=?')
              .run(command.kind === 'deferred' ? 'deferred' : 'failed', command.kind, reason, id);
          this.sqlite
            .prepare('UPDATE upgrade_instances SET ready=0,updated_at=? WHERE instance_id=?')
            .run(now, this.instanceId);
        } else if (command.kind === 'recovery-started') {
          requireUpgrade(
            p.recoveryPlan && typeof p.recoveryPlan === 'object' && typeof p.reason === 'string',
            'RECOVERY_PLAN_REQUIRED',
          );
          requireUpgrade(
            !this.recovery() || this.recovery()?.state !== 'recovering',
            'RECOVERY_ALREADY_ACTIVE',
          );
          const recoveryId =
              typeof p.recoveryAttemptId === 'string' ? p.recoveryAttemptId : this.ids.next(),
            recoveryGeneration = row.generation + 1;
          requireUpgrade(/^[a-f0-9-]{36}$/.test(recoveryId), 'INVALID_RECOVERY_ID');
          const high = this.sqlite
            .prepare(
              'SELECT coalesce(max(fence),0) AS fence FROM upgrade_attempts WHERE instance_id=?',
            )
            .get(this.instanceId) as { fence: number };
          const fixedRecovery = p.recoveryPlan as Record<string, unknown>,
            { planDigest: declaredDigest, ...planInput } = fixedRecovery;
          const recoveryDigest = upgradeDigest(planInput);
          requireUpgrade(
            declaredDigest === recoveryDigest && fixedRecovery.triggeringAttemptId === id,
            'RECOVERY_PLAN_DIGEST_CONFLICT',
          );
          const recoveryPlan = JSON.stringify(fixedRecovery);
          this.sqlite
            .prepare(
              'INSERT INTO upgrade_recoveries(recovery_attempt_id,triggering_attempt_id,instance_id,generation,sequence,state,plan,plan_digest,reason,observed_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
            )
            .run(
              recoveryId,
              id,
              this.instanceId,
              recoveryGeneration,
              0,
              'recovering',
              recoveryPlan,
              recoveryDigest,
              p.reason,
              now,
            );
          this.sqlite
            .prepare(
              'UPDATE upgrade_attempts SET generation=?,fence=?,lease_expires_at=? WHERE attempt_id=?',
            )
            .run(recoveryGeneration, high.fence + 1, now + 30_000, id);
          this.sqlite
            .prepare(
              'UPDATE upgrade_instances SET ready=0,service_state=?,updated_at=? WHERE instance_id=?',
            )
            .run('transitioning', now, this.instanceId);
        } else {
          const recovery = this.recovery();
          requireUpgrade(
            recovery && recovery.triggeringAttemptId === id && recovery.state === 'recovering',
            'RECOVERY_NOT_ACTIVE',
          );
          if (command.kind === 'recovery-confirmed') {
            requireUpgrade(confirmed || restoredPartial, 'RECOVERY_UNCONFIRMED');
            if (restoredPartial) {
              restoredPartial = UpgradeSourceActualSchema.parse(restoredPartial);
              const { proofDigest, ...facts } = restoredPartial;
              requireUpgrade(
                upgradeDigest(facts) === proofDigest &&
                  restoredPartial.instanceId === this.instanceId &&
                  restoredPartial.activationGeneration === this.instance().activation_generation &&
                  restoredPartial.baseConfirmedReleaseId === this.confirmed()?.releaseId,
                'RECOVERY_PARTIAL_SOURCE_CONFLICT',
              );
              this.sqlite
                .prepare(
                  'UPDATE upgrade_instances SET service_state=?,ready=0,updated_at=? WHERE instance_id=?',
                )
                .run('unknown', now, this.instanceId);
            } else {
              confirmed = ConfirmedServiceReleaseSchema.parse(confirmed);
              requireUpgrade(
                confirmed.activationGeneration > this.instance().activation_generation,
                'RECOVERY_ACTIVATION_GENERATION_CONFLICT',
              );
              this.sqlite
                .prepare(
                  'UPDATE upgrade_instances SET activation_generation=?,confirmed_release=?,service_state=?,ready=0,updated_at=? WHERE instance_id=?',
                )
                .run(
                  confirmed.activationGeneration,
                  JSON.stringify(confirmed),
                  'confirmed',
                  now,
                  this.instanceId,
                );
            }
            if (row.state !== 'activation-confirmed')
              this.sqlite
                .prepare('UPDATE upgrade_attempts SET state=?,stage=? WHERE attempt_id=?')
                .run('reverted', 'recovery-confirmed', id);
          }
          this.sqlite
            .prepare(
              'UPDATE upgrade_recoveries SET sequence=sequence+1,state=?,observed_at=? WHERE recovery_attempt_id=?',
            )
            .run(
              command.kind === 'recovery-confirmed' ? 'recovery-confirmed' : 'unknown',
              now,
              recovery.recoveryAttemptId,
            );
        }
        this.sqlite
          .prepare('UPDATE upgrade_attempts SET sequence=?,observed_at=? WHERE attempt_id=?')
          .run(next, now, id);
        this.sqlite
          .prepare(
            'INSERT INTO upgrade_events(event_id,attempt_id,event_digest,generation,sequence,fence,kind,payload,recorded_at) VALUES(?,?,?,?,?,?,?,?,?)',
          )
          .run(
            command.eventId,
            id,
            digest,
            command.generation,
            next,
            command.fence,
            command.kind,
            JSON.stringify(p),
            now,
          );
        return this.snapshot(id);
      })
      .immediate();
  }
  recovery(): UpgradeRecovery | null {
    const row = this.sqlite
      .prepare(
        'SELECT * FROM upgrade_recoveries WHERE instance_id=? ORDER BY generation DESC,rowid DESC LIMIT 1',
      )
      .get(this.instanceId) as
      | {
          recovery_attempt_id: string;
          triggering_attempt_id: string;
          generation: number;
          sequence: number;
          state: UpgradeRecovery['state'];
          plan_digest: string;
          reason: string;
          observed_at: number;
        }
      | undefined;
    return row
      ? {
          recoveryAttemptId: row.recovery_attempt_id,
          triggeringAttemptId: row.triggering_attempt_id,
          generation: row.generation,
          sequence: row.sequence,
          state: row.state,
          planDigest: row.plan_digest,
          reason: row.reason,
          observedAt: this.iso(row.observed_at),
        }
      : null;
  }
}
