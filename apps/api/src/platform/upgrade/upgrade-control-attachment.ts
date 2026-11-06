import { Inject, Injectable, Optional } from '@nestjs/common';
import { z } from 'zod';
import type Database from 'better-sqlite3';
import { CLOCK, type Clock } from '@platform/shared-kernel';
import { PLATFORM_SQLITE } from '../persistence/platform-sqlite.token';
import { coordinatorWriterControl } from '../persistence/coordinator-lease';
import { UpgradeStore } from './upgrade-store';
import { UpgradeLedgerConnection } from './upgrade-ledger-connection';
import { UpgradeService } from './upgrade-service';
import { UpgradeProjection } from './upgrade-projection';
import { UpgradeContractService } from './upgrade-contract-service';
import { CoordinatorRecovery } from './coordinator-recovery';
import {
  requireUpgrade,
  canonicalUpgrade,
  upgradeDigest,
  readUpgradeTrustRoot,
  verifyUpgradeEnvelope,
} from './upgrade-trust';

const Digest = z.string().regex(/^sha256:[a-f0-9]{64}$/),
  Id = z.string().uuid();
const Source = z
  .object({
    activationGeneration: z.number().int().positive(),
    confirmedDigest: Digest,
    businessWriterGeneration: z.number().int().positive(),
    businessWriterFence: z.number().int().positive(),
    schema: z.number().int().nonnegative(),
  })
  .strict();
const Target = z
  .object({
    signedManifestDigest: Digest,
    apiArtifactDigest: Digest,
    coordinatorArtifactDigest: Digest,
    projectRevision: z.string().regex(/^[a-f0-9]{40}$/),
    controlPackageDigest: Digest,
  })
  .strict();
export const ControlAdmissionFreezePlanSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal('legacy-control-admission-freeze'),
    instanceId: z.string().min(1).max(64),
    operationId: Id,
    commandId: z.string().min(1).max(200),
    deadline: z.number().int().positive(),
    source: Source,
    target: Target,
  })
  .strict();
export const ControlLedgerAttachSpecSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal('legacy-control-ledger-attach'),
    instanceId: z.string().min(1).max(64),
    operationId: Id,
    commandId: z.string().min(1).max(200),
    epoch: z.number().int().positive(),
    executorId: z.string().min(1).max(200),
    deadline: z.number().int().positive(),
    freezeReceiptDigest: Digest,
    source: Source,
    target: Target,
    controlDatabase: z
      .object({
        path: z.string().min(1),
        dev: z.string().regex(/^\d+$/),
        ino: z.string().regex(/^\d+$/),
      })
      .strict(),
    settlement: z.object({ operationId: Id, commandId: z.string().min(1).max(200) }).strict(),
  })
  .strict();
export const ControlAttachRequestSchema = z
  .object({ operationId: Id, commandId: z.string().min(1).max(200), specDigest: Digest })
  .strict();
export const ControlAttachCommitRequestSchema = ControlAttachRequestSchema.extend({
  settlementResultDigest: Digest,
}).strict();
type FreezePlan = z.infer<typeof ControlAdmissionFreezePlanSchema>;
type AttachSpec = z.infer<typeof ControlLedgerAttachSpecSchema>;

/** No executable, arbitrary path, source-writer handoff or Guest operation. The
 * new Control remains passive; only its actual reserved fixed command may attach. */
