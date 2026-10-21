import { SignedUpgradeManifestSchema } from '@platform/contracts';
import {
  withBusinessAction,
  readBusinessActionStatus,
  assertPendingBusinessActionsSettled,
} from './upgrade-business-action';
import { z } from 'zod';
import { requiredUpgradeValue, upgradeRecord } from './upgrade-values';
import { Inject, Injectable, Optional } from '@nestjs/common';
import type Database from 'better-sqlite3';
import type { Request } from 'express';
import {
  currentUpgradeRecovery,
  assertRecoveryBusinessAdmission,
  recoveryAdmissionId,
  RECOVERY_ADMISSION_ROLE,
  RECOVERY_ACTION_ROLE,
} from '../persistence/upgrade-recovery-context';
import {
  withRecoveryRequest,
  readRecoveryAuthority,
  recoveryView,
} from './upgrade-recovery-authority';
import {
  CLOCK,
  ID_GENERATOR,
  fromEpochMs,
  type Clock,
  type IdGenerator,
} from '@platform/shared-kernel';
import { platformInstanceId } from '@platform/shared-kernel';
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
  type UpgradeStageProgress,
} from '@platform/contracts';
import { PLATFORM_SQLITE } from '../persistence/platform-sqlite.token';
import {
  requireUpgrade,
  upgradeDigest,
  canonicalUpgrade,
  freezeUpgradePlan,
} from './upgrade-trust';

import { contractActive, contractFenceFloor } from './upgrade-contract-authority';
import {
  UPGRADE_STORE_OPTIONS,
  UPGRADE_CONTROL_CAPABILITIES,
  type UpgradeStoreOptions,
  type UpgradeControlReceipt,
  type UpgradeCheckpoint,
  type UpgradeCommitReceipt,
} from './upgrade-control-bridge';

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
type AuthorityAttemptRow = Omit<
  AttemptRow,
  'manifest' | 'plan' | 'source_activation' | 'source_actual'
>;
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

