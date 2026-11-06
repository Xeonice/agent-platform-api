import { Inject, Injectable } from '@nestjs/common';
import { statfs, lstat } from 'node:fs/promises';
import { CLOCK, isRecord, type Clock } from '@platform/shared-kernel';
import {
  SANDBOX_PROVIDER_REGISTRY,
  type ProviderRegistry,
  type UpgradeContractPlan,
} from '@platform/contracts';
import { RuntimeOwnerProviderRegistry } from '@platform/sandbox';
import { UpgradeContractStore, type ContractRecord } from './upgrade-contract-store';
import { UpgradeOnlineMigration } from './upgrade-online-migration';
import type {
  UpgradeContractBusinessPort,
  ContractClearResult,
} from './upgrade-contract-business.port';
import { canonicalUpgrade, requireUpgrade, upgradeDigest } from './upgrade-trust';
import { upgradeRecord } from './upgrade-values';
import { env } from '../config/env';
import {
  currentContractControl,
  withContractControl,
} from '../persistence/upgrade-contract-context';

export interface ContractBusinessCommand {
  contractAttemptId: string;
  fence: number;
  expectedSequence: number;
  commandId: string;
  action: 'activate' | 'clear';
}
/** Business participant only; this module intentionally stays out of the Agent import graph. */
@Injectable()
export class UpgradeContractBusiness implements UpgradeContractBusinessPort {
  constructor(
    readonly store: UpgradeContractStore,
    private readonly migration: UpgradeOnlineMigration,
    @Inject(SANDBOX_PROVIDER_REGISTRY) private readonly providers: ProviderRegistry,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}
  projectNameAuthoritative(): boolean {
    return this.migration.projectNameAuthoritative();
  }
  expandAttemptId(planDigest: string): string | null {
    return (
      this.store.sqlite
        .prepare<unknown[], { attempt_id: string }>(
          'SELECT attempt_id FROM upgrade_online_migrations WHERE plan_digest=?',
        )
        .get(planDigest)?.attempt_id ?? null
    );
  }
  currentStartIdentity(): string {
    const value = process.env.PLATFORM_PROCESS_START_IDENTITY;
    requireUpgrade(
      typeof value === 'string' && value.length > 0,
      'CONTRACT_CURRENT_WRITER_UNCONFIRMED',
    );
    return value;
  }
  ownerRoutes() {
    requireUpgrade(
      this.providers instanceof RuntimeOwnerProviderRegistry,
      'CONTRACT_OWNER_DEPENDENCY_UNKNOWN',
    );
    return this.providers.installedRoutes().map(({ ownerId, endpoint }) => ({ ownerId, endpoint }));
  }
  contractFacts(plan: UpgradeContractPlan) {
    return this.migration.contractFacts(plan);
  }
  async budget(plan: UpgradeContractPlan): Promise<void> {
    const fs = await statfs(env.dataRoot),
      available = fs.bavail * fs.bsize;
    const path = this.store.sqlite.name ? this.store.sqlite.name + '-wal' : '';
    const wal = path
      ? await lstat(path).catch((error: unknown) => {
          if (isRecord(error) && error.code === 'ENOENT') return null;
          throw error;
        })
      : null;
    requireUpgrade(
      available >= plan.minFreeBytes && (!wal || wal.size <= plan.maxWalBytes),
      'CONTRACT_STORAGE_BUDGET_EXCEEDED',
    );
  }
  private command(record: ContractRecord, action: 'activate' | 'clear'): ContractBusinessCommand {
    return {
      contractAttemptId: record.attempt.contractAttemptId,
      fence: record.fence,
      expectedSequence: record.attempt.sequence,
      action,
      commandId:
        record.attempt.contractAttemptId +
        (action === 'activate' ? ':activate' : ':clear:' + String(record.attempt.sequence)),
    };
  }
  activate(record: ContractRecord, commit: (totalRows: number) => void): void {
    this.apply(this.command(record, 'activate'), (result) => {
      commit(Number(result.totalRows));
    });
  }
  clear(record: ContractRecord, commit: (batch: ContractClearResult) => void): void {
    this.apply(this.command(record, 'clear'), (result) => {
      requireUpgrade(
        typeof result.cleared === 'number' && typeof result.complete === 'boolean',
        'CONTRACT_BUSINESS_RECEIPT_CORRUPT',
      );
      commit({ cleared: result.cleared, complete: result.complete });
    });
  }
  lookup(contractAttemptId: string, commandId: string): Record<string, unknown> | null {
    const row = this.store.sqlite
      .prepare<unknown[], { actor_id: string; request_digest: string; result: string }>(
        "SELECT actor_id,request_digest,result FROM platform_operations WHERE operation_id=? AND instance_id=? AND role='schema-contract-action'",
      )
      .get(commandId, this.store.upgrades.instanceId);
    if (!row) return null;
    const receipt = upgradeRecord(JSON.parse(row.result)),
      { receiptDigest, ...proof } = receipt;
    requireUpgrade(
      row.actor_id === contractAttemptId &&
        receipt.contractAttemptId === contractAttemptId &&
        receipt.commandId === commandId &&
        row.request_digest === receipt.specDigest &&
        upgradeDigest(proof) === receiptDigest,
      'CONTRACT_BUSINESS_RECEIPT_CORRUPT',
    );
    return receipt;
  }
  execute(command: ContractBusinessCommand): Record<string, unknown> {
    return this.apply(command, () => {
      /* Private participant RPC persists its own receipt; control progress is committed by Agent afterward. */
    });
  }
  private apply(
    command: ContractBusinessCommand,
    commit: (result: Record<string, unknown>) => void,
  ): Record<string, unknown> {
    const instanceId = this.store.upgrades.instanceId;
    const record = this.store.snapshot(command.contractAttemptId);
    requireUpgrade(
      command.fence === record.fence &&
        command.commandId ===
          record.attempt.contractAttemptId +
            (command.action === 'activate'
              ? ':activate'
              : ':clear:' + String(command.expectedSequence)),
      'CONTRACT_BUSINESS_COMMAND_INVALID',
    );
    const specDigest = upgradeDigest({ ...command, planDigest: record.plan.planDigest });
    return this.store.sqlite
      .transaction(() => {
        this.store.assertFence(command.contractAttemptId, command.fence);
        const previous = this.lookup(command.contractAttemptId, command.commandId);
        if (previous) {
          requireUpgrade(previous.specDigest === specDigest, 'CONTRACT_BUSINESS_COMMAND_CONFLICT');
          commit(upgradeRecord(previous.result));
          return previous;
        }
        const actual = this.store.assertFence(command.contractAttemptId, command.fence);
        requireUpgrade(
          actual.attempt.sequence === command.expectedSequence &&
            (command.action === 'activate'
              ? actual.attempt.state === 'retiring-readers'
              : ['authority-active', 'clearing'].includes(actual.attempt.state)),
          'CONTRACT_BUSINESS_STAGE_CONFLICT',
        );
        const admissionId = 'contract-admission:' + instanceId;
        const context = currentContractControl(),
          executionEpoch = context?.epoch ?? command.fence;
        const admitted = this.store.sqlite
          .prepare<unknown[], { fence: number; actor_id: string }>(
            "SELECT fence,actor_id FROM platform_operations WHERE operation_id=? AND instance_id=? AND role='schema-contract-admission'",
          )
          .get(admissionId, instanceId);
        requireUpgrade(
          !admitted ||
            admitted.fence < executionEpoch ||
            (admitted.fence === executionEpoch && admitted.actor_id === command.contractAttemptId),
          'CONTRACT_PARTICIPANT_SUPERSEDED',
        );
        this.store.sqlite
          .prepare(
            'INSERT INTO platform_operations VALUES(?,?,?,?,?,?,?,NULL,?,?) ON CONFLICT(operation_id) DO UPDATE SET actor_id=excluded.actor_id,fence=excluded.fence,request_digest=excluded.request_digest,updated_at=excluded.updated_at',
          )
          .run(
            admissionId,
            instanceId,
            command.contractAttemptId,
            'schema-contract-admission',
            executionEpoch,
            String(command.fence),
            'admitted',
            this.clock.now().getTime(),
            this.clock.now().getTime(),
          );
        const execute = () => {
          const assert = () => {
            this.store.assertFence(command.contractAttemptId, command.fence);
          };
          const result: Record<string, unknown> =
            command.action === 'activate'
              ? { totalRows: this.migration.activateProjectAuthority(actual.plan, assert) }
              : this.migration.clearLegacyProjectNames(actual.plan, assert);
          const proof = {
            instanceId,
            contractAttemptId: command.contractAttemptId,
            commandId: command.commandId,
            fence: command.fence,
            specDigest,
            action: command.action,
            observedAt: this.clock.now().toISOString(),
            result,
          };
          const receipt = { ...proof, receiptDigest: upgradeDigest(proof) };
          commit(result);
          this.store.sqlite
            .prepare('INSERT INTO platform_operations VALUES(?,?,?,?,?,?,?,?,?,?)')
            .run(
              command.commandId,
              instanceId,
              command.contractAttemptId,
              'schema-contract-action',
              command.fence,
              specDigest,
              'completed',
              canonicalUpgrade(receipt),
              this.clock.now().getTime(),
              this.clock.now().getTime(),
            );
          return receipt;
        };
        return context ? withContractControl({ ...context, mode: 'execute' }, execute) : execute();
      })
      .immediate();
  }
}