@Injectable()
export class UpgradeControlAttachment {
  private attaching: Promise<Record<string, unknown>> | null = null;
  private attachingInput: string | null = null;
  constructor(
    readonly store: UpgradeStore,
    private readonly connection: UpgradeLedgerConnection,
    @Inject(PLATFORM_SQLITE) private readonly business: Database.Database,
    @Inject(CLOCK) private readonly clock: Clock,
    @Optional() private readonly upgrades?: UpgradeService,
    @Optional() private readonly projection?: UpgradeProjection,
    @Optional() private readonly contracts?: UpgradeContractService,
    @Optional() private readonly recovery?: CoordinatorRecovery,
  ) {}
  status(): Record<string, unknown> {
    return {
      ...this.connection.legacyWorkSnapshot(),
      readonly: this.store.ledgerReadonly,
      freeze: this.connection.frozenReceipt(),
      attachment: this.connection.attachmentStatus(),
      businessWriter: this.writerIdentity(),
    };
  }
  private writerIdentity() {
    const writer = coordinatorWriterControl(this.business);
    writer.assert();
    return { generation: writer.generation, fence: writer.fence };
  }
  private assertSource(spec: FreezePlan | AttachSpec): void {
    const confirmed = this.store.confirmed(),
      instance = this.store.instance(),
      writer = this.writerIdentity();
    const schema = this.business
      .prepare<unknown[], { n: number }>('SELECT count(*) n FROM __drizzle_migrations')
      .get()?.n;
    requireUpgrade(
      spec.instanceId === this.store.instanceId &&
        spec.deadline > this.clock.now().getTime() &&
        confirmed &&
        instance.ready === 1 &&
        instance.service_state === 'confirmed' &&
        instance.activation_generation === spec.source.activationGeneration &&
        upgradeDigest(confirmed) === spec.source.confirmedDigest &&
        writer.generation === spec.source.businessWriterGeneration &&
        writer.fence === spec.source.businessWriterFence &&
        schema === spec.source.schema &&
        confirmed.components.api.artifactDigest === spec.target.apiArtifactDigest &&
        confirmed.components.coordinator?.artifactDigest ===
          spec.target.coordinatorArtifactDigest &&
        confirmed.commits.project === spec.target.projectRevision,
      'CONTROL_ATTACHMENT_SOURCE_CHANGED',
    );
  }
  private async verifyTarget(spec: FreezePlan | AttachSpec, envelope: unknown): Promise<void> {
    const rootPath = process.env.UPGRADE_TRUST_ROOT_PATH;
    requireUpgrade(rootPath, 'TRUST_ROOT_MISSING');
    const trusted = verifyUpgradeEnvelope(
      envelope,
      await readUpgradeTrustRoot(rootPath),
      this.clock.now().getTime(),
    );
    const m = trusted.manifest;
    requireUpgrade(
      trusted.manifestDigest === spec.target.signedManifestDigest &&
        m.components.api.artifactDigest === spec.target.apiArtifactDigest &&
        m.components.coordinator.artifactDigest === spec.target.coordinatorArtifactDigest &&
        m.commits.project === spec.target.projectRevision &&
        m.controlPackage?.manifestDigest === spec.target.controlPackageDigest,
      'CONTROL_ATTACHMENT_TARGET_CHANGED',
    );
  }
  async freeze(raw: unknown): Promise<Record<string, unknown>> {
    const input = ControlAttachRequestSchema.parse(raw),
      configured = this.connection.readConfiguredFreeze();
    const plan = ControlAdmissionFreezePlanSchema.parse(configured.spec);
    requireUpgrade(
      input.operationId === plan.operationId &&
        input.commandId === plan.commandId &&
        input.specDigest === upgradeDigest(configured.spec),
      'CONTROL_ATTACHMENT_INTENT_CONFLICT',
    );
    requireUpgrade(!this.store.ledgerReadonly, 'CONTROL_ALREADY_ATTACHED');
    this.assertSource(plan);
    await this.verifyTarget(plan, configured.signedManifest);
    this.assertSource(plan);
    this.assertOriginalLegacySettled();
    const writer = this.writerIdentity();
    const receipt = this.connection.freeze(
      {
        schemaVersion: 1,
        kind: 'legacy-control-admission-frozen',
        instanceId: plan.instanceId,
        operationId: plan.operationId,
        commandId: plan.commandId,
        specDigest: input.specDigest,
        sourceConfirmedDigest: plan.source.confirmedDigest,
        admissionRevision: 1,
        legacyLedgerEpoch: this.connection.legacyWorkSnapshot().epoch,
        frozenAt: this.clock.now().getTime(),
        businessWriterGeneration: writer.generation,
        businessWriterFence: writer.fence,
      },
      configured,
    );
    // These existing hooks cancel only legacy schedules; they do not close the
    // shared worker or business runtime. Original Promises remain epoch-owned.
    this.upgrades?.onModuleDestroy();
    this.projection?.onModuleDestroy();
    this.contracts?.onModuleDestroy();
    this.recovery?.onModuleDestroy();
    await this.connection.awaitLegacySettled(plan.deadline);
    this.assertSource(plan);
    return {
      ...receipt,
      localLegacyWorkSettled: true,
      authorizesEntryMutation: false,
      controlActivated: false,
    };
  }
  private assertOriginalLegacySettled(): void {
    const unsettled = [
      "SELECT 1 FROM upgrade_attempts WHERE instance_id=? AND state NOT IN ('activation-confirmed','failed','deferred','candidate-rejected','reverted') LIMIT 1",
      "SELECT 1 FROM upgrade_recoveries WHERE instance_id=? AND state NOT IN ('recovered','failed','reverted','deferred','activation-confirmed') LIMIT 1",
      "SELECT 1 FROM platform_operations WHERE instance_id=? AND role IN ('upgrade-plan','project-name-contract') AND state NOT IN ('completed','failed','reverted','deferred') LIMIT 1",
    ];
    for (const sql of unsettled)
      requireUpgrade(
        !this.business.prepare(sql).get(this.store.instanceId),
        'LEGACY_CONTROL_ORIGINAL_INTENT_UNSETTLED',
      );
    for (const table of ['coordinator_handoffs', 'upgrade_role_handoffs', 'coordinator_recoveries'])
      requireUpgrade(
        !this.business
          .prepare(`SELECT 1 FROM ${table} WHERE stage IN ('releasing','adopting') LIMIT 1`)
          .get(),
        'LEGACY_CONTROL_ORIGINAL_INTENT_UNSETTLED',
      );
  }
  private assertReservation(
    candidate: Database.Database,
    spec: AttachSpec,
    specDigest: string,
  ): void {
    const authority = candidate
      .prepare<
        unknown[],
        {
          mode: string;
          kind: string;
          operation_id: string;
          holder_id: string;
          epoch: number;
          lease_expires_at: number;
        }
      >('SELECT * FROM control_authority WHERE instance_id=?')
      .get(spec.instanceId);
    requireUpgrade(
      authority?.mode === 'passive' &&
        authority.kind === 'maintenance' &&
        authority.operation_id === spec.operationId &&
        authority.holder_id === spec.executorId &&
        authority.epoch === spec.epoch &&
        authority.lease_expires_at === spec.deadline &&
        authority.lease_expires_at > this.clock.now().getTime(),
      'CONTROL_ADOPTION_PASSIVE_RESERVATION_REQUIRED',
    );
    const reservation = candidate
      .prepare<
        unknown[],
        {
          spec: string;
          spec_digest: string;
          state: string;
          epoch: number;
          executor_id: string;
          deadline: number;
        }
      >('SELECT * FROM control_adoption_reservations WHERE instance_id=? AND operation_id=?')
      .get(spec.instanceId, spec.operationId);
    requireUpgrade(
      reservation?.state === 'reserved' &&
        reservation.spec_digest === specDigest &&
        reservation.epoch === spec.epoch &&
        reservation.executor_id === spec.executorId &&
        reservation.deadline === spec.deadline &&
        canonicalUpgrade(JSON.parse(reservation.spec)) === canonicalUpgrade(spec),
      'CONTROL_ADOPTION_RESERVATION_SCOPE_CHANGED',
    );
    const command = candidate
      .prepare<
        unknown[],
        { state: string; spec: string; spec_digest: string; epoch: number; executor_id: string }
      >('SELECT * FROM control_commands WHERE instance_id=? AND operation_id=? AND command_id=?')
      .get(spec.instanceId, spec.operationId, spec.commandId);
    requireUpgrade(
      command?.state === 'executing' &&
        command.spec_digest === specDigest &&
        command.epoch === spec.epoch &&
        command.executor_id === spec.executorId &&
        canonicalUpgrade(JSON.parse(command.spec)) === canonicalUpgrade(spec),
      'CONTROL_ATTACHMENT_COMMAND_NOT_EXECUTING',
    );
  }
  private assertSettlement(
    candidate: Database.Database,
    spec: AttachSpec,
    resultDigest: string,
  ): void {
    const row = candidate
      .prepare<
        unknown[],
        {
          state: string;
          result: string;
          result_digest: string;
          spec: string;
          spec_digest: string;
          epoch: number;
          executor_id: string;
        }
      >('SELECT * FROM control_commands WHERE instance_id=? AND operation_id=? AND command_id=?')
      .get(spec.instanceId, spec.settlement.operationId, spec.settlement.commandId);
    requireUpgrade(
      row?.state === 'applied' &&
        row.epoch === spec.epoch &&
        row.executor_id === spec.executorId &&
        row.result_digest === resultDigest &&
        upgradeDigest(JSON.parse(row.result)) === resultDigest &&
        upgradeDigest(JSON.parse(row.spec)) === row.spec_digest,
      'LEGACY_CONTROL_SETTLEMENT_RECEIPT_REQUIRED',
    );
    requireUpgrade(
      canonicalUpgrade(JSON.parse(row.spec)) ===
        canonicalUpgrade({
          schemaVersion: 1,
          kind: 'legacy-control-settlement',
          instanceId: spec.instanceId,
          operationId: spec.operationId,
          commandId: spec.settlement.commandId,
          attachSpecDigest: upgradeDigest(spec),
          freezeReceiptDigest: spec.freezeReceiptDigest,
          deadline: spec.deadline,
        }),
      'LEGACY_CONTROL_SETTLEMENT_COMMAND_CHANGED',
    );
    const proof = z
      .object({
        schemaVersion: z.literal(1),
        kind: z.literal('legacy-control-settlement'),
        instanceId: z.string(),
        operationId: Id,
        freezeReceiptDigest: Digest,
        sourceConfirmedDigest: Digest,
        localAdmissionClosed: z.literal(true),
        legacyCallersClosed: z.literal(true),
        originalDispatchesSettled: z.literal(true),
        qualified: z.literal(true),
        observedAt: z.number().int(),
        receiptDigest: Digest,
      })
      .strict()
      .parse(JSON.parse(row.result));
    const { receiptDigest, ...facts } = proof;
    requireUpgrade(
      receiptDigest === upgradeDigest(facts) &&
        proof.instanceId === spec.instanceId &&
        proof.operationId === spec.operationId &&
        proof.freezeReceiptDigest === spec.freezeReceiptDigest &&
        proof.sourceConfirmedDigest === spec.source.confirmedDigest &&
        proof.observedAt >= (this.connection.frozenReceipt()?.frozenAt ?? Infinity) &&
        proof.observedAt <= this.clock.now().getTime(),
      'LEGACY_CONTROL_SETTLEMENT_SCOPE_CHANGED',
    );
  }
  attach(raw: unknown): Promise<Record<string, unknown>> {
    const input = ControlAttachCommitRequestSchema.parse(raw),
      fingerprint = upgradeDigest(input);
    if (this.attaching) {
      requireUpgrade(this.attachingInput === fingerprint, 'CONTROL_ATTACHMENT_IN_FLIGHT_CONFLICT');
      return this.attaching;
    }
    const prior = this.connection.attachedReceipt(input.specDigest);
    if (prior) {
      requireUpgrade(
        prior.operationId === input.operationId &&
          prior.commandId === input.commandId &&
          prior.settlementResultDigest === input.settlementResultDigest,
        'CONTROL_ATTACHMENT_INTENT_CONFLICT',
      );
      return Promise.resolve(prior);
    }
    this.attachingInput = fingerprint;
    this.attaching = this.commit(input).finally(() => {
      this.attaching = null;
      this.attachingInput = null;
    });
    return this.attaching;
  }
  private async commit(raw: unknown): Promise<Record<string, unknown>> {
    const input = ControlAttachCommitRequestSchema.parse(raw),
      configured = this.connection.readConfiguredIntent();
    const spec = ControlLedgerAttachSpecSchema.parse(configured.spec),
      specDigest = upgradeDigest(configured.spec),
      frozen = this.connection.frozenReceipt();
    requireUpgrade(
      input.operationId === spec.operationId &&
        input.commandId === spec.commandId &&
        input.specDigest === specDigest &&
        frozen?.operationId === spec.operationId &&
        frozen.receiptDigest === spec.freezeReceiptDigest,
      'CONTROL_ATTACHMENT_INTENT_CONFLICT',
    );
    const originalFreeze = ControlAdmissionFreezePlanSchema.parse(
      this.connection.frozenConfiguration()?.spec,
    );
    requireUpgrade(
      upgradeDigest(originalFreeze) === frozen.specDigest &&
        spec.deadline <= originalFreeze.deadline &&
        canonicalUpgrade(originalFreeze.source) === canonicalUpgrade(spec.source) &&
        canonicalUpgrade(originalFreeze.target) === canonicalUpgrade(spec.target),
      'CONTROL_ATTACHMENT_FROZEN_PLAN_CHANGED',
    );
    this.assertSource(spec);
    await this.verifyTarget(spec, configured.signedManifest);
    const candidate = this.connection.openReadonly(
      spec.controlDatabase.path,
      spec.instanceId,
      spec.controlDatabase,
    );
    let attached = false;
    try {
      this.assertReservation(candidate, spec, specDigest);
      this.assertSettlement(candidate, spec, input.settlementResultDigest);
      await this.connection.awaitLegacySettled(spec.deadline);
      this.assertSource(spec);
      this.assertOriginalLegacySettled();
      this.assertReservation(candidate, spec, specDigest);
      this.assertSettlement(candidate, spec, input.settlementResultDigest);
      const exported = candidate
        .prepare<
          unknown[],
          {
            activation_generation: number;
            confirmed_release: string;
            ready: number;
            service_state: string;
          }
        >('SELECT * FROM upgrade_instances WHERE instance_id=?')
        .get(spec.instanceId);
      requireUpgrade(
        exported?.activation_generation === spec.source.activationGeneration &&
          exported.ready === 1 &&
          exported.service_state === 'confirmed' &&
          upgradeDigest(JSON.parse(exported.confirmed_release)) === spec.source.confirmedDigest,
        'CONTROL_ATTACHMENT_EXPORTED_SOURCE_CHANGED',
      );
      this.connection.assertFileIdentity(spec.controlDatabase.path, spec.controlDatabase);
      const result = {
        schemaVersion: 1,
        kind: 'legacy-control-ledger-attached',
        instanceId: spec.instanceId,
        operationId: spec.operationId,
        commandId: spec.commandId,
        specDigest,
        freezeReceiptDigest: frozen.receiptDigest,
        settlementResultDigest: input.settlementResultDigest,
        readonly: true,
        businessWriter: this.writerIdentity(),
        controlActivated: false,
        authorizesEntryMutation: false,
      };
      this.connection.attach(candidate, frozen.specDigest, configured, result);
      attached = true;
      return result;
    } finally {
      if (!attached) candidate.close();
    }
  }
}
