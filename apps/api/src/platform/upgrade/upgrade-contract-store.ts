import { z } from 'zod';
import { SignedUpgradeManifestSchema } from '@platform/contracts';
import { requiredUpgradeValue } from './upgrade-values';
import { Injectable, Inject } from '@nestjs/common';
import type Database from 'better-sqlite3';
import {
  CLOCK,
  ID_GENERATOR,
  fromEpochMs,
  type Clock,
  type IdGenerator,
} from '@platform/shared-kernel';
import {
  UpgradeContractAttemptSchema,
  UpgradeContractPlanSchema,
  UpgradeContractRequestSchema,
  type UpgradeContractAttempt,
  type UpgradeContractPlan,
  type UpgradeContractRequest,
  type SignedUpgradeManifest,
} from '@platform/contracts';
import { UpgradeStore } from './upgrade-store';
import { CONTRACT_ROLE, contractFenceFloor, contractActive } from './upgrade-contract-authority';
import { canonicalUpgrade, requireUpgrade, upgradeDigest } from './upgrade-trust';

const ACTIVE = ['accepted', 'retiring-readers', 'authority-active', 'clearing'];
export interface ContractRecord {
  attempt: UpgradeContractAttempt;
  fence: number;
  actorId: string;
  command: UpgradeContractRequest;
  plan: UpgradeContractPlan;
  signedManifest: SignedUpgradeManifest;
  expandAttemptId: string;
  readers: Record<string, unknown>[];
  eligibility: Record<string, unknown>;
  retirementReceipts: Record<string, unknown>;
  checkpoint: string | null;
}
const ContractRecordSchema = z.object({
  attempt: UpgradeContractAttemptSchema,
  fence: z.number(),
  actorId: z.string(),
  command: UpgradeContractRequestSchema,
  plan: UpgradeContractPlanSchema,
  signedManifest: SignedUpgradeManifestSchema,
  expandAttemptId: z.string(),
  readers: z.array(z.record(z.unknown())),
  eligibility: z.record(z.unknown()),
  retirementReceipts: z.record(z.unknown()),
  checkpoint: z.string().nullable(),
});
function assertContractRecord(value: unknown): asserts value is ContractRecord {
  // Validation is separate from signature/digest comparison; retain the raw record.
  ContractRecordSchema.parse(value);
}
@Injectable()
export class UpgradeContractStore {
  constructor(
    readonly upgrades: UpgradeStore,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
  ) {}
  get sqlite(): Database.Database {
    return this.upgrades.sqlite;
  }
  private now() {
    return this.clock.now().getTime();
  }
  snapshot(id: string): ContractRecord {
    const row = this.sqlite
      .prepare<unknown[], { result: string; fence: number; request_digest: string }>(
        'SELECT result,fence,request_digest FROM platform_operations WHERE operation_id=? AND instance_id=? AND role=?',
      )
      .get(id, this.upgrades.instanceId, CONTRACT_ROLE);
    requireUpgrade(row, 'CONTRACT_REQUEST_NOT_FOUND', 404);
    const record: unknown = JSON.parse(row.result);
    assertContractRecord(record);
    record.attempt = UpgradeContractAttemptSchema.parse(record.attempt);
    record.plan = UpgradeContractPlanSchema.parse(record.plan);
    record.command = UpgradeContractRequestSchema.parse(record.command);
    const { planDigest, ...facts } = record.plan;
    requireUpgrade(
      record.fence === row.fence &&
        record.attempt.contractAttemptId === id &&
        record.attempt.instanceId === this.upgrades.instanceId &&
        planDigest === upgradeDigest(facts) &&
        row.request_digest === upgradeDigest(record.command),
      'CONTRACT_INTENT_CORRUPT',
    );
    return record;
  }
  latest(): ContractRecord | null {
    const row = this.sqlite
      .prepare<unknown[], { operation_id: string }>(
        'SELECT operation_id FROM platform_operations WHERE instance_id=? AND role=? ORDER BY fence DESC,rowid DESC LIMIT 1',
      )
      .get(this.upgrades.instanceId, CONTRACT_ROLE);
    return row ? this.snapshot(row.operation_id) : null;
  }
  replay(actor: string, command: UpgradeContractRequest): ContractRecord | null {
    const row = this.sqlite
      .prepare<unknown[], { operation_id: string; request_digest: string }>(
        "SELECT operation_id,request_digest FROM platform_operations WHERE instance_id=? AND role=? AND actor_id=? AND json_extract(result,'$.command.requestId')=?",
      )
      .get(this.upgrades.instanceId, CONTRACT_ROLE, actor, command.requestId);
    if (!row) return null;
    requireUpgrade(
      row.request_digest === upgradeDigest(command),
      'CONTRACT_REQUEST_PAYLOAD_CONFLICT',
    );
    return this.snapshot(row.operation_id);
  }
  lookup(actor: string, requestId: string): UpgradeContractAttempt {
    const row = this.sqlite
      .prepare<unknown[], { operation_id: string }>(
        "SELECT operation_id FROM platform_operations WHERE instance_id=? AND role=? AND actor_id=? AND json_extract(result,'$.command.requestId')=?",
      )
      .get(this.upgrades.instanceId, CONTRACT_ROLE, actor, requestId);
    requireUpgrade(row, 'CONTRACT_REQUEST_NOT_FOUND', 404);
    return this.snapshot(row.operation_id).attempt;
  }
  accept(
    actorId: string,
    command: UpgradeContractRequest,
    fixed: Omit<
      ContractRecord,
      'attempt' | 'actorId' | 'command' | 'fence' | 'retirementReceipts' | 'checkpoint'
    >,
    entryFloor: number,
  ): ContractRecord {
    return this.sqlite
      .transaction(() => {
        const replay = this.replay(actorId, command);
        if (replay) return replay;
        requireUpgrade(
          !this.sqlite
            .prepare(
              "SELECT 1 FROM platform_operations WHERE instance_id=? AND role='upgrade-plan' AND state IN ('accepted','preparing','running')",
            )
            .get(this.upgrades.instanceId),
          'UPGRADE_ALREADY_ACTIVE',
        );
        requireUpgrade(
          this.upgrades.instance().service_state === 'confirmed' &&
            this.upgrades.instance().activation_generation === command.expectedActivationGeneration,
          'CONTRACT_ACTIVATION_CONFLICT',
        );
        requireUpgrade(
          !contractActive(this.sqlite, this.upgrades.instanceId) &&
            this.upgrades.pending().attempts.length === 0 &&
            this.upgrades.recovery()?.state !== 'recovering',
          'INSTANCE_OPERATION_ACTIVE',
        );
        requireUpgrade(Number.isSafeInteger(entryFloor) && entryFloor >= 0, 'ENTRY_FENCE_UNKNOWN');
        const high = requiredUpgradeValue(
          this.sqlite
            .prepare<unknown[], { n: number }>(
              'SELECT coalesce(max(fence),0) n FROM upgrade_attempts WHERE instance_id=?',
            )
            .get(this.upgrades.instanceId),
        ).n;
        const fence =
          Math.max(high, entryFloor, contractFenceFloor(this.sqlite, this.upgrades.instanceId)) + 1;
        const now = this.now(),
          id = this.ids.next();
        const attempt = UpgradeContractAttemptSchema.parse({
          instanceId: this.upgrades.instanceId,
          contractAttemptId: id,
          requestId: command.requestId,
          targetPlanDigest: command.targetPlanDigest,
          activationGeneration: command.expectedActivationGeneration,
          sequence: 0,
          state: 'accepted',
          stage: '用户已确认独立清理',
          completedRows: 0,
          totalRows: null,
          acceptedAt: fromEpochMs(now).toISOString(),
          observedAt: fromEpochMs(now).toISOString(),
          reason: null,
        });
        const record: ContractRecord = {
          ...fixed,
          attempt,
          actorId,
          command,
          fence,
          retirementReceipts: {},
          checkpoint: null,
        };
        this.sqlite
          .prepare(
            'UPDATE upgrade_attempts SET controller_id=NULL,lease_expires_at=0 WHERE instance_id=?',
          )
          .run(this.upgrades.instanceId);
        this.sqlite
          .prepare(
            'INSERT INTO platform_operations(operation_id,instance_id,actor_id,role,fence,request_digest,state,result,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
          )
          .run(
            id,
            this.upgrades.instanceId,
            actorId,
            CONTRACT_ROLE,
            fence,
            upgradeDigest(command),
            attempt.state,
            canonicalUpgrade(record),
            now,
            now,
          );
        return record;
      })
      .immediate();
  }
  assertFence(id: string, fence: number): ContractRecord {
    const record = this.snapshot(id);
    const high = requiredUpgradeValue(
      this.sqlite
        .prepare<unknown[], { n: number }>(
          'SELECT coalesce(max(fence),0) n FROM upgrade_attempts WHERE instance_id=?',
        )
        .get(this.upgrades.instanceId),
    ).n;
    requireUpgrade(
      Number.isSafeInteger(fence) &&
        fence === record.fence &&
        this.latest()?.attempt.contractAttemptId === id &&
        high < fence &&
        this.upgrades.instance().activation_generation === record.attempt.activationGeneration,
      'CONTRACT_FENCE_SUPERSEDED',
    );
    return record;
  }
  save(
    record: ContractRecord,
    patch: Partial<UpgradeContractAttempt>,
    extra: Partial<ContractRecord> = {},
  ): ContractRecord {
    return this.sqlite
      .transaction(() => {
        const original = this.assertFence(record.attempt.contractAttemptId, record.fence);
        requireUpgrade(
          original.attempt.sequence === record.attempt.sequence,
          'CONTRACT_SEQUENCE_CONFLICT',
        );
        requireUpgrade(ACTIVE.includes(original.attempt.state), 'CONTRACT_TERMINAL_INTENT');
        const next = {
          ...original,
          ...extra,
          attempt: UpgradeContractAttemptSchema.parse({
            ...original.attempt,
            ...patch,
            sequence: original.attempt.sequence + 1,
            observedAt: this.clock.now().toISOString(),
          }),
        };
        this.sqlite
          .prepare(
            'UPDATE platform_operations SET state=?,result=?,updated_at=? WHERE operation_id=? AND fence=?',
          )
          .run(
            next.attempt.state,
            canonicalUpgrade(next),
            this.now(),
            original.attempt.contractAttemptId,
            original.fence,
          );
        return next;
      })
      .immediate();
  }
  active(): ContractRecord[] {
    return this.sqlite
      .prepare<unknown[], { operation_id: string }>(
        "SELECT operation_id FROM platform_operations WHERE instance_id=? AND role=? AND state IN ('accepted','retiring-readers','authority-active','clearing') ORDER BY fence DESC",
      )
      .all(this.upgrades.instanceId, CONTRACT_ROLE)
      .map((r) => this.snapshot(r.operation_id));
  }
}
