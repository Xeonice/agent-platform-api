import { preserveUpgradeCriticalAuthority } from './upgrade-control-authority-client';
import { assertCurrentBusinessAction, withoutBusinessAction } from './upgrade-business-action';
import { upgradeRecord } from './upgrade-values';
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '@platform/shared-kernel';
import { SANDBOX_PROVIDER_REGISTRY, SANDBOX_FACADE } from '@platform/contracts';
import {
  RuntimeOwnerProviderRegistry,
  RunAgentTaskWorkflow,
  ProvisionSandboxWorkflow,
  TasksGateway,
  SandboxFacadeAdapter,
} from '@platform/sandbox';
import { EventsGateway } from '../events/events.gateway';
import { CloneProjectWorkflow } from '@platform/project';
import { AutomationScheduler } from '@platform/automation';
import { TerminalGateway } from '@platform/terminal';
import { join, resolve } from 'node:path';
import { ControlApplicationRegistry } from '../control-rpc/control-rpc.module';
import { coordinatorWriterControl } from '../persistence/coordinator-lease';
import { env } from '../config/env';
import { writeInstalledBinding } from './upgrade-atomic-file';
import { loopbackOrigin, UpgradeInspector } from './upgrade-inspector';
import { UpgradeStore } from './upgrade-store';
import { canonicalUpgrade, requireUpgrade } from './upgrade-trust';

type Json = Record<string, unknown>;
export interface HandoffRow {
  attempt_id: string;
  operation_id: string;
  plan_digest: string;
  candidate: string;
  stage: string;
  source_generation: number;
  target_generation: number | null;
  quiesced_at: number | null;
  activated_at: number | null;
  evidence: string | null;
}

