import { z } from 'zod';
import { UpgradePlanSchema } from '@platform/contracts';
import {} from './upgrade-values';
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, ID_GENERATOR, type Clock, type IdGenerator } from '@platform/shared-kernel';
import {
  SignedUpgradeManifestSchema,
  UpgradeOperationSchema,
  UpgradeRequestSchema,
  type UpgradeOperation,
  type UpgradeRequest,
} from '@platform/contracts';
import { UpgradeStore } from './upgrade-store';
import { requireUpgrade, upgradeDigest } from './upgrade-trust';
import type { FixedUpgradeStage } from './upgrade-chain';
import { contractActive } from './upgrade-contract-authority';

export const UPGRADE_PLAN_ROLE = 'upgrade-plan';
const ACTIVE = ['accepted', 'preparing', 'running'];
export interface DefaultImageSnapshot {
  provider: string;
  managed: boolean;
  ref: string;
  digest: string;
  runtimeVersions: Record<string, string>;
}
export interface UpgradeOperationRecord {
  operation: UpgradeOperation;
  actorId: string;
  command: UpgradeRequest;
  chain: (FixedUpgradeStage & { requestId: string })[];
  chainDigest: string;
  defaultImagesBefore: DefaultImageSnapshot[];
}

const OperationRecordSchema = z.object({
  operation: UpgradeOperationSchema,
  actorId: z.string(),
  command: UpgradeRequestSchema,
  chain: z.array(
    z.object({
      envelope: SignedUpgradeManifestSchema,
      plan: UpgradePlanSchema,
      requestId: z.string(),
    }),
  ),
  chainDigest: z.string(),
  defaultImagesBefore: z.array(
    z.object({
      provider: z.string(),
      managed: z.boolean(),
      ref: z.string(),
      digest: z.string(),
      runtimeVersions: z.record(z.string()),
    }),
  ),
});
function assertOperationRecord(value: unknown): asserts value is UpgradeOperationRecord {
  // Validate without replacing signed envelopes or the bytes used by chainDigest.
  OperationRecordSchema.parse(value);
}