/** Ledger writes use ledgerSqlite; business participants keep their own sqlite authority. */
@Injectable()
export class UpgradeStore {
  readonly instanceId: string;
  readonly ledgerSqlite: Database.Database;
  private readonly options: UpgradeStoreOptions;
  private readonly fastMetadata: boolean;
  constructor(
    @Inject(PLATFORM_SQLITE) readonly sqlite: Database.Database,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
    @Optional() @Inject(UPGRADE_STORE_OPTIONS) options?: UpgradeStoreOptions,
  ) {
    this.options = options ?? {};
    this.instanceId = options?.instanceId ?? platformInstanceId();
    requireUpgrade(
      /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(this.instanceId),
      'INVALID_INSTANCE_ID',
    );
    this.ledgerSqlite = options?.ledgerSqlite ?? sqlite;
    this.fastMetadata = ['upgrade_attempts', 'upgrade_steps'].every((table, index) =>
      this.ledgerSqlite
        .prepare<unknown[], { name: string }>(`PRAGMA table_info(${table})`)
        .all()
        .some((column) => column.name === ['plan_digest', 'evidence_digest'][index]),
    );
    if (
      !options?.readonly &&
      !this.ledgerSqlite
        .prepare('SELECT 1 FROM upgrade_instances WHERE instance_id=?')
        .get(this.instanceId)
    )
      this.ledgerSqlite
        .prepare('INSERT INTO upgrade_instances(instance_id,updated_at) VALUES(?,?)')
        .run(this.instanceId, this.now());
  }
  get ledgerReadonly(): boolean {
    return this.options.readonly === true;
  }
  controlCapabilities() {
    return this.fastMetadata
      ? UPGRADE_CONTROL_CAPABILITIES
      : { progressEvidenceReference: 1 as const };
  }
  businessAction(
    headers: Record<string, string | string[] | undefined>,
    id: string,
    method: 'coordinatorHandoff' | 'ownerCandidate' | 'migration',
    input: Record<string, unknown>,
    work: () => Promise<Record<string, unknown>>,
    preparedAdopt = false,
  ) {
    return withBusinessAction(this, this.clock, headers, id, method, input, work, preparedAdopt);
  }
  participantCommandStatus(id: string, commandId: string) {
    return readBusinessActionStatus(this, this.clock, id, commandId);
  }
  recoveryRequest<T>(
    req: Pick<Request, 'headers'>,
    id: string | undefined,
    mode: 'read' | 'admit' | 'restore' | 'observe' | 'stabilize',
    work: () => T,
  ): T {
    return withRecoveryRequest(
      {
        req,
        sqlite: this.ledgerSqlite,
        instanceId: this.instanceId,
        clock: this.clock,
        readonlyLedger: this.ledgerReadonly,
        attemptId: id,
        mode,
      },
      work,
    );
  }
  /** Business observer timer selects an actual active independent recovery.
   * This does not mint authority or create a new intent. */
  recoveryObservation<T>(work: () => T): T | null {
    if (!this.ledgerReadonly) return null;
    const authority = this.ledgerSqlite
      .prepare<
        unknown[],
        {
          epoch: number;
          operation_id: string | null;
          kind: string;
          mode: string;
          lease_expires_at: number;
        }
      >(
        'SELECT epoch,operation_id,kind,mode,lease_expires_at FROM control_authority WHERE instance_id=?',
      )
      .get(this.instanceId);
    if (
      authority?.kind !== 'recovery' ||
      authority.mode !== 'active' ||
      !authority.operation_id ||
      authority.lease_expires_at <= this.now()
    )
      return null;
    return this.recoveryRequest(
      {
        headers: {
          'x-platform-recovery-id': authority.operation_id,
          'x-platform-recovery-epoch': String(authority.epoch),
        },
      },
      undefined,
      'observe',
      work,
    );
  }
  private recoveryAuthority(id?: string, fence?: number) {
    const context = currentUpgradeRecovery();
    if (!context) return null;
    requireUpgrade(
      this.ledgerReadonly &&
        context.instanceId === this.instanceId &&
        (id === undefined || context.attemptId === id) &&
        (fence === undefined || context.epoch === fence),
      'RECOVERY_AUTHORITY_SCOPE_MISMATCH',
    );
    context.assertGlobal();
    return readRecoveryAuthority(
      this.ledgerSqlite,
      this.instanceId,
      this.clock,
      context.recoveryId,
      context.epoch,
      context.attemptId,
    );
  }
  assertRecoveryMutation(): void {
    this.recoveryAuthority();
    assertRecoveryBusinessAdmission(this.sqlite);
  }
  admitRecovery(id: string, fence: number) {
    const current = this.recoveryAuthority(id, fence),
      context = currentUpgradeRecovery();
    requireUpgrade(current && context?.mode === 'admit', 'RECOVERY_ADMISSION_CONTEXT_REQUIRED');
    return this.sqlite
      .transaction(() => {
        this.recoveryAuthority(id, fence);
        if (
          this.ledgerSqlite
            .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='control_commands'")
            .get()
        )
          assertPendingBusinessActionsSettled(this, this.clock, id);
        const old = this.sqlite
          .prepare<unknown[], { fence: number; actor_id: string; request_digest: string }>(
            'SELECT fence,actor_id,request_digest FROM platform_operations WHERE operation_id=? AND instance_id=? AND role=?',
          )
          .get(recoveryAdmissionId(this.instanceId), this.instanceId, RECOVERY_ADMISSION_ROLE);
        requireUpgrade(!old || old.fence <= fence, 'RECOVERY_PARTICIPANT_EPOCH_SUPERSEDED');
        if (old?.fence === fence)
          requireUpgrade(
            old.actor_id === context.recoveryId && old.request_digest === id,
            'RECOVERY_PARTICIPANT_EPOCH_CONFLICT',
          );
        else {
          const unresolved = this.sqlite
            .prepare<
              unknown[],
              {
                operation_id: string;
                actor_id: string;
                request_digest: string;
                result: string | null;
              }
            >(
              "SELECT operation_id,actor_id,request_digest,result FROM platform_operations WHERE instance_id=? AND role=? AND state IN ('pending','running','unknown')",
            )
            .all(this.instanceId, RECOVERY_ACTION_ROLE);
          for (const action of unresolved) {
            const result = this.knownRecoveryAction(
              action.actor_id,
              action.request_digest,
              action.result,
            );
            if (result)
              this.sqlite
                .prepare(
                  "UPDATE platform_operations SET state='completed',result=?,updated_at=? WHERE operation_id=? AND instance_id=? AND role=?",
                )
                .run(
                  canonicalUpgrade(result),
                  this.now(),
                  action.operation_id,
                  this.instanceId,
                  RECOVERY_ACTION_ROLE,
                );
          }
          requireUpgrade(
            !this.sqlite
              .prepare(
                "SELECT 1 FROM platform_operations WHERE instance_id=? AND role=? AND state IN ('pending','running','unknown') LIMIT 1",
              )
              .get(this.instanceId, RECOVERY_ACTION_ROLE),
            'RECOVERY_PREVIOUS_ACTION_UNKNOWN',
          );
          this.sqlite
            .prepare(
              'INSERT INTO platform_operations(operation_id,instance_id,actor_id,role,fence,request_digest,state,result,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(operation_id) DO UPDATE SET actor_id=excluded.actor_id,fence=excluded.fence,request_digest=excluded.request_digest,state=excluded.state,result=excluded.result,updated_at=excluded.updated_at',
            )
            .run(
              recoveryAdmissionId(this.instanceId),
              this.instanceId,
              context.recoveryId,
              RECOVERY_ADMISSION_ROLE,
              fence,
              id,
              'admitted',
              null,
              this.now(),
              this.now(),
            );
        }
        return {
          instanceId: this.instanceId,
          recoveryId: context.recoveryId,
          triggeringAttemptId: id,
          epoch: fence,
          admitted: true as const,
        };
      })
      .immediate();
  }
  recoveryActions(id: string) {
    const current = this.recoveryAuthority(id);
    requireUpgrade(current, 'RECOVERY_AUTHORITY_CONTEXT_REQUIRED');
    return this.sqlite
      .prepare<
        unknown[],
        {
          operation_id: string;
          fence: number;
          request_digest: string;
          state: string;
          result: string | null;
        }
      >(
        'SELECT operation_id,fence,request_digest,state,result FROM platform_operations WHERE instance_id=? AND actor_id=? AND role=? ORDER BY operation_id',
      )
      .all(this.instanceId, current.row.recovery_id, RECOVERY_ACTION_ROLE)
      .map((row) => {
        const known =
          row.state === 'completed'
            ? row.result
              ? upgradeRecord(JSON.parse(row.result))
              : null
            : this.knownRecoveryAction(current.row.recovery_id, row.request_digest, row.result);
        return {
          commandId: row.operation_id,
          epoch: row.fence,
          specDigest: row.request_digest,
          state: known ? 'completed' : row.state,
          result: known,
        };
      });
  }
  private knownRecoveryAction(
    recoveryId: string,
    specDigest: string,
    value: string | null,
  ): Record<string, unknown> | null {
    if (!value) return null;
    const spec = upgradeRecord(JSON.parse(value)).commandSpec;
    if (!spec || upgradeDigest(spec) !== specDigest) return null;
    const input = upgradeRecord(upgradeRecord(spec).input);
    const row = this.sqlite
      .prepare<unknown[], { plan_digest: string; stage: string; evidence: string | null }>(
        'SELECT plan_digest,stage,evidence FROM coordinator_recoveries WHERE recovery_attempt_id=?',
      )
      .get(recoveryId);
    if (row?.stage !== 'adopted' || row.plan_digest !== input.recoveryPlanDigest || !row.evidence)
      return null;
    const evidence = upgradeRecord(JSON.parse(row.evidence));
    return evidence.commitKnown === true ? evidence : null;
  }
  async recoveryAction(
    id: string,
    action: 'coordinator-recovery' | 'coordinator-resume' | 'stabilize-current-writer',
    input: Record<string, unknown>,
    work: () => Promise<Record<string, unknown>>,
  ): Promise<Record<string, unknown>> {
    const current = this.recoveryAuthority(id);
    if (!current) return work();
    requireUpgrade(
      action === 'stabilize-current-writer'
        ? currentUpgradeRecovery()?.mode === 'stabilize'
        : currentUpgradeRecovery()?.mode === 'restore',
      'RECOVERY_RESTORE_CONTEXT_REQUIRED',
    );
    const commandId = current.row.recovery_id + ':' + action;
    const { fence: _envelope, ...immutableInput } = input;
    const commandSpec = { attemptId: id, action, input: immutableInput },
      specDigest = upgradeDigest(commandSpec);
    const original = this.sqlite
      .prepare<
        unknown[],
        { fence: number; request_digest: string; state: string; result: string | null }
      >(
        'SELECT fence,request_digest,state,result FROM platform_operations WHERE operation_id=? AND instance_id=? AND role=?',
      )
      .get(commandId, this.instanceId, RECOVERY_ACTION_ROLE);
    // The current writer durably reserves resume before releasing its lease.
    // A retained reader may verify that reservation, then reacquire under the
    // local epoch barrier; it must never bypass its old writer fence to journal.
    const reservedResume = action === 'coordinator-resume';
    if (reservedResume) {
      this.assertRecoveryMutation();
      requireUpgrade(
        original?.request_digest === specDigest &&
          (original.state === 'completed' ||
            (original.state === 'pending' && original.fence === current.row.epoch)),
        'RECOVERY_RESUME_COMMAND_NOT_RESERVED',
      );
      if (original.state === 'completed' && original.result !== null)
        return upgradeRecord(JSON.parse(original.result));
    }
    const prior = reservedResume
      ? null
      : this.sqlite
          .transaction(() => {
            this.assertRecoveryMutation();
            const old = this.sqlite
              .prepare<unknown[], { request_digest: string; state: string; result: string | null }>(
                'SELECT request_digest,state,result FROM platform_operations WHERE operation_id=? AND instance_id=? AND role=?',
              )
              .get(commandId, this.instanceId, RECOVERY_ACTION_ROLE);
            if (old) {
              requireUpgrade(old.request_digest === specDigest, 'RECOVERY_COMMAND_SPEC_CONFLICT');
              requireUpgrade(
                old.state === 'completed' && old.result !== null,
                'RECOVERY_COMMAND_OUTCOME_UNKNOWN',
              );
              return upgradeRecord(JSON.parse(old.result));
            }
            this.sqlite
              .prepare(
                'INSERT INTO platform_operations(operation_id,instance_id,actor_id,role,fence,request_digest,state,result,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
              )
              .run(
                commandId,
                this.instanceId,
                current.row.recovery_id,
                RECOVERY_ACTION_ROLE,
                current.row.epoch,
                specDigest,
                'running',
                canonicalUpgrade({ commandSpec }),
                this.now(),
                this.now(),
              );
            if (action === 'coordinator-recovery' && current.plan?.coordinator) {
              const resumeId = current.row.recovery_id + ':coordinator-resume',
                resumeDigest = upgradeDigest({
                  attemptId: id,
                  action: 'coordinator-resume',
                  input: { recoveryPlanDigest: input.recoveryPlanDigest },
                });
              this.sqlite
                .prepare(
                  'INSERT INTO platform_operations(operation_id,instance_id,actor_id,role,fence,request_digest,state,result,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
                )
                .run(
                  resumeId,
                  this.instanceId,
                  current.row.recovery_id,
                  RECOVERY_ACTION_ROLE,
                  current.row.epoch,
                  resumeDigest,
                  'pending',
                  canonicalUpgrade({
                    commandSpec: {
                      attemptId: id,
                      action: 'coordinator-resume',
                      input: { recoveryPlanDigest: input.recoveryPlanDigest },
                    },
                  }),
                  this.now(),
                  this.now(),
                );
            }
            return null;
          })
          .immediate();
    if (prior) return prior;
    try {
      const result = await work();
      const durable = this.knownRecoveryAction(
        current.row.recovery_id,
        specDigest,
        canonicalUpgrade({ commandSpec }),
      );
      // The releasing process has lost the business writer. Its successor's
      // adopted row is the original durable outcome, not permission to write.
      if (!reservedResume && durable && upgradeDigest(durable) === upgradeDigest(result))
        return result;
      this.sqlite
        .transaction(() => {
          this.assertRecoveryMutation();
          this.sqlite
            .prepare(
              "UPDATE platform_operations SET state='completed',result=?,updated_at=? WHERE operation_id=? AND instance_id=? AND role=? AND fence=? AND state IN ('pending','running')",
            )
            .run(
              canonicalUpgrade(result),
              this.now(),
              commandId,
              this.instanceId,
              RECOVERY_ACTION_ROLE,
              current.row.epoch,
            );
        })
        .immediate();
      return result;
    } catch (error) {
      // An exception after an await is not proof that the physical action failed.
      try {
        this.sqlite
          .transaction(() => {
            this.assertRecoveryMutation();
            this.sqlite
              .prepare(
                "UPDATE platform_operations SET state='unknown',updated_at=? WHERE operation_id=? AND instance_id=? AND role=? AND fence=? AND state='running'",
              )
              .run(this.now(), commandId, this.instanceId, RECOVERY_ACTION_ROLE, current.row.epoch);
          })
          .immediate();
      } catch {
        /* retain durable running/unknown for reconciliation */
      }
      throw error;
    }
  }
  private assertLedgerWritable(): void {
    requireUpgrade(!this.options.readonly, 'CONTROL_LEDGER_READONLY');
  }
  private assertGlobalUpgrade(id: string, fence: number): void {
    if (!this.ledgerReadonly) return;
    const authority = this.ledgerSqlite
      .prepare<
        unknown[],
        {
          epoch: number;
          operation_id: string;
          kind: string;
          mode: string;
          holder_id: string | null;
          lease_expires_at: number;
        }
      >(
        'SELECT epoch,operation_id,kind,mode,holder_id,lease_expires_at FROM control_authority WHERE instance_id=?',
      )
      .get(this.instanceId);
    requireUpgrade(
      authority?.mode === 'active' &&
        authority.kind === 'upgrade' &&
        authority.operation_id === id &&
        authority.epoch === fence &&
        authority.holder_id &&
        authority.lease_expires_at > this.now(),
      'CONTROL_AUTHORITY_EXPIRED_OR_SUPERSEDED',
    );
  }
  controlEpochFloor(): number {
    if (
      !this.ledgerSqlite
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='control_authority'")
        .get()
    )
      return 0;
    return (
      this.ledgerSqlite
        .prepare<unknown[], { epoch: number }>(
          'SELECT epoch FROM control_authority WHERE instance_id=?',
        )
        .get(this.instanceId)?.epoch ?? 0
    );
  }
  assertControlAdmissionAvailable(): void {
    if (!this.options.independent) return;
    if (
      this.ledgerSqlite
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='control_authority'")
        .get()
    ) {
      const current = this.ledgerSqlite
        .prepare<unknown[], { mode: string; holder_id: string | null; lease_expires_at: number }>(
          'SELECT mode,holder_id,lease_expires_at FROM control_authority WHERE instance_id=?',
        )
        .get(this.instanceId);
      requireUpgrade(
        current?.mode === 'active' &&
          (!current.holder_id || current.lease_expires_at <= this.now()),
        'CONTROL_OPERATION_ALREADY_ACTIVE',
      );
    }
    if (
      this.ledgerSqlite
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='control_recovery_intents'",
        )
        .get()
    )
      requireUpgrade(
        !this.ledgerSqlite
          .prepare(
            "SELECT 1 FROM control_recovery_intents WHERE instance_id=? AND phase IN ('created','reconciling','restoring','verifying') LIMIT 1",
          )
          .get(this.instanceId),
        'CONTROL_RECOVERY_ALREADY_ACTIVE',
      );
  }
  private now(): number {
    return this.clock.now().getTime();
  }
  private iso(value: number): string {
    return fromEpochMs(value).toISOString();
  }
  instance(): InstanceRow {
    return requiredUpgradeValue(
      this.ledgerSqlite
        .prepare<unknown[], InstanceRow>('SELECT * FROM upgrade_instances WHERE instance_id=?')
        .get(this.instanceId),
    );
  }
  confirmed(): ConfirmedServiceRelease | null {
    const value = this.instance().confirmed_release;
    return value ? ConfirmedServiceReleaseSchema.parse(JSON.parse(value)) : null;
  }
  appliedBridges(): string[] {
    const rows = this.ledgerSqlite
      .prepare<unknown[], { target_release_id: string }>(
        "SELECT target_release_id FROM upgrade_attempts WHERE instance_id=? AND state='activation-confirmed'",
      )
      .all(this.instanceId);
    return [
      ...new Set([
        ...(this.confirmed() ? [requiredUpgradeValue(this.confirmed()).releaseId] : []),
        ...rows.map((r) => r.target_release_id),
      ]),
    ];
  }
  bootstrap(release: ConfirmedServiceRelease): void {
    this.assertLedgerWritable();
    this.ledgerSqlite
      .transaction(() => {
        const current = this.instance();
        requireUpgrade(
          current.activation_generation === 0 && current.confirmed_release === null,
          'INSTANCE_ALREADY_REGISTERED',
        );
        requireUpgrade(release.activationGeneration === 1, 'INVALID_INITIAL_GENERATION');
        this.ledgerSqlite
          .prepare(
            'UPDATE upgrade_instances SET activation_generation=1,confirmed_release=?,service_state=?,ready=1,updated_at=? WHERE instance_id=?',
          )
          .run(JSON.stringify(release), 'confirmed', this.now(), this.instanceId);
      })
      .immediate();
  }
  private row(id: string): AttemptRow {
    const row = this.ledgerSqlite
      .prepare<unknown[], AttemptRow>(
        'SELECT * FROM upgrade_attempts WHERE attempt_id=? AND instance_id=?',
      )
      .get(id, this.instanceId);
    requireUpgrade(row, 'UPGRADE_ATTEMPT_NOT_FOUND', 404);
    return row;
  }
  private scalarRow(id: string): AuthorityAttemptRow {
    const row = this.ledgerSqlite
      .prepare<unknown[], AuthorityAttemptRow>(
        `SELECT attempt_id,instance_id,actor_id,request_id,request_digest,target_release_id,target_digest,generation,sequence,state,stage,reason,controller_id,fence,lease_expires_at,accepted_at,observed_at FROM upgrade_attempts WHERE attempt_id=? AND instance_id=?`,
      )
      .get(id, this.instanceId);
    requireUpgrade(row, 'UPGRADE_ATTEMPT_NOT_FOUND', 404);
    return row;
  }
  plan(id: string): UpgradePlan {
    const row = this.ledgerSqlite
      .prepare<unknown[], { plan: string }>(
        'SELECT plan FROM upgrade_attempts WHERE attempt_id=? AND instance_id=?',
      )
      .get(id, this.instanceId);
    requireUpgrade(row, 'UPGRADE_ATTEMPT_NOT_FOUND', 404);
    return UpgradePlanSchema.parse(JSON.parse(row.plan));
  }
  private steps(id: string): StepRow[] {
    return this.ledgerSqlite
      .prepare<unknown[], StepRow>('SELECT * FROM upgrade_steps WHERE attempt_id=?')
      .all(id);
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
            const receipt = upgradeRecord(JSON.parse(actual.evidence));
            if (
              receipt.commitKnown === true &&
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
    const row = this.ledgerSqlite
      .prepare<unknown[], { attempt_id: string }>(
        'SELECT attempt_id FROM upgrade_attempts WHERE instance_id=? ORDER BY generation DESC,rowid DESC LIMIT 1',
      )
      .get(this.instanceId);
    return row?.attempt_id ?? null;
  }
  latest(): UpgradeAttempt | null {
    const id = this.latestAttemptId();
    return id ? this.attempt(id) : null;
  }
  stageProgress(id: string): UpgradeStageProgress | null {
    const row = this.scalarRow(id),
      plan = this.plan(id);
    const stage = plan.steps.find((step) => step.stepId === row.stage);
    if (!stage) return null;
    const actual = this.ledgerSqlite
      .prepare<unknown[], Pick<StepRow, 'completed_work' | 'applied' | 'applied_at'>>(
        'SELECT completed_work,applied,applied_at FROM upgrade_steps WHERE attempt_id=? AND step_id=?',
      )
      .get(id, stage.stepId);
    const saved = this.ledgerSqlite
      .prepare<unknown[], { result: string }>(
        "SELECT result FROM platform_operations WHERE operation_id=? AND instance_id=? AND role='upgrade-stage-progress'",
      )
      .get('upgrade-stage-progress:' + id, this.instanceId);
    const timing = saved
      ? z
          .object({
            stage: z.string(),
            enteredAt: z.string().nullable(),
            lastProgressAt: z.string().nullable(),
          })
          .parse(JSON.parse(saved.result))
      : null;
    const work = actual?.completed_work ?? 0;
    return {
      stage: stage.stepId,
      completedWork: work,
      totalWork: stage.totalWork,
      percent:
        stage.totalWork === null
          ? null
          : stage.totalWork === 0
            ? actual?.applied === 1
              ? 100
              : 0
            : Math.min(100, Math.floor((100 * work) / stage.totalWork)),
      enteredAt: timing?.stage === stage.stepId ? timing.enteredAt : null,
      lastProgressAt:
        timing?.stage === stage.stepId
          ? timing.lastProgressAt
          : actual?.applied_at
            ? this.iso(actual.applied_at)
            : null,
    };
  }
  /** Current probe inputs only. Historical observation receipts can be megabytes
   * each; the 20 Hz sampler must never load or decode them to choose a lane. */
  latestProbeSnapshot() {
    const row = this.ledgerSqlite
      .prepare<
        unknown[],
        Pick<
          AttemptRow,
          | 'attempt_id'
          | 'fence'
          | 'lease_expires_at'
          | 'plan'
          | 'manifest'
          | 'source_activation'
          | 'source_actual'
        >
      >(
        'SELECT attempt_id,fence,lease_expires_at,plan,manifest,source_activation,source_actual FROM upgrade_attempts WHERE instance_id=? ORDER BY generation DESC,rowid DESC LIMIT 1',
      )
      .get(this.instanceId);
    if (!row) return null;
    const candidate = this.ledgerSqlite
      .prepare<
        unknown[],
        Pick<StepRow, 'step_id' | 'receipt_digest' | 'completed_work' | 'evidence'>
      >(
        "SELECT step_id,receipt_digest,completed_work,evidence FROM upgrade_steps WHERE attempt_id=? AND step_id='candidate' AND applied=1",
      )
      .get(row.attempt_id);
    return {
      attempt: { attemptId: row.attempt_id },
      fence: row.fence,
      leaseExpiresAt: row.lease_expires_at,
      plan: UpgradePlanSchema.parse(JSON.parse(row.plan)),
      manifest: SignedUpgradeManifestSchema.parse(JSON.parse(row.manifest)).manifest,
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
    const row = this.ledgerSqlite
      .prepare<unknown[], { attempt_id: string }>(
        'SELECT attempt_id FROM upgrade_attempts WHERE instance_id=? AND actor_id=? AND request_id=?',
      )
      .get(this.instanceId, actorId, requestId);
    requireUpgrade(row, 'UPGRADE_REQUEST_NOT_FOUND', 404);
    return this.attempt(row.attempt_id);
  }
  replay(actorId: string, request: UpgradeRequest): UpgradeAttempt | null {
    const prior = this.ledgerSqlite
      .prepare<unknown[], AttemptRow>(
        'SELECT * FROM upgrade_attempts WHERE instance_id=? AND actor_id=? AND request_id=?',
      )
      .get(this.instanceId, actorId, request.requestId);
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
    operationId?: string,
  ): UpgradeAttempt {
    this.assertLedgerWritable();
    return this.ledgerSqlite
      .transaction(() => {
        const digest = upgradeDigest(request);
        const prior = this.ledgerSqlite
          .prepare<unknown[], AttemptRow>(
            'SELECT * FROM upgrade_attempts WHERE instance_id=? AND actor_id=? AND request_id=?',
          )
          .get(this.instanceId, actorId, request.requestId);
        if (prior) {
          requireUpgrade(prior.request_digest === digest, 'UPGRADE_REQUEST_PAYLOAD_CONFLICT');
          return this.attempt(prior.attempt_id);
        }
        const installed = this.instance();
        if (this.options.independent) {
          this.assertControlAdmissionAvailable();
          requireUpgrade(this.options.dataFormatGuard, 'CONTROL_DATA_FORMAT_GUARD_REQUIRED');
          this.options.dataFormatGuard({
            targetDigest: envelope.manifestDigest,
            coordinatorDataFormats: envelope.manifest.components.coordinator.dataFormats ?? [],
          });
        } else
          requireUpgrade(
            !this.sqlite
              .prepare('SELECT 1 FROM upgrade_online_migrations WHERE read_epoch=2 LIMIT 1')
              .get() ||
              envelope.manifest.components.coordinator.dataFormats?.includes(
                'project-name-v2-authority',
              ),
            'TARGET_DATA_FORMAT_INCOMPATIBLE',
          );
        const activePlan = this.ledgerSqlite
          .prepare<unknown[], { operation_id: string }>(
            "SELECT operation_id FROM platform_operations WHERE instance_id=? AND role='upgrade-plan' AND state IN ('accepted','preparing','running')",
          )
          .get(this.instanceId);
        requireUpgrade(
          !activePlan || activePlan.operation_id === operationId,
          'UPGRADE_ALREADY_ACTIVE',
        );
        requireUpgrade(
          !contractActive(this.ledgerSqlite, this.instanceId),
          'INSTANCE_CONTRACT_ACTIVE',
        );
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
        const active = this.ledgerSqlite
          .prepare(
            `SELECT attempt_id FROM upgrade_attempts WHERE instance_id=? AND state IN ${ACTIVE}`,
          )
          .get(this.instanceId);
        requireUpgrade(!active, 'UPGRADE_ALREADY_ACTIVE');
        requireUpgrade(
          !this.ledgerSqlite
            .prepare("SELECT 1 FROM upgrade_recoveries WHERE instance_id=? AND state='recovering'")
            .get(this.instanceId),
          'UPGRADE_ALREADY_ACTIVE',
        );
        const max = requiredUpgradeValue(
          this.ledgerSqlite
            .prepare<unknown[], { generation: number }>(
              'SELECT coalesce(max(generation),0) AS generation FROM upgrade_attempts WHERE instance_id=?',
            )
            .get(this.instanceId),
        );
        const id = this.ids.next(),
          generation = Math.max(max.generation, installed.activation_generation) + 1,
          now = this.now();
        requireUpgrade(installed.confirmed_release, 'INSTALLED_RELEASE_UNKNOWN');
        // A new explicit intent supersedes ALL older controller authority, including
        // post-activation retention monitoring. Their immutable receipts remain readable.
        this.ledgerSqlite
          .prepare(
            'UPDATE upgrade_attempts SET lease_expires_at=0,controller_id=NULL WHERE instance_id=?',
          )
          .run(this.instanceId);
        const highFence = requiredUpgradeValue(
          this.ledgerSqlite
            .prepare<unknown[], { n: number }>(
              'SELECT coalesce(max(fence),0) AS n FROM upgrade_attempts WHERE instance_id=?',
            )
            .get(this.instanceId),
        );
        requireUpgrade(
          entryFenceFloor === undefined ||
            (Number.isSafeInteger(entryFenceFloor) && entryFenceFloor >= 0),
          'ENTRY_FENCE_UNKNOWN',
        );
        const intentFence =
          entryFenceFloor === undefined
            ? contractFenceFloor(this.ledgerSqlite, this.instanceId) > 0
              ? Math.max(
                  highFence.n,
                  contractFenceFloor(this.ledgerSqlite, this.instanceId),
                  this.controlEpochFloor(),
                ) + 1
              : this.controlEpochFloor() > 0
                ? Math.max(highFence.n, this.controlEpochFloor()) + 1
                : 0
            : Math.max(
                highFence.n,
                entryFenceFloor,
                contractFenceFloor(this.ledgerSqlite, this.instanceId),
                this.controlEpochFloor(),
              ) + 1;
        this.ledgerSqlite
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
          this.ledgerSqlite
            .prepare('UPDATE upgrade_attempts SET fence=?,lease_expires_at=? WHERE attempt_id=?')
            .run(intentFence, now + 30_000, id);
        if (continuityBaseline)
          this.ledgerSqlite
            .prepare('INSERT INTO upgrade_continuity_baselines VALUES(?,?,?,?)')
            .run(id, JSON.stringify(continuityBaseline), upgradeDigest(continuityBaseline), now);
        const insert = this.ledgerSqlite.prepare(
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
    const authority = this.recoveryAuthority(id);
    return {
      controllerCapabilities: this.controlCapabilities(),
      attempt: { ...this.attempt(id), actorId: row.actor_id },
      signedManifest: SignedUpgradeManifestSchema.parse(JSON.parse(row.manifest)),
      manifest: SignedUpgradeManifestSchema.parse(JSON.parse(row.manifest)).manifest,
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
      fence: authority?.row.epoch ?? row.fence,
      controllerId: authority?.authority.holder_id ?? row.controller_id,
      leaseExpiresAt: authority?.authority.lease_expires_at ?? row.lease_expires_at,
      recovery: activeRecovery,
      recoveryPlan: activeRecovery ? this.recoveryPlan() : null,
    };
  }
  pending() {
    const rows = this.ledgerSqlite
      .prepare<unknown[], { attempt_id: string }>(
        `SELECT attempt_id FROM upgrade_attempts a WHERE instance_id=? AND (state IN ${ACTIVE} OR EXISTS(SELECT 1 FROM upgrade_recoveries r WHERE r.triggering_attempt_id=a.attempt_id AND r.state='recovering')) ORDER BY generation DESC,rowid DESC`,
      )
      .all(this.instanceId);
    return {
      instanceId: this.instanceId,
      attempts: rows.map((row) => this.snapshot(row.attempt_id)),
    };
  }
  preserveCriticalAuthority(id: string, fence: number): void {
    this.assertLedgerWritable();
    this.assertControllerFence(id, fence);
    this.ledgerSqlite
      .prepare(
        'UPDATE upgrade_attempts SET lease_expires_at=max(lease_expires_at,?) WHERE attempt_id=? AND fence=?',
      )
      .run(this.now() + 10_000, id, fence);
  }
  claim(id: string, controllerId: string, leaseMs: number, entryFenceFloor = 0) {
    this.assertLedgerWritable();
    requireUpgrade(
      /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,180}$/.test(controllerId) &&
        Number.isSafeInteger(leaseMs) &&
        leaseMs >= 500 &&
        leaseMs <= 120_000,
      'INVALID_CONTROLLER_LEASE',
      400,
    );
    return this.ledgerSqlite
      .transaction(() => {
        const row = this.row(id),
          now = this.now();
        requireUpgrade(
          !this.options.independent || this.options.claimGuard,
          'CONTROL_CLAIM_GUARD_REQUIRED',
        );
        const critical = this.options.claimGuard
          ? this.options.claimGuard({
              attemptId: id,
              controllerId,
              fence: row.fence,
              leaseExpiresAt: row.lease_expires_at,
              now,
            })
          : (this.sqlite
              .prepare(
                "SELECT stage FROM coordinator_handoffs WHERE attempt_id=? AND stage IN ('quiesced','releasing','adopting')",
              )
              .get(id) ??
            this.sqlite
              .prepare(
                "SELECT stage FROM coordinator_recoveries WHERE triggering_attempt_id=? AND stage IN ('quiesced','releasing','adopting')",
              )
              .get(id));
        requireUpgrade(
          !critical || (row.controller_id === controllerId && row.lease_expires_at > now),
          'COORDINATOR_HANDOFF_CRITICAL',
        );
        const latest = this.latest();
        requireUpgrade(
          contractFenceFloor(this.ledgerSqlite, this.instanceId) === 0 ||
            row.fence > contractFenceFloor(this.ledgerSqlite, this.instanceId),
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
        const high = requiredUpgradeValue(
          this.ledgerSqlite
            .prepare<unknown[], { fence: number }>(
              'SELECT coalesce(max(fence),0) AS fence FROM upgrade_attempts WHERE instance_id=?',
            )
            .get(this.instanceId),
        );
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
                contractFenceFloor(this.ledgerSqlite, this.instanceId),
                this.controlEpochFloor(),
              ) + 1;
        this.ledgerSqlite
          .prepare(
            'UPDATE upgrade_attempts SET controller_id=?,fence=?,lease_expires_at=? WHERE attempt_id=?',
          )
          .run(controllerId, fence, now + leaseMs, id);
        return { fence, generation: row.generation, snapshot: this.snapshot(id) };
      })
      .immediate();
  }
  assertFence(id: string, fence: number, generation?: number): AuthorityAttemptRow {
    const row = this.scalarRow(id);
    const recovery = this.recoveryAuthority(id, fence);
    if (recovery) {
      requireUpgrade(
        generation === undefined || generation === recovery.row.epoch,
        'RECOVERY_AUTHORITY_SCOPE_MISMATCH',
      );
      return {
        ...row,
        generation: recovery.row.epoch,
        fence: recovery.row.epoch,
        controller_id: recovery.authority.holder_id,
        lease_expires_at: recovery.authority.lease_expires_at,
      };
    }
    this.assertGlobalUpgrade(id, fence);
    requireUpgrade(
      this.latestAttemptId() === id &&
        (contractFenceFloor(this.ledgerSqlite, this.instanceId) === 0 ||
          row.fence > contractFenceFloor(this.ledgerSqlite, this.instanceId)),
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
  assertControllerFence(id: string, fence: number, generation?: number): AuthorityAttemptRow {
    const row = this.assertFence(id, fence, generation);
    requireUpgrade(row.controller_id !== null, 'CONTROLLER_CLAIM_REQUIRED');
    return row;
  }
  private controlRow(id: string) {
    requireUpgrade(this.fastMetadata, 'UPGRADE_CONTROL_METADATA_UNKNOWN');
    const row = this.ledgerSqlite
      .prepare<
        unknown[],
        {
          attempt_id: string;
          target_digest: string;
          plan_digest: string | null;
          generation: number;
          sequence: number;
          state: UpgradeAttempt['state'];
          stage: string;
          fence: number;
          controller_id: string | null;
          lease_expires_at: number;
          current_attempt_id: string;
          contract_fence_floor: number | null;
          checkpoint_step_id: string | null;
          completed_work: number | null;
          applied: number | null;
          receipt_digest: string | null;
          evidence_digest: string | null;
        }
      >(
        `SELECT a.attempt_id,a.target_digest,a.plan_digest,a.generation,a.sequence,a.state,a.stage,
      a.fence,a.controller_id,a.lease_expires_at,
      (SELECT attempt_id FROM upgrade_attempts WHERE instance_id=? ORDER BY generation DESC,rowid DESC LIMIT 1) AS current_attempt_id,
      (SELECT fence FROM platform_operations WHERE instance_id=? AND role='project-name-contract' ORDER BY fence DESC LIMIT 1) AS contract_fence_floor,
      s.step_id AS checkpoint_step_id,s.completed_work,s.applied,s.receipt_digest,s.evidence_digest
      FROM upgrade_attempts a LEFT JOIN upgrade_steps s ON s.attempt_id=a.attempt_id AND s.step_id=a.stage
      WHERE a.attempt_id=? AND a.instance_id=?`,
      )
      .get(this.instanceId, this.instanceId, id, this.instanceId);
    requireUpgrade(row, 'UPGRADE_ATTEMPT_NOT_FOUND', 404);
    requireUpgrade(
      typeof row.plan_digest === 'string' && /^sha256:[a-f0-9]{64}$/.test(row.plan_digest),
      'UPGRADE_CONTROL_METADATA_UNKNOWN',
    );
    return row;
  }
  private controlReceipt(row: ReturnType<UpgradeStore['controlRow']>): UpgradeControlReceipt {
    return {
      instanceId: this.instanceId,
      attemptId: row.attempt_id,
      targetDigest: row.target_digest,
      planDigest: requiredUpgradeValue(row.plan_digest),
      generation: row.generation,
      sequence: row.sequence,
      state: row.state,
      stage: row.stage,
      fence: row.fence,
      controllerId: row.controller_id,
      leaseExpiresAt: row.lease_expires_at,
    };
  }
  authorityCheck(id: string, fence: number, generation?: number): UpgradeControlReceipt {
    const row = this.controlRow(id);
    requireUpgrade(
      row.current_attempt_id === id && row.fence > (row.contract_fence_floor ?? 0),
      'UPGRADE_AUTHORITY_SUPERSEDED',
    );
    requireUpgrade(
      Number.isSafeInteger(fence) &&
        row.fence === fence &&
        row.lease_expires_at > this.now() &&
        (generation === undefined || row.generation === generation),
      'UPGRADE_FENCE_EXPIRED',
    );
    return this.controlReceipt(row);
  }
  leaseRenew(
    id: string,
    fence: number,
    generation: number,
    controllerId: string,
  ): UpgradeControlReceipt {
    this.assertLedgerWritable();
    return this.ledgerSqlite
      .transaction(() => {
        const original = this.authorityCheck(id, fence, generation),
          now = this.now();
        requireUpgrade(
          original.controllerId === controllerId && controllerId.length > 0,
          'UPGRADE_CONTROLLER_MISMATCH',
        );
        const changed = this.ledgerSqlite
          .prepare(
            `UPDATE upgrade_attempts SET lease_expires_at=?
        WHERE attempt_id=? AND instance_id=? AND fence=? AND generation=? AND controller_id=? AND lease_expires_at>?`,
          )
          .run(now + 30_000, id, this.instanceId, fence, generation, controllerId, now);
        requireUpgrade(changed.changes === 1, 'UPGRADE_FENCE_EXPIRED');
        return this.controlReceipt(this.controlRow(id));
      })
      .immediate();
  }
  progressCheckpoint(id: string, fence: number, generation: number): UpgradeCheckpoint {
    const row = this.controlRow(id);
    requireUpgrade(
      row.current_attempt_id === id && row.fence > (row.contract_fence_floor ?? 0),
      'UPGRADE_AUTHORITY_SUPERSEDED',
    );
    requireUpgrade(
      Number.isSafeInteger(fence) &&
        row.fence === fence &&
        row.generation === generation &&
        row.lease_expires_at > this.now(),
      'UPGRADE_FENCE_EXPIRED',
    );
    return {
      ...this.controlReceipt(row),
      step: row.checkpoint_step_id
        ? {
            stepId: row.checkpoint_step_id,
            completedWork: requiredUpgradeValue(row.completed_work),
            applied: row.applied === 1,
            receiptDigest: row.receipt_digest,
            evidenceDigest: row.evidence_digest,
          }
        : null,
    };
  }
  private eventReceipt(id: string, eventId: string): UpgradeCommitReceipt {
    const event = this.ledgerSqlite
      .prepare<unknown[], { event_digest: string; sequence: number }>(
        'SELECT event_digest,sequence FROM upgrade_events WHERE attempt_id=? AND event_id=?',
      )
      .get(id, eventId);
    requireUpgrade(event, 'UPGRADE_EVENT_NOT_FOUND');
    return {
      ...this.controlReceipt(this.controlRow(id)),
      eventId,
      eventDigest: event.event_digest,
      eventSequence: event.sequence,
    };
  }
  renew(id: string, fence: number, controllerId: string | null, checkOnly = false) {
    if (!checkOnly) this.assertLedgerWritable();
    const row = this.assertFence(id, fence);
    requireUpgrade(checkOnly || row.controller_id === controllerId, 'UPGRADE_CONTROLLER_MISMATCH');
    if (!checkOnly)
      this.ledgerSqlite
        .prepare('UPDATE upgrade_attempts SET lease_expires_at=? WHERE attempt_id=? AND fence=?')
        .run(this.now() + 30_000, id, fence);
    return { fence: row.fence, generation: row.generation, snapshot: this.snapshot(id) };
  }
  transferController(id: string, fence: number): void {
    this.assertLedgerWritable();
    this.ledgerSqlite
      .transaction(() => {
        this.assertFence(id, fence);
        this.ledgerSqlite
          .prepare(
            'UPDATE upgrade_attempts SET controller_id=NULL,lease_expires_at=0 WHERE attempt_id=? AND fence=?',
          )
          .run(id, fence);
      })
      .immediate();
  }
  private stepMetadata(id: string, stepId: string) {
    const row = this.ledgerSqlite
      .prepare<
        unknown[],
        {
          completed_work: number;
          applied: number;
          receipt_digest: string | null;
          evidence_digest: string | null;
        }
      >(
        `SELECT completed_work,applied,receipt_digest,${this.fastMetadata ? 'evidence_digest' : 'NULL AS evidence_digest'} FROM upgrade_steps WHERE attempt_id=? AND step_id=?`,
      )
      .get(id, stepId);
    requireUpgrade(row, 'UPGRADE_STEP_NOT_FOUND', 404);
    return {
      stepId,
      completedWork: row.completed_work,
      applied: row.applied === 1,
      receiptDigest: row.receipt_digest,
      evidenceDigest: row.evidence_digest,
    };
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
    const row = this.ledgerSqlite
      .prepare<unknown[], StepRow>(
        'SELECT step_id,completed_work,applied,receipt_digest,evidence,applied_at FROM upgrade_steps WHERE attempt_id=? AND step_id=?',
      )
      .get(id, stepId);
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
    return this.persistCommit(id, command, confirmed, restoredPartial, () => this.snapshot(id));
  }
  commitReceipt(
    id: string,
    command: UpgradeCommit,
    confirmed?: ConfirmedServiceRelease,
    restoredPartial?: UpgradeSourceActual,
  ): UpgradeCommitReceipt {
    return this.persistCommit(id, command, confirmed, restoredPartial, () =>
      this.eventReceipt(id, command.eventId),
    );
  }
  private persistCommit<T>(
    id: string,
    command: UpgradeCommit,
    confirmed: ConfirmedServiceRelease | undefined,
    restoredPartial: UpgradeSourceActual | undefined,
    result: () => T,
  ): T {
    this.assertLedgerWritable();
    return this.ledgerSqlite
      .transaction(() => {
        const digest = upgradeDigest(command);
        const prior = this.ledgerSqlite
          .prepare<unknown[], { event_digest: string }>(
            'SELECT event_digest FROM upgrade_events WHERE event_id=? AND attempt_id=?',
          )
          .get(command.eventId, id);
        if (prior) {
          requireUpgrade(prior.event_digest === digest, 'UPGRADE_EVENT_PAYLOAD_CONFLICT');
          return result();
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
          const existing = this.stepMetadata(id, step.stepId);
          const progressReference = Object.hasOwn(p, 'evidenceDigest');
          if (progressReference) {
            // A heartbeat refers only to this exact durable checkpoint. It is
            // neither new work nor an alternative receipt supplied by a caller.
            requireUpgrade(
              command.kind === 'progress' &&
                !Object.hasOwn(p, 'evidence') &&
                Object.keys(p).every((key) =>
                  ['stepId', 'completedWork', 'totalWork', 'evidenceDigest', 'stage'].includes(key),
                ) &&
                row.stage === step.stepId &&
                p.completedWork === existing.completedWork &&
                (p.totalWork === undefined || p.totalWork === step.totalWork) &&
                (p.stage === undefined || p.stage === row.state) &&
                p.evidenceDigest ===
                  (existing.evidenceDigest ?? upgradeDigest(this.step(id, step.stepId).evidence)),
              'UPGRADE_PROGRESS_REFERENCE_INVALID',
              400,
            );
          }
          if (progressReference && this.fastMetadata && !existing.evidenceDigest)
            this.ledgerSqlite
              .prepare(
                'UPDATE upgrade_steps SET evidence_digest=? WHERE attempt_id=? AND step_id=?',
              )
              .run(p.evidenceDigest, id, step.stepId);
          requireUpgrade(
            typeof p.completedWork === 'number' &&
              Number.isFinite(p.completedWork) &&
              p.completedWork >= existing.completedWork &&
              (step.totalWork === null || p.completedWork <= step.totalWork),
            'UPGRADE_WORK_CONFLICT',
            400,
          );
          const timing = this.stageProgress(id);
          const facts = {
            stage: step.stepId,
            enteredAt: timing?.stage === step.stepId ? timing.enteredAt : this.iso(now),
            lastProgressAt:
              p.completedWork > existing.completedWork ||
              (command.kind === 'step-applied' && !existing.applied)
                ? this.iso(now)
                : timing?.stage === step.stepId
                  ? timing.lastProgressAt
                  : null,
          };
          this.ledgerSqlite
            .prepare(
              "INSERT INTO platform_operations(operation_id,instance_id,actor_id,role,fence,request_digest,state,result,created_at,updated_at) VALUES(?,?,?,'upgrade-stage-progress',?,?,'observed',?,?,?) ON CONFLICT(operation_id) DO UPDATE SET fence=excluded.fence,request_digest=excluded.request_digest,result=excluded.result,updated_at=excluded.updated_at",
            )
            .run(
              'upgrade-stage-progress:' + id,
              this.instanceId,
              row.actor_id,
              row.fence,
              upgradeDigest(facts),
              JSON.stringify(facts),
              now,
              now,
            );
          const index = plan.steps.indexOf(step);
          requireUpgrade(
            plan.steps.slice(0, index).every((s) => this.stepMetadata(id, s.stepId).applied),
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
            this.ledgerSqlite
              .prepare(
                `UPDATE upgrade_steps SET completed_work=?,applied=1,receipt_digest=?,evidence=?,${this.fastMetadata ? 'evidence_digest=?,' : ''}applied_at=? WHERE attempt_id=? AND step_id=?`,
              )
              .run(
                p.completedWork,
                p.receiptDigest,
                JSON.stringify(p.evidence ?? null),
                ...(this.fastMetadata ? [p.receiptDigest] : []),
                now,
                id,
                step.stepId,
              );
          } else if (!progressReference)
            this.ledgerSqlite
              .prepare(
                `UPDATE upgrade_steps SET completed_work=?,evidence=?${this.fastMetadata ? ',evidence_digest=?' : ''} WHERE attempt_id=? AND step_id=? AND applied=0`,
              )
              .run(
                p.completedWork,
                JSON.stringify(p.evidence ?? null),
                ...(this.fastMetadata ? [upgradeDigest(p.evidence ?? null)] : []),
                id,
                step.stepId,
              );
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
          if (!progressReference)
            this.ledgerSqlite
              .prepare('UPDATE upgrade_attempts SET state=?,stage=? WHERE attempt_id=?')
              .run(states[step.kind], step.stepId, id);
          if (
            !progressReference &&
            (step.kind === 'route' ||
              step.kind === 'web' ||
              (command.kind === 'step-applied' &&
                [
                  'coordinator-handoff',
                  'owner-candidate',
                  'installer-handoff',
                  'migration',
                ].includes(step.kind)))
          )
            this.ledgerSqlite
              .prepare(
                'UPDATE upgrade_instances SET service_state=?,ready=0,updated_at=? WHERE instance_id=?',
              )
              .run('transitioning', now, this.instanceId);
        } else if (command.kind === 'activation-confirmed') {
          requireUpgrade(
            confirmed && plan.steps.every((step) => this.stepMetadata(id, step.stepId).applied),
            'OVERALL_ACTIVATION_UNCONFIRMED',
          );
          confirmed = ConfirmedServiceReleaseSchema.parse(confirmed);
          requireUpgrade(
            confirmed.releaseId === row.target_release_id &&
              confirmed.activationGeneration > this.instance().activation_generation,
            'ACTIVATION_IDENTITY_CONFLICT',
          );
          this.ledgerSqlite
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
          this.ledgerSqlite
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
            this.ledgerSqlite
              .prepare('UPDATE upgrade_attempts SET state=?,stage=?,reason=? WHERE attempt_id=?')
              .run(command.kind === 'deferred' ? 'deferred' : 'failed', command.kind, reason, id);
          this.ledgerSqlite
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
          const high = requiredUpgradeValue(
            this.ledgerSqlite
              .prepare<unknown[], { fence: number }>(
                'SELECT coalesce(max(fence),0) AS fence FROM upgrade_attempts WHERE instance_id=?',
              )
              .get(this.instanceId),
          );
          const fixedRecovery = upgradeRecord(p.recoveryPlan),
            { planDigest: declaredDigest, ...planInput } = fixedRecovery;
          const recoveryDigest = upgradeDigest(planInput);
          requireUpgrade(
            declaredDigest === recoveryDigest && fixedRecovery.triggeringAttemptId === id,
            'RECOVERY_PLAN_DIGEST_CONFLICT',
          );
          const recoveryPlan = JSON.stringify(fixedRecovery);
          this.ledgerSqlite
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
          this.ledgerSqlite
            .prepare(
              'UPDATE upgrade_attempts SET generation=?,fence=?,lease_expires_at=? WHERE attempt_id=?',
            )
            .run(recoveryGeneration, high.fence + 1, now + 30_000, id);
          this.ledgerSqlite
            .prepare(
              'UPDATE upgrade_instances SET ready=0,service_state=?,updated_at=? WHERE instance_id=?',
            )
            .run('transitioning', now, this.instanceId);
        } else {
          const recovery = this.recovery();
          requireUpgrade(
            recovery?.triggeringAttemptId === id && recovery.state === 'recovering',
            'RECOVERY_NOT_ACTIVE',
          );
          if (command.kind === 'recovery-confirmed') {
            requireUpgrade(confirmed ?? restoredPartial, 'RECOVERY_UNCONFIRMED');
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
              this.ledgerSqlite
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
              this.ledgerSqlite
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
              this.ledgerSqlite
                .prepare('UPDATE upgrade_attempts SET state=?,stage=? WHERE attempt_id=?')
                .run('reverted', 'recovery-confirmed', id);
          }
          this.ledgerSqlite
            .prepare(
              'UPDATE upgrade_recoveries SET sequence=sequence+1,state=?,observed_at=? WHERE recovery_attempt_id=?',
            )
            .run(
              command.kind === 'recovery-confirmed' ? 'recovery-confirmed' : 'unknown',
              now,
              recovery.recoveryAttemptId,
            );
        }
        this.ledgerSqlite
          .prepare('UPDATE upgrade_attempts SET sequence=?,observed_at=? WHERE attempt_id=?')
          .run(next, now, id);
        this.ledgerSqlite
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
        return result();
      })
      .immediate();
  }
  recovery(): UpgradeRecovery | null {
    const independent = this.recoveryAuthority();
    if (independent) return recoveryView(independent.row);
    const row = this.ledgerSqlite
      .prepare<
        unknown[],
        {
          recovery_attempt_id: string;
          triggering_attempt_id: string;
          generation: number;
          sequence: number;
          state: UpgradeRecovery['state'];
          plan_digest: string;
          reason: string;
          observed_at: number;
        }
      >(
        'SELECT * FROM upgrade_recoveries WHERE instance_id=? ORDER BY generation DESC,rowid DESC LIMIT 1',
      )
      .get(this.instanceId);
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
  recoveryPlan(): Record<string, unknown> | null {
    const independent = this.recoveryAuthority();
    if (independent) return independent.plan;
    const recovery = this.recovery();
    if (!recovery) return null;
    const row = this.ledgerSqlite
      .prepare<unknown[], { plan: string }>(
        'SELECT plan FROM upgrade_recoveries WHERE recovery_attempt_id=?',
      )
      .get(recovery.recoveryAttemptId);
    return row ? upgradeRecord(JSON.parse(row.plan)) : null;
  }
  /** Available only inside the currently verified independent recovery ALS. */
  recoveryAuthorizationPlan(): Record<string, unknown> | null {
    return this.recoveryAuthority()?.authorization ?? null;
  }
  /** Only the independent ledger's executor may confirm a verified recovery.
   * The caller verifies real physical/continuity evidence; this transaction binds
   * that retrievable receipt to the intent and current instance atomically. */
  confirmIndependentRecovery(input: {
    recoveryId: string;
    epoch: number;
    expectedRecoverySequence: number;
    confirmedRelease?: ConfirmedServiceRelease;
    restoredPartial?: boolean;
    confirmation: Record<string, unknown> & {
      qualified: true;
      recoveryId: string;
      epoch: number;
      planDigest: string;
      observedAt: string;
      receiptDigest: string;
    };
  }): UpgradeRecovery {
    this.assertLedgerWritable();
    requireUpgrade(this.options.independent, 'INDEPENDENT_CONTROL_STORE_REQUIRED');
    const { receiptDigest, ...proof } = input.confirmation;
    requireUpgrade(
      z.literal(true).safeParse(input.confirmation.qualified).success &&
        input.confirmation.recoveryId === input.recoveryId &&
        input.confirmation.epoch === input.epoch &&
        Number.isFinite(Date.parse(input.confirmation.observedAt)) &&
        Date.parse(input.confirmation.observedAt) <= this.now() &&
        upgradeDigest(proof) === receiptDigest &&
        Buffer.byteLength(canonicalUpgrade(input.confirmation)) <= 256 * 1024 &&
        (input.confirmedRelease !== undefined) !== (input.restoredPartial === true),
      'CONTROL_RECOVERY_CONFIRMATION_REQUIRED',
    );
    return this.ledgerSqlite
      .transaction(() => {
        const confirmedAt = this.now();
        const row = this.ledgerSqlite
          .prepare<unknown[], { triggering_attempt_id: string }>(
            'SELECT triggering_attempt_id FROM control_recovery_intents WHERE recovery_id=? AND instance_id=?',
          )
          .get(input.recoveryId, this.instanceId);
        requireUpgrade(row, 'CONTROL_RECOVERY_INTENT_REQUIRED');
        const active = readRecoveryAuthority(
          this.ledgerSqlite,
          this.instanceId,
          this.clock,
          input.recoveryId,
          input.epoch,
          row.triggering_attempt_id,
        );
        requireUpgrade(
          active.row.phase === 'verifying' &&
            active.row.sequence === input.expectedRecoverySequence &&
            active.plan !== null &&
            active.row.plan_digest === input.confirmation.planDigest,
          'CONTROL_RECOVERY_TRANSITION_CONFLICT',
        );
        const instance = this.instance();
        let confirmed = instance.confirmed_release,
          activation = instance.activation_generation;
        if (input.confirmedRelease) {
          const release = ConfirmedServiceReleaseSchema.parse(input.confirmedRelease);
          requireUpgrade(
            release.activationGeneration === activation + 1,
            'INVALID_ACTIVATION_GENERATION',
          );
          confirmed = canonicalUpgrade(release);
          activation = release.activationGeneration;
        }
        this.ledgerSqlite.exec(
          'CREATE TABLE IF NOT EXISTS control_recovery_confirmations(recovery_id TEXT PRIMARY KEY,instance_id TEXT NOT NULL,epoch INTEGER NOT NULL,recovery_sequence INTEGER NOT NULL,receipt_digest TEXT NOT NULL,receipt TEXT NOT NULL,confirmed_at INTEGER NOT NULL)',
        );
        this.ledgerSqlite
          .prepare('INSERT INTO control_recovery_confirmations VALUES(?,?,?,?,?,?,?)')
          .run(
            input.recoveryId,
            this.instanceId,
            input.epoch,
            input.expectedRecoverySequence + 1,
            receiptDigest,
            canonicalUpgrade(input.confirmation),
            confirmedAt,
          );
        this.ledgerSqlite
          .prepare(
            "UPDATE upgrade_instances SET activation_generation=?,confirmed_release=?,service_state='recovery-confirmed',ready=1,updated_at=? WHERE instance_id=?",
          )
          .run(activation, confirmed, confirmedAt, this.instanceId);
        this.ledgerSqlite
          .prepare(
            "UPDATE control_recovery_intents SET phase='recovered',sequence=sequence+1,confirmed_at=?,updated_at=? WHERE recovery_id=? AND instance_id=? AND epoch=? AND sequence=? AND phase='verifying'",
          )
          .run(
            confirmedAt,
            confirmedAt,
            input.recoveryId,
            this.instanceId,
            input.epoch,
            input.expectedRecoverySequence,
          );
        return recoveryView({
          ...active.row,
          phase: 'recovered',
          sequence: active.row.sequence + 1,
          confirmed_at: confirmedAt,
          updated_at: confirmedAt,
        });
      })
      .immediate();
  }
  /** A new recovery authority can revoke a still-active legacy attempt even
   * after its own lease expired. This is a separately journaled revocation,
   * never an invented command signed with the old attempt's fence. */
  freezeAttemptForRecovery(input: {
    recoveryId: string;
    epoch: number;
    reason: string;
    diagnosticId?: string;
  }): Record<string, unknown> {
    this.assertLedgerWritable();
    requireUpgrade(
      this.options.independent &&
        input.reason.length > 0 &&
        input.reason.length <= 200 &&
        (input.diagnosticId === undefined || input.diagnosticId.length <= 128),
      'CONTROL_RECOVERY_FAULT_INVALID',
    );
    return this.ledgerSqlite
      .transaction(() => {
        const intent = this.ledgerSqlite
          .prepare<unknown[], { triggering_attempt_id: string }>(
            'SELECT triggering_attempt_id FROM control_recovery_intents WHERE recovery_id=? AND instance_id=?',
          )
          .get(input.recoveryId, this.instanceId);
        requireUpgrade(intent, 'CONTROL_RECOVERY_INTENT_REQUIRED');
        readRecoveryAuthority(
          this.ledgerSqlite,
          this.instanceId,
          this.clock,
          input.recoveryId,
          input.epoch,
          intent.triggering_attempt_id,
        );
        this.ledgerSqlite.exec(
          'CREATE TABLE IF NOT EXISTS control_recovery_faults(recovery_id TEXT NOT NULL,epoch INTEGER NOT NULL,instance_id TEXT NOT NULL,attempt_id TEXT NOT NULL,receipt_digest TEXT NOT NULL,receipt TEXT NOT NULL,recorded_at INTEGER NOT NULL,PRIMARY KEY(recovery_id,epoch))',
        );
        const previous = this.ledgerSqlite
          .prepare<unknown[], { receipt: string }>(
            'SELECT receipt FROM control_recovery_faults WHERE recovery_id=? AND epoch=? AND instance_id=?',
          )
          .get(input.recoveryId, input.epoch, this.instanceId);
        if (previous) {
          const receipt = upgradeRecord(JSON.parse(previous.receipt));
          requireUpgrade(
            receipt.reason === input.reason &&
              receipt.diagnosticId === (input.diagnosticId ?? null),
            'CONTROL_RECOVERY_FAULT_CONFLICT',
          );
          return receipt;
        }
        const before = this.row(intent.triggering_attempt_id);
        const active = [
          'accepted',
          'downloading',
          'package-verified',
          'migrating',
          'prepared',
          'candidate-ready',
          'routing-switched',
          'observing',
          'api-activated',
        ].includes(before.state);
        if (active)
          this.ledgerSqlite
            .prepare(
              "UPDATE upgrade_attempts SET state='failed',stage='recovery-authority-revoked',reason=?,sequence=sequence+1,controller_id=NULL,lease_expires_at=0,observed_at=? WHERE attempt_id=? AND instance_id=?",
            )
            .run(input.reason, this.now(), before.attempt_id, this.instanceId);
        this.ledgerSqlite
          .prepare('UPDATE upgrade_instances SET ready=0,updated_at=? WHERE instance_id=?')
          .run(this.now(), this.instanceId);
        const proof = {
          instanceId: this.instanceId,
          recoveryId: input.recoveryId,
          epoch: input.epoch,
          attemptId: before.attempt_id,
          reason: input.reason,
          diagnosticId: input.diagnosticId ?? null,
          recordedAt: this.iso(this.now()),
          revokedActiveAttempt: active,
          before: {
            state: before.state,
            stage: before.stage,
            generation: before.generation,
            sequence: before.sequence,
            fence: before.fence,
            controllerId: before.controller_id,
            leaseExpiresAt: before.lease_expires_at,
            rowDigest: upgradeDigest(before),
          },
        };
        const receipt = { ...proof, receiptDigest: upgradeDigest(proof) };
        this.ledgerSqlite
          .prepare('INSERT INTO control_recovery_faults VALUES(?,?,?,?,?,?,?)')
          .run(
            input.recoveryId,
            input.epoch,
            this.instanceId,
            before.attempt_id,
            receipt.receiptDigest,
            canonicalUpgrade(receipt),
            this.now(),
          );
        return receipt;
      })
      .immediate();
  }
}