/** Narrow accepted-plan handoff; no arbitrary shell, stop or whole-volume API. */
@Injectable()
export class CoordinatorHandoff {
  constructor(
    private readonly store: UpgradeStore,
    private readonly inspector: UpgradeInspector,
    private readonly applications: ControlApplicationRegistry,
    private readonly pump: RunAgentTaskWorkflow,
    private readonly terminals: TerminalGateway,
    private readonly automations: AutomationScheduler,
    private readonly provisions: ProvisionSandboxWorkflow,
    private readonly clones: CloneProjectWorkflow,
    private readonly events: EventsGateway,
    private readonly tasks: TasksGateway,
    @Inject(SANDBOX_PROVIDER_REGISTRY) private readonly owners: RuntimeOwnerProviderRegistry,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(SANDBOX_FACADE) private readonly cleanup: SandboxFacadeAdapter,
  ) {}
  private row(id: string): HandoffRow | undefined {
    return this.store.sqlite
      .prepare<unknown[], HandoffRow>('SELECT * FROM coordinator_handoffs WHERE attempt_id=?')
      .get(id);
  }
  private async binding(state: 'ready' | 'quiescing', extra: Json = {}): Promise<void> {
    const path = process.env.PLATFORM_COORDINATOR_BINDING_PATH;
    requireUpgrade(path, 'COORDINATOR_BINDING_PATH_REQUIRED');
    await writeInstalledBinding(path, {
      state,
      instanceId: this.store.instanceId,
      origin: `http://${env.host}:${String(env.port)}`,
      generation: Number(process.env.COORDINATOR_GENERATION),
      artifactDigest: process.env.PLATFORM_ARTIFACT_DIGEST ?? null,
      ...extra,
    });
  }
  private async candidateRpc(candidate: Json, action: string, body?: Json): Promise<Json> {
    const origin = loopbackOrigin(candidate.managementOrigin ?? candidate.origin);
    const r = await fetch(origin + '/internal/coordinator/' + action, {
      method: body ? 'POST' : 'GET',
      headers: {
        'content-type': 'application/json',
        'x-platform-internal-key': process.env.PLATFORM_CONTROLLER_RPC_KEY ?? '',
        'x-platform-instance-id': this.store.instanceId,
      },
      body: body ? canonicalUpgrade(body) : undefined,
      signal: AbortSignal.timeout(action === 'adopt' ? 2000 : 1500),
    });
    requireUpgrade(r.ok, 'COORDINATOR_CANDIDATE_UNCONFIRMED');
    return upgradeRecord(await r.json());
  }
  async execute(id: string, input: Json): Promise<Json> {
    const fence = Number(input.fence);
    this.store.assertControllerFence(id, fence);
    const snapshot = this.store.snapshot(id),
      plan = snapshot.plan;
    requireUpgrade(
      input.planDigest === plan.planDigest &&
        typeof input.operationId === 'string' &&
        ['prepare', 'quiesce', 'release', 'adopt', 'status'].includes(String(input.action)),
      'FIXED_HANDOFF_COMMAND_REQUIRED',
    );
    const existing = this.row(id);
    if (existing)
      requireUpgrade(
        existing.operation_id === input.operationId && existing.plan_digest === input.planDigest,
        'HANDOFF_INTENT_CONFLICT',
      );
    if (input.action === 'status') {
      if (!existing) return { definitelyNotApplied: true, stage: 'absent' };
      if (existing.stage === 'adopted' && existing.evidence)
        return {
          applied: true,
          commitKnown: true,
          stage: existing.stage,
          evidence: JSON.parse(existing.evidence) as unknown,
        };
      if (existing.stage === 'prepared' || existing.stage === 'quiesced')
        return {
          stage: existing.stage,
          applied: false,
          commitKnown: true,
          resumeAction: existing.stage === 'prepared' ? 'quiesce' : 'release',
        };
      return {
        stage: existing.stage,
        applied: false,
        commitKnown: false,
        unknown: ['releasing', 'adopting'].includes(existing.stage),
      };
    }
    const candidate = existing
      ? upgradeRecord(JSON.parse(existing.candidate))
      : upgradeRecord(input.candidate);
    requireUpgrade(
      candidate.artifactDigest === snapshot.manifest.components.coordinator.artifactDigest &&
        typeof candidate.startIdentity === 'string',
      'COORDINATOR_CANDIDATE_IDENTITY_REQUIRED',
    );
    if (existing && input.candidate)
      requireUpgrade(
        canonicalUpgrade(candidate) === canonicalUpgrade(input.candidate),
        'HANDOFF_CANDIDATE_CHANGED',
      );
    if (input.action === 'prepare') {
      if (existing)
        return {
          commitKnown: true,
          stage: existing.stage,
          evidence: existing.evidence ? (JSON.parse(existing.evidence) as unknown) : null,
        };
      const installedRoot = process.env.UPGRADE_INSTALLER_ROOT;
      requireUpgrade(installedRoot, 'INSTALLER_ROOT_REQUIRED');
      const artifactRoot = resolve(join(installedRoot, 'artifacts', plan.package.digest.slice(7)));
      requireUpgrade(candidate.artifactRoot === artifactRoot, 'FIXED_ARTIFACT_ROOT_REQUIRED');
      await this.inspector.verifyArtifact(artifactRoot, snapshot.manifest.components);
      assertCurrentBusinessAction();
      const identity = await this.candidateRpc(candidate, 'identity');
      assertCurrentBusinessAction();
      requireUpgrade(
        identity.instanceId === this.store.instanceId &&
          identity.startIdentity === candidate.startIdentity &&
          identity.artifactDigest === candidate.artifactDigest &&
          identity.role === 'coordinator-prepared' &&
          identity.prepared === true &&
          identity.writerFenceValid === false &&
          identity.workersStarted === false,
        'READ_ONLY_COORDINATOR_NOT_PREPARED',
      );
      requireUpgrade(
        !this.store.sqlite
          .prepare('SELECT 1 FROM upgrade_online_migrations WHERE read_epoch=2 LIMIT 1')
          .get() ||
          (Array.isArray(identity.supportedDataFormats) &&
            identity.supportedDataFormats.includes('project-name-v2-authority')),
        'COORDINATOR_DATA_FORMAT_INCOMPATIBLE',
      );
      this.store.assertFence(id, fence);
      this.store.sqlite
        .prepare(
          'INSERT INTO coordinator_handoffs(attempt_id,operation_id,plan_digest,candidate,stage,source_generation,evidence) VALUES(?,?,?,?,?,?,?)',
        )
        .run(
          id,
          input.operationId,
          plan.planDigest,
          canonicalUpgrade(candidate),
          'prepared',
          Number(process.env.COORDINATOR_GENERATION),
          canonicalUpgrade(identity),
        );
      return { commitKnown: true, stage: 'prepared', evidence: identity };
    }
    requireUpgrade(existing, 'COORDINATOR_HANDOFF_NOT_PREPARED');
    if (input.action === 'quiesce') {
      if (existing.stage === 'quiesced') return { commitKnown: true, stage: 'quiesced' };
      requireUpgrade(existing.stage === 'prepared', 'HANDOFF_STAGE_CONFLICT');
      const identity = await this.candidateRpc(candidate, 'identity');
      requireUpgrade(
        identity.prepared === true && identity.writerFenceValid === false,
        'READ_ONLY_COORDINATOR_NOT_PREPARED',
      );
      const source = coordinatorWriterControl(this.store.sqlite);
      source.assert();
      const quiescedAt = this.clock.now().getTime();
      await preserveUpgradeCriticalAuthority(this.store, this.clock, id, fence, 'quiesce');
      this.store.sqlite
        .prepare(
          "UPDATE coordinator_handoffs SET stage='quiesced',quiesced_at=? WHERE attempt_id=?",
        )
        .run(quiescedAt, id);
      try {
        await this.binding('quiescing', {
          attemptId: id,
          fence,
          nextOrigin: candidate.businessOrigin,
        });
        assertCurrentBusinessAction();
        await this.applications.quiesce(Math.min(1000, plan.policy.requestDeadlineMs / 2));
        assertCurrentBusinessAction();
        requireUpgrade(
          this.provisions.pauseOwnership() &&
            this.clones.pauseOwnership() &&
            this.cleanup.pauseOwnership(),
          'BACKGROUND_WORK_PENDING',
        );
        this.pump.shutdown();
        this.automations.pauseOwnership();
        this.terminals.prepareHandoff();
        this.events.prepareHandoff();
        this.tasks.prepareHandoff();
      } catch (error) {
        await this.binding('ready');
        withoutBusinessAction(() => {
          this.applications.resume();
          this.pump.resumeOwnership();
          this.automations.resumeOwnership();
          this.provisions.resumeOwnership();
          this.clones.resumeOwnership();
          this.cleanup.resumeOwnership();
          this.events.resumeAfterHandoff();
          this.tasks.resumeAfterHandoff();
        });
        this.store.sqlite
          .prepare(
            "UPDATE coordinator_handoffs SET stage='prepared',quiesced_at=NULL WHERE attempt_id=?",
          )
          .run(id);
        throw error;
      }
      return { commitKnown: true, stage: 'quiesced', quiescedAt };
    }
    if (input.action === 'release') {
      requireUpgrade(existing.stage === 'quiesced', 'HANDOFF_STAGE_CONFLICT');
      await preserveUpgradeCriticalAuthority(
        this.store,
        this.clock,
        id,
        fence,
        'release',
        plan.policy.requestDeadlineMs - (this.clock.now().getTime() - Number(existing.quiesced_at)),
      );
      assertCurrentBusinessAction();
      requireUpgrade(
        this.clock.now().getTime() - Number(existing.quiesced_at) < plan.policy.requestDeadlineMs,
        'HANDOFF_CONTROL_BUDGET_EXCEEDED',
      );
      this.store.sqlite
        .prepare("UPDATE coordinator_handoffs SET stage='releasing' WHERE attempt_id=?")
        .run(id);
      try {
        assertCurrentBusinessAction();
        await this.owners.releaseBusinessAuthority();
        assertCurrentBusinessAction();
        coordinatorWriterControl(this.store.sqlite).release();
      } catch (error) {
        // If the old writer still holds its valid epoch, no replacement owns it.
        // Recover its owner lease and resume A; never stop the in-flight guest.
        coordinatorWriterControl(this.store.sqlite).assert();
        await this.owners.activateBusinessAuthority(Number(process.env.COORDINATOR_GENERATION));
        this.store.sqlite
          .prepare(
            "UPDATE coordinator_handoffs SET stage='prepared',quiesced_at=NULL WHERE attempt_id=?",
          )
          .run(id);
        await this.binding('ready');
        withoutBusinessAction(() => {
          this.applications.resume();
          this.pump.resumeOwnership();
          this.automations.resumeOwnership();
          this.provisions.resumeOwnership();
          this.clones.resumeOwnership();
          this.cleanup.resumeOwnership();
          this.events.resumeAfterHandoff();
          this.tasks.resumeAfterHandoff();
        });
        throw error;
      }
      // Stable control owns adoption as a separately journaled fixed command.
      if (this.store.ledgerReadonly) return { commitKnown: true, stage: 'releasing' };
      // This durable accepted handoff owns the critical section even if its
      // external Controller disappears after release. Do not wait for a new RPC
      // to bring up the already verified read-only candidate.
      await preserveUpgradeCriticalAuthority(
        this.store,
        this.clock,
        id,
        fence,
        'adopt',
        plan.policy.requestDeadlineMs - (this.clock.now().getTime() - Number(existing.quiesced_at)),
      );
      return this.candidateRpc(candidate, 'adopt', {
        instanceId: this.store.instanceId,
        attemptId: id,
        fence,
        operationId: input.operationId,
        planDigest: plan.planDigest,
        startIdentity: candidate.startIdentity,
      });
    }
    // Release/adopt outcomes are queried against their durable epoch/record; a
    // timeout does not authorize a second writer or a replayed release.
    requireUpgrade(['releasing', 'adopted'].includes(existing.stage), 'HANDOFF_STAGE_CONFLICT');
    if (existing.stage !== 'adopted')
      await preserveUpgradeCriticalAuthority(
        this.store,
        this.clock,
        id,
        fence,
        'adopt',
        plan.policy.requestDeadlineMs - (this.clock.now().getTime() - Number(existing.quiesced_at)),
      );
    return this.candidateRpc(candidate, 'adopt', {
      instanceId: this.store.instanceId,
      attemptId: id,
      fence,
      operationId: input.operationId,
      planDigest: plan.planDigest,
      startIdentity: candidate.startIdentity,
    });
  }
}