/** Reuses the existing intent ledger. No invented Drizzle migration or second executor. */
@Injectable()
export class UpgradeOperationStore {
  constructor(
    readonly upgrades: UpgradeStore,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
  ) {}
  private get sqlite() {
    return this.upgrades.sqlite;
  }
  read(id: string): UpgradeOperationRecord {
    const row = this.sqlite
      .prepare<unknown[], { result: string; actor_id: string; request_digest: string }>(
        'SELECT result,actor_id,request_digest FROM platform_operations WHERE operation_id=? AND instance_id=? AND role=?',
      )
      .get(id, this.upgrades.instanceId, UPGRADE_PLAN_ROLE);
    requireUpgrade(row, 'UPGRADE_OPERATION_NOT_FOUND', 404);
    const record: unknown = JSON.parse(row.result);
    assertOperationRecord(record);
    record.operation = UpgradeOperationSchema.parse(record.operation);
    record.command = UpgradeRequestSchema.parse(record.command);
    requireUpgrade(
      record.operation.operationId === id &&
        record.operation.instanceId === this.upgrades.instanceId &&
        record.actorId === row.actor_id &&
        record.operation.requestId === record.command.requestId &&
        row.request_digest === upgradeDigest(record.command) &&
        record.chainDigest === upgradeDigest(record.chain) &&
        record.chain.length === record.operation.stages.length &&
        record.chain.length <= 16,
      'UPGRADE_OPERATION_CORRUPT',
    );
    record.chain.forEach((stage, index) => {
      SignedUpgradeManifestSchema.parse(stage.envelope);
      requireUpgrade(
        stage.envelope.manifest.releaseId === record.operation.stages[index].releaseId &&
          stage.envelope.manifestDigest === record.operation.stages[index].targetDigest,
        'UPGRADE_OPERATION_CORRUPT',
      );
    });
    const final = record.chain[record.chain.length - 1].envelope;
    requireUpgrade(
      final.manifest.releaseId === record.operation.finalTargetReleaseId &&
        final.manifestDigest === record.operation.finalTargetDigest &&
        record.operation.finalTargetDigest === record.command.targetDigest &&
        record.operation.finalTargetReleaseId === record.command.targetReleaseId,
      'UPGRADE_OPERATION_CORRUPT',
    );
    return record;
  }
  latest(): UpgradeOperationRecord | null {
    const row = this.sqlite
      .prepare<unknown[], { operation_id: string }>(
        'SELECT operation_id FROM platform_operations WHERE instance_id=? AND role=? ORDER BY created_at DESC,rowid DESC LIMIT 1',
      )
      .get(this.upgrades.instanceId, UPGRADE_PLAN_ROLE);
    return row ? this.read(row.operation_id) : null;
  }
  find(actor: string, requestId: string): UpgradeOperationRecord | null {
    const row = this.sqlite
      .prepare<unknown[], { operation_id: string }>(
        "SELECT operation_id FROM platform_operations WHERE instance_id=? AND role=? AND actor_id=? AND json_extract(result,'$.command.requestId')=?",
      )
      .get(this.upgrades.instanceId, UPGRADE_PLAN_ROLE, actor, requestId);
    return row ? this.read(row.operation_id) : null;
  }
  replay(actor: string, command: UpgradeRequest): UpgradeOperationRecord | null {
    const original = this.find(actor, command.requestId);
    if (original)
      requireUpgrade(
        upgradeDigest(original.command) === upgradeDigest(command),
        'UPGRADE_REQUEST_PAYLOAD_CONFLICT',
      );
    return original;
  }
  accept(
    actorId: string,
    command: UpgradeRequest,
    chain: FixedUpgradeStage[],
    defaults: DefaultImageSnapshot[],
  ): UpgradeOperationRecord {
    return this.sqlite
      .transaction(() => {
        const replay = this.replay(actorId, command);
        if (replay) return replay;
        const instance = this.upgrades.instance();
        requireUpgrade(
          instance.activation_generation === command.expectedActivationGeneration,
          'UPGRADE_ACTIVATION_CONFLICT',
        );
        requireUpgrade(
          !contractActive(this.sqlite, this.upgrades.instanceId),
          'INSTANCE_CONTRACT_ACTIVE',
        );
        requireUpgrade(
          !this.sqlite
            .prepare(
              "SELECT 1 FROM platform_operations WHERE instance_id=? AND role=? AND state IN ('accepted','preparing','running')",
            )
            .get(this.upgrades.instanceId, UPGRADE_PLAN_ROLE),
          'UPGRADE_ALREADY_ACTIVE',
        );
        requireUpgrade(
          this.upgrades.pending().attempts.length === 0 &&
            this.upgrades.recovery()?.state !== 'recovering',
          'UPGRADE_ALREADY_ACTIVE',
        );
        requireUpgrade(
          chain.length > 0 &&
            chain.length <= 16 &&
            chain[0].plan.sourceActivationGeneration === instance.activation_generation,
          'UPGRADE_ACTIVATION_CONFLICT',
        );
        const final = chain[chain.length - 1].envelope;
        requireUpgrade(
          final.manifest.releaseId === command.targetReleaseId &&
            final.manifestDigest === command.targetDigest,
          'UPGRADE_TARGET_CHANGED',
        );
        const now = this.clock.now(),
          operationId = this.ids.next();
        const frozen = chain.map((stage) => ({ ...stage, requestId: this.ids.next() }));
        const operation = UpgradeOperationSchema.parse({
          instanceId: this.upgrades.instanceId,
          operationId,
          requestId: command.requestId,
          finalTargetReleaseId: command.targetReleaseId,
          finalTargetDigest: command.targetDigest,
          sequence: 0,
          state: 'accepted',
          acceptedAt: now.toISOString(),
          observedAt: now.toISOString(),
          currentStageIndex: 0,
          stages: frozen.map((stage) => ({
            releaseId: stage.envelope.manifest.releaseId,
            targetDigest: stage.envelope.manifestDigest,
            attemptId: null,
            state: 'pending',
          })),
          percent: null,
          reason: null,
          defaultImageUpdate: null,
        });
        const record: UpgradeOperationRecord = {
          operation,
          actorId,
          command,
          chain: frozen,
          chainDigest: upgradeDigest(frozen),
          defaultImagesBefore: defaults,
        };
        this.sqlite
          .prepare(
            'INSERT INTO platform_operations(operation_id,instance_id,actor_id,role,fence,request_digest,state,result,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
          )
          .run(
            operationId,
            this.upgrades.instanceId,
            actorId,
            UPGRADE_PLAN_ROLE,
            0,
            upgradeDigest(command),
            operation.state,
            JSON.stringify(record),
            now.getTime(),
            now.getTime(),
          );
        return record;
      })
      .immediate();
  }
  update(id: string, change: (record: UpgradeOperationRecord) => void): UpgradeOperationRecord {
    return this.sqlite
      .transaction(() => {
        const record = this.read(id),
          fixed = record.chainDigest;
        change(record);
        requireUpgrade(
          fixed === record.chainDigest && fixed === upgradeDigest(record.chain),
          'UPGRADE_OPERATION_PLAN_CHANGED',
        );
        record.operation = UpgradeOperationSchema.parse(record.operation);
        record.operation.sequence += 1;
        record.operation.observedAt = this.clock.now().toISOString();
        this.sqlite
          .prepare(
            'UPDATE platform_operations SET state=?,result=?,updated_at=? WHERE operation_id=? AND instance_id=? AND role=?',
          )
          .run(
            record.operation.state,
            JSON.stringify(record),
            this.clock.now().getTime(),
            id,
            this.upgrades.instanceId,
            UPGRADE_PLAN_ROLE,
          );
        return record;
      })
      .immediate();
  }
  active(): UpgradeOperationRecord | null {
    const record = this.latest();
    return record && ACTIVE.includes(record.operation.state) ? record : null;
  }
}
