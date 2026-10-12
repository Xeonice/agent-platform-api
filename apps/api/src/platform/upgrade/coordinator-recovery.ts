import {
  Inject,
  Injectable,
  Optional,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { freemem } from 'node:os';
import { statfs } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { getHeapStatistics } from 'node:v8';
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
import {
  CloneProjectWorkflow,
  PROJECT_READ_PROJECTION,
  type ProjectReadProjection,
} from '@platform/project';
import { AutomationScheduler } from '@platform/automation';
import { TerminalGateway } from '@platform/terminal';
import { ControlApplicationRegistry } from '../control-rpc/control-rpc.module';
import { coordinatorWriterControl } from '../persistence/coordinator-lease';
import { env } from '../config/env';
import { supportedDataFormats } from '../data-format-capabilities';
import { UpgradeStore } from './upgrade-store';
import { loopbackOrigin, UpgradeInspector } from './upgrade-inspector';
import { UpgradeOnlineMigration } from './upgrade-online-migration';
import { canonicalUpgrade, requireUpgrade, upgradeDigest } from './upgrade-trust';
import { writeInstalledBinding } from './upgrade-atomic-file';

type Json = Record<string, unknown>;
interface Row {
  recovery_attempt_id: string;
  triggering_attempt_id: string;
  operation_id: string;
  plan_digest: string;
  candidate: string;
  stage: string;
  source_generation: number;
  quiesced_at: number | null;
  evidence: string | null;
}
/** Recover the retained application process; never rewind the database or revive a guest. */
@Injectable()
export class CoordinatorRecovery implements OnApplicationBootstrap, OnModuleDestroy {
  private watch?: ReturnType<typeof setInterval>;
  private resuming: Promise<Json> | null = null;
  constructor(
    private readonly store: UpgradeStore,
    private readonly inspector: UpgradeInspector,
    private readonly migrations: UpgradeOnlineMigration,
    private readonly applications: ControlApplicationRegistry,
    private readonly pump: RunAgentTaskWorkflow,
    private readonly automations: AutomationScheduler,
    private readonly provisions: ProvisionSandboxWorkflow,
    private readonly clones: CloneProjectWorkflow,
    private readonly events: EventsGateway,
    private readonly tasks: TasksGateway,
    private readonly terminals: TerminalGateway,
    @Inject(SANDBOX_PROVIDER_REGISTRY) private readonly owners: RuntimeOwnerProviderRegistry,
    @Inject(CLOCK) private readonly clock: Clock,
    @Optional()
    @Inject(PROJECT_READ_PROJECTION)
    private readonly projection?: ProjectReadProjection,
    @Optional()
    @Inject(SANDBOX_FACADE)
    private readonly cleanup?: SandboxFacadeAdapter,
  ) {}
  onApplicationBootstrap(): void {
    if (process.env.PLATFORM_PROCESS_ROLE !== 'coordinator') return;
    this.watch = setInterval(() => {
      if (process.env.COORDINATOR_WRITER_FENCE_VALID === 'true' || this.resuming) return;
      const row = this.store.sqlite
        .prepare(
          "SELECT * FROM coordinator_recoveries WHERE stage='releasing' ORDER BY rowid DESC LIMIT 1",
        )
        .get() as Row | undefined;
      if (!row) return;
      const candidate = JSON.parse(row.candidate) as Json;
      if (
        candidate.startIdentity !== process.env.PLATFORM_PROCESS_START_IDENTITY ||
        candidate.artifactDigest !== process.env.PLATFORM_ARTIFACT_DIGEST
      )
        return;
      const snapshot = this.store.snapshot(row.triggering_attempt_id);
      void this.resume(row.triggering_attempt_id, {
        fence: snapshot.fence,
        recoveryPlanDigest: row.plan_digest,
      }).catch(() => undefined);
    }, 10);
    this.watch.unref();
  }
  onModuleDestroy(): void {
    if (this.watch) clearInterval(this.watch);
  }
  private baseline(id: string): Json {
    const row = this.store.sqlite
      .prepare('SELECT snapshot,digest FROM upgrade_continuity_baselines WHERE attempt_id=?')
      .get(id) as { snapshot: string; digest: string } | undefined;
    requireUpgrade(row, 'CONTINUITY_BASELINE_MISSING');
    const baseline = JSON.parse(row.snapshot) as Json;
    requireUpgrade(upgradeDigest(baseline) === row.digest, 'CONTINUITY_BASELINE_CORRUPT');
    return baseline;
  }
  private recoveryPlan(id: string, digest: string): Json {
    const recovery = this.store.recovery();
    requireUpgrade(
      recovery &&
        recovery.triggeringAttemptId === id &&
        recovery.state === 'recovering' &&
        recovery.planDigest === digest,
      'FIXED_RECOVERY_INTENT_REQUIRED',
    );
    const row = this.store.sqlite
      .prepare('SELECT plan FROM upgrade_recoveries WHERE recovery_attempt_id=?')
      .get(recovery.recoveryAttemptId) as { plan: string };
    const plan = JSON.parse(row.plan) as Json;
    const { planDigest, ...input } = plan;
    requireUpgrade(
      planDigest === digest && upgradeDigest(input) === digest,
      'RECOVERY_PLAN_CORRUPT',
    );
    return plan;
  }
  async compatibility(id: string, fence: number): Promise<Json> {
    this.store.assertFence(id, fence);
    const snapshot = this.store.snapshot(id),
      baseline = this.baseline(id),
      source = baseline.coordinator as Json;
    const retainedBinary =
      source?.artifactDigest === process.env.PLATFORM_ARTIFACT_DIGEST &&
      source.startIdentity === process.env.PLATFORM_PROCESS_START_IDENTITY;
    let columnsCompatible = true;
    for (const [table, columns] of Object.entries(baseline.columns as Json)) {
      requireUpgrade(/^[a-zA-Z0-9_]+$/.test(table), 'SCHEMA_BASELINE_INVALID');
      const names = (columns as Json[]).map((c) => String(c.name));
      try {
        this.store.sqlite
          .prepare(
            'SELECT ' +
              names.map((n) => '"' + n.replaceAll('"', '""') + '"').join(',') +
              ' FROM "' +
              table +
              '" LIMIT 1',
          )
          .get();
        const current = this.store.sqlite
          .prepare('PRAGMA table_info("' + table + '")')
          .all() as Json[];
        if (
          (columns as Json[]).some(
            (c) => !current.some((n) => n.name === c.name && n.type === c.type && n.pk === c.pk),
          )
        )
          columnsCompatible = false;
      } catch {
        columnsCompatible = false;
      }
    }
    const migration = snapshot.plan.migrationPath.migrationPlanDigest
      ? this.migrations.metrics(id)
      : null;
    const contracted = Boolean(
      this.store.sqlite
        .prepare('SELECT 1 FROM upgrade_online_migrations WHERE read_epoch=2 LIMIT 1')
        .get(),
    );
    const formats = supportedDataFormats(this.projection);
    let newAuthorityHealthy = false;
    if (contracted && formats.includes('project-name-v2-authority')) {
      try {
        const rows = this.store.sqlite
          .prepare('SELECT id,name FROM projects LIMIT 10001')
          .all() as { id: string; name: string }[];
        newAuthorityHealthy =
          rows.length <= 10000 &&
          rows.every((row) => {
            const name = this.projection!.name(row.id, row.name);
            return typeof name === 'string' && this.projection!.findIdByName!(name) === row.id;
          });
      } catch {
        /* Missing new authority is never a safe old-data fallback. */
      }
    }
    const authorityPreserved = contracted
      ? newAuthorityHealthy
      : !migration || (migration.known && migration.oldRepresentationRetained);
    const integrity = this.store.sqlite.pragma('quick_check', { simple: true }) === 'ok';
    const fs = await statfs(process.env.UPGRADE_INSTALLER_ROOT ?? env.dataRoot),
      memory = process.memoryUsage();
    const capacity =
      Number(fs.bavail) * Number(fs.bsize) >= snapshot.plan.policy.minFreeBytes &&
      freemem() > memory.rss &&
      getHeapStatistics().heap_size_limit > memory.heapUsed;
    const started = this.clock.now().getTime();
    await new Promise<void>((ok) => setImmediate(ok));
    const eventLoopBounded =
      this.clock.now().getTime() - started <= snapshot.plan.policy.requestDeadlineMs;
    return {
      supportedDataFormats: formats,
      qualified:
        retainedBinary &&
        columnsCompatible &&
        authorityPreserved &&
        integrity &&
        capacity &&
        eventLoopBounded,
      retainedBinary,
      columnsCompatible,
      oldRepresentationRetained: !contracted && authorityPreserved,
      dataRepresentationCompatible: authorityPreserved,
      migrationCommitKnown:
        !migration || (migration.known && migration.differences === 0 && !migration.degraded),
      latestDatabaseCompatible: columnsCompatible && authorityPreserved,
      newWritesCompatible: columnsCompatible && authorityPreserved,
      sharedStateHealthy: integrity,
      capacitySufficient: capacity && eventLoopBounded,
      coordinator: source,
      protocol:
        snapshot.sourceActivation.components.coordinator?.protocol ??
        snapshot.sourceActivation.components.api.protocol,
      schema: this.inspector.schema(),
      instanceId: this.store.instanceId,
      observedAt: this.clock.now().toISOString(),
    };
  }
  private async rpc(origin: unknown, path: string, input: Json): Promise<Json> {
    const response = await fetch(loopbackOrigin(origin) + path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-platform-internal-key': process.env.PLATFORM_CONTROLLER_RPC_KEY ?? '',
        'x-platform-instance-id': this.store.instanceId,
      },
      body: canonicalUpgrade(input),
      signal: AbortSignal.timeout(2000),
    });
    requireUpgrade(response.ok, 'RETAINED_COORDINATOR_UNCONFIRMED');
    return (await response.json()) as Json;
  }
  async execute(id: string, input: Json): Promise<Json> {
    const fence = Number(input.fence);
    this.store.assertControllerFence(id, fence);
    requireUpgrade(typeof input.recoveryPlanDigest === 'string', 'RECOVERY_PLAN_REQUIRED');
    const plan = this.recoveryPlan(id, input.recoveryPlanDigest),
      recovery = this.store.recovery()!,
      source = plan.coordinator as Json | null;
    if (!source) {
      if (plan.owner) {
        const owner = plan.owner as Json;
        requireUpgrade(
          typeof owner.activeOwnerId === 'string' && Array.isArray(owner.owners),
          'FIXED_OWNER_ROUTE_REQUIRED',
        );
        const current = this.owners.installedRoutes();
        requireUpgrade(
          (owner.owners as Json[]).every((r) =>
            current.some((c) => c.ownerId === r.ownerId && c.endpoint === r.endpoint),
          ),
          'ORIGINAL_OWNER_ROUTE_UNKNOWN',
        );
        await writeInstalledBinding(process.env.PLATFORM_RUNTIME_OWNER_BINDING_PATH!, {
          instanceId: this.store.instanceId,
          activeOwnerId: owner.activeOwnerId,
          owners: current,
        });
        this.owners.activateOwner(owner.activeOwnerId);
      }
      return {
        commitKnown: true,
        qualified: true,
        originalResourcesPreserved: (await this.inspector.continuity(id, fence)).qualified,
      };
    }
    requireUpgrade(
      source && typeof source.startIdentity === 'string',
      'RETAINED_COORDINATOR_REQUIRED',
    );
    const existing = this.store.sqlite
      .prepare('SELECT * FROM coordinator_recoveries WHERE recovery_attempt_id=?')
      .get(recovery.recoveryAttemptId) as Row | undefined;
    if (existing?.stage === 'adopted' && existing.evidence)
      return { commitKnown: true, ...(JSON.parse(existing.evidence) as Json) };
    if (existing && ['releasing', 'adopting'].includes(existing.stage))
      return this.rpc(source.origin, '/internal/upgrades/' + id + '/coordinator-resume', {
        fence,
        recoveryPlanDigest: input.recoveryPlanDigest,
      });
    const live = await this.rpc(
      source.origin,
      '/internal/upgrades/' + id + '/coordinator-compatibility',
      { fence },
    );
    requireUpgrade(live.qualified === true, 'LATEST_DATA_INCOMPATIBLE');
    const snapshot = this.store.snapshot(id),
      quiescedAt = this.clock.now().getTime(),
      operationId = 'recovery:' + recovery.recoveryAttemptId;
    this.store.preserveCriticalAuthority(id, fence);
    this.store.sqlite
      .prepare(
        'INSERT OR IGNORE INTO coordinator_recoveries(recovery_attempt_id,triggering_attempt_id,operation_id,plan_digest,candidate,stage,source_generation,quiesced_at) VALUES(?,?,?,?,?,?,?,?)',
      )
      .run(
        recovery.recoveryAttemptId,
        id,
        operationId,
        input.recoveryPlanDigest,
        canonicalUpgrade(source),
        'quiesced',
        Number(process.env.COORDINATOR_GENERATION),
        quiescedAt,
      );
    try {
      await writeInstalledBinding(process.env.PLATFORM_COORDINATOR_BINDING_PATH!, {
        state: 'quiescing',
        instanceId: this.store.instanceId,
        origin: `http://${env.host}:${env.port}`,
        generation: Number(process.env.COORDINATOR_GENERATION),
        artifactDigest: process.env.PLATFORM_ARTIFACT_DIGEST,
        attemptId: id,
        fence,
        nextOrigin: source.origin,
      });
      await this.applications.quiesce(Math.min(1000, snapshot.plan.policy.requestDeadlineMs / 2));
      requireUpgrade(
        this.provisions.pauseOwnership() &&
          this.clones.pauseOwnership() &&
          this.cleanup?.pauseOwnership() === true,
        'BACKGROUND_WORK_PENDING',
      );
      this.pump.shutdown();
      this.automations.pauseOwnership();
      this.terminals.prepareHandoff();
      this.events.prepareHandoff();
      this.tasks.prepareHandoff();
      await this.owners.releaseBusinessAuthority();
      this.store.sqlite
        .prepare("UPDATE coordinator_recoveries SET stage='releasing' WHERE recovery_attempt_id=?")
        .run(recovery.recoveryAttemptId);
      coordinatorWriterControl(this.store.sqlite).release();
    } catch (error) {
      coordinatorWriterControl(this.store.sqlite).assert();
      await this.owners.activateBusinessAuthority(Number(process.env.COORDINATOR_GENERATION));
      this.applications.resume();
      this.pump.resumeOwnership();
      this.automations.resumeOwnership();
      this.provisions.resumeOwnership();
      this.clones.resumeOwnership();
      this.cleanup?.resumeOwnership();
      this.events.resumeAfterHandoff();
      this.tasks.resumeAfterHandoff();
      this.store.sqlite
        .prepare("UPDATE coordinator_recoveries SET stage='quiesced' WHERE recovery_attempt_id=?")
        .run(recovery.recoveryAttemptId);
      await writeInstalledBinding(process.env.PLATFORM_COORDINATOR_BINDING_PATH!, {
        state: 'ready',
        instanceId: this.store.instanceId,
        origin: `http://${env.host}:${env.port}`,
        generation: Number(process.env.COORDINATOR_GENERATION),
        artifactDigest: process.env.PLATFORM_ARTIFACT_DIGEST,
      });
      throw error;
    }
    return this.rpc(source.origin, '/internal/upgrades/' + id + '/coordinator-resume', {
      fence,
      recoveryPlanDigest: input.recoveryPlanDigest,
    });
  }
  async resume(id: string, input: Json): Promise<Json> {
    const fence = Number(input.fence);
    this.store.assertFence(id, fence);
    const plan = this.recoveryPlan(id, String(input.recoveryPlanDigest)),
      recovery = this.store.recovery()!,
      source = plan.coordinator as Json;
    requireUpgrade(
      source.artifactDigest === process.env.PLATFORM_ARTIFACT_DIGEST &&
        source.startIdentity === process.env.PLATFORM_PROCESS_START_IDENTITY,
      'RECOVERY_BINARY_CHANGED',
    );
    const row = this.store.sqlite
      .prepare('SELECT * FROM coordinator_recoveries WHERE recovery_attempt_id=?')
      .get(recovery.recoveryAttemptId) as Row | undefined;
    requireUpgrade(row && row.plan_digest === input.recoveryPlanDigest, 'RECOVERY_INTENT_UNKNOWN');
    if (row.stage === 'adopted' && row.evidence)
      return { commitKnown: true, ...(JSON.parse(row.evidence) as Json) };
    if (this.resuming) return this.resuming;
    requireUpgrade(row.stage === 'releasing', 'RECOVERY_WRITER_NOT_RELEASED');
    const compatibility = await this.compatibility(id, fence);
    requireUpgrade(compatibility.qualified === true, 'RECOVERY_INCOMPATIBLE');
    this.resuming = (async () => {
      const generation = coordinatorWriterControl(this.store.sqlite).reacquire();
      this.store.sqlite
        .prepare(
          "UPDATE coordinator_recoveries SET stage='adopting',target_generation=? WHERE recovery_attempt_id=?",
        )
        .run(generation, recovery.recoveryAttemptId);
      const currentBinding = JSON.parse(
        await readFile(process.env.PLATFORM_RUNTIME_OWNER_BINDING_PATH!, 'utf8'),
      ) as Json;
      requireUpgrade(
        currentBinding.instanceId === this.store.instanceId && Array.isArray(currentBinding.owners),
        'OWNER_BINDING_SCOPE_MISMATCH',
      );
      for (const route of currentBinding.owners as Json[])
        if (!this.owners.installedRoutes().some((r) => r.ownerId === route.ownerId))
          await this.owners.addOwner(
            {
              endpoint: loopbackOrigin(route.endpoint),
              instanceId: this.store.instanceId,
              key: process.env.PLATFORM_COORDINATOR_RPC_KEY ?? '',
              generation,
              clock: this.clock,
            },
            false,
          );
      await this.owners.activateBusinessAuthority(generation);
      if (plan.owner) {
        const owner = plan.owner as Json;
        requireUpgrade(
          typeof owner.activeOwnerId === 'string' && Array.isArray(owner.owners),
          'FIXED_OWNER_ROUTE_REQUIRED',
        );
        for (const route of owner.owners as Json[])
          requireUpgrade(
            this.owners
              .installedRoutes()
              .some((r) => r.ownerId === route.ownerId && r.endpoint === route.endpoint),
            'ORIGINAL_OWNER_ROUTE_UNKNOWN',
          );
        await writeInstalledBinding(process.env.PLATFORM_RUNTIME_OWNER_BINDING_PATH!, {
          instanceId: this.store.instanceId,
          activeOwnerId: owner.activeOwnerId,
          owners: this.owners.installedRoutes(),
        });
        this.owners.activateOwner(owner.activeOwnerId);
      }
      this.applications.resume();
      this.pump.resumeOwnership();
      this.automations.resumeOwnership();
      this.provisions.resumeOwnership();
      this.clones.resumeOwnership();
      this.cleanup?.resumeOwnership();
      this.events.resumeAfterHandoff();
      this.tasks.resumeAfterHandoff();
      const continuity = await this.inspector.continuity(id, fence);
      await writeInstalledBinding(process.env.PLATFORM_COORDINATOR_BINDING_PATH!, {
        state: 'ready',
        instanceId: this.store.instanceId,
        origin: source.origin,
        generation,
        artifactDigest: source.artifactDigest,
      });
      const maxControlPauseMs = this.clock.now().getTime() - Number(row.quiesced_at),
        evidence = {
          commitKnown: true,
          qualified:
            continuity.qualified === true &&
            maxControlPauseMs <= this.store.snapshot(id).plan.policy.requestDeadlineMs,
          singleWriter: true,
          originalResourcesPreserved: continuity.qualified === true,
          maxControlPauseMs,
          generation,
          artifactDigest: source.artifactDigest,
          observedAt: this.clock.now().toISOString(),
        };
      this.store.sqlite
        .prepare(
          "UPDATE coordinator_recoveries SET stage='adopted',activated_at=?,evidence=? WHERE recovery_attempt_id=?",
        )
        .run(this.clock.now().getTime(), canonicalUpgrade(evidence), recovery.recoveryAttemptId);
      return evidence;
    })().finally(() => {
      this.resuming = null;
    });
    return this.resuming;
  }
}
