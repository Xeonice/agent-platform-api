import { matchesProbeScope } from './upgrade-probe-evidence';
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
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { CLOCK, ID_GENERATOR, type Clock, type IdGenerator } from '@platform/shared-kernel';
import {
  PLATFORM_AGENT_TMUX_SESSION,
  SANDBOX_PTY_PORT,
  type SandboxPtyPort,
} from '@platform/contracts';
import { UpgradeStore } from './upgrade-store';
import { loopbackOrigin, persistedBinding, UpgradeInspector } from './upgrade-inspector';
import { requireUpgrade, upgradeDigest } from './upgrade-trust';
import { UpgradeOnlineMigration } from './upgrade-online-migration';
import {
  coordinatorWriterControl,
  withCoordinatorBusinessEpoch,
} from '../persistence/coordinator-lease';
import { verifyMigrationDatabaseIntegrity } from './migration-database-integrity';
import {
  UpgradeProbeEvidence,
  type UpgradeProbeLane,
  type UpgradeProbeScope,
} from './upgrade-probe-evidence';
import {
  hasProbeIdentity,
  matchesProbeIdentity,
  type UpgradeProbeApiIdentity,
} from './upgrade-probe-identity';

type Json = Record<string, unknown>;
/** Durable actual 10 Hz HTTP read/write evidence, no timer-derived success. */
@Injectable()
export class UpgradeObserver implements OnApplicationBootstrap, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private readonly inFlight: Record<UpgradeProbeLane, number> = {
    gateway: 0,
    source: 0,
    candidate: 0,
  };
  // 20 launches/s leaves headroom above the mandatory 10 Hz floor. A read/write
  // pair has two independent <=2s HTTP deadlines, hence at most 80 live pairs.
  private readonly maxInFlight = 80;
  private retired = false;
  constructor(
    private readonly store: UpgradeStore,
    private readonly inspector: UpgradeInspector,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
    @Inject(SANDBOX_PTY_PORT) private readonly pty: SandboxPtyPort,
    private readonly migrations: UpgradeOnlineMigration,
    private readonly probeEvidence: UpgradeProbeEvidence,
  ) {}
  onApplicationBootstrap(): void {
    if (process.env.PLATFORM_PROCESS_ROLE !== 'coordinator') return;
    this.timer = setInterval(() => {
      if (this.retired || process.env.COORDINATOR_WRITER_FENCE_VALID !== 'true') return;
      try {
        for (const lane of ['gateway', 'source', 'candidate'] as const)
          void withCoordinatorBusinessEpoch(this.store.sqlite, () => this.sample(lane)).catch(
            () => undefined,
          );
      } catch {
        /* A concurrent writer retirement admits no new sample. */
      }
    }, 50);
    this.timer.unref();
  }
  onModuleDestroy(): void {
    this.retired = true;
    if (this.timer) clearInterval(this.timer);
  }
  private acceptsSamples(): boolean {
    return !this.retired && process.env.COORDINATOR_WRITER_FENCE_VALID === 'true';
  }
  private currentScope(
    id: string,
    fence: number,
    binding: Json,
  ): Omit<UpgradeProbeScope, 'origin' | 'artifactDigest' | 'startIdentity'> {
    return {
      instanceId: this.store.instanceId,
      attemptId: id,
      fence,
      routeGeneration: Number(binding.routeGeneration),
      routeWeight: Number(binding.weight),
      coordinatorGeneration: Number(process.env.COORDINATOR_GENERATION),
      observerEpoch: this.probeEvidence.observerEpoch,
    };
  }
  private candidateIdentity(
    snapshot: Pick<ReturnType<UpgradeStore['snapshot']>, 'manifest' | 'appliedSteps'>,
    binding: Json,
  ): UpgradeProbeApiIdentity & { origin: string } {
    const candidate = optionalUpgradeRecord(binding.candidateApi);
    const receipt = optionalUpgradeRecord(
      snapshot.appliedSteps.find((step) => step.stepId === 'candidate')?.evidence,
    );
    requireUpgrade(
      candidate &&
        receipt &&
        candidate.digest === snapshot.manifest.components.api.artifactDigest &&
        receipt.artifactDigest === candidate.digest &&
        receipt.origin === candidate.origin &&
        typeof receipt.startIdentity === 'string' &&
        receipt.startIdentity.length > 0,
      'CANDIDATE_PROBE_IDENTITY_UNKNOWN',
    );
    return {
      instanceId: this.store.instanceId,
      artifactDigest: candidate.digest,
      startIdentity: receipt.startIdentity,
      origin: loopbackOrigin(candidate.origin),
    };
  }
  private sourceIdentity(
    identity: Json,
    binding: Json,
    generation: number,
  ): UpgradeProbeApiIdentity & { origin: string } {
    const source = upgradeRecord(binding.oldApi);
    requireUpgrade(
      identity.instanceId === this.store.instanceId &&
        identity.role === 'control' &&
        identity.artifactDigest === source.digest &&
        typeof identity.startIdentity === 'string' &&
        identity.startIdentity.length > 0 &&
        identity.writerFenceValid === true &&
        identity.coordinatorGeneration === generation,
      'SOURCE_PROBE_IDENTITY_UNKNOWN',
    );
    return {
      instanceId: this.store.instanceId,
      artifactDigest: String(source.digest),
      startIdentity: identity.startIdentity,
      origin: loopbackOrigin(source.origin),
    };
  }
  private async sample(lane: UpgradeProbeLane = 'gateway'): Promise<void> {
    if (this.inFlight[lane] >= this.maxInFlight || !this.acceptsSamples()) return;
    const row = this.store.latestProbeSnapshot();
    if (!row) return;
    const attempt = row.attempt;
    if (row.fence < 1 || row.leaseExpiresAt <= this.clock.now().getTime()) return;
    this.inFlight[lane]++;
    const requestId = this.ids.next();
    let key: string | undefined, scope: UpgradeProbeScope | undefined;
    let at = this.clock.now().getTime(),
      httpLatency = 0,
      success = false;
    const sampleState = { verified: lane === 'gateway', transportFailed: false };
    let completedAt: number | undefined;
    let evidence: Json = {};
    const keepMs =
      row.plan.policy.stageDurationMs +
      row.plan.policy.observationFreshnessMs +
      row.plan.policy.requestDeadlineMs * 3;
    try {
      const binding = await this.inspector.entryBinding();
      if (
        binding.attemptId !== attempt.attemptId ||
        Number(binding.fence) !== row.fence ||
        (lane === 'candidate' && Number(binding.weight) === 0)
      )
        return;
      const common = this.currentScope(attempt.attemptId, row.fence, binding);
      key = this.probeEvidence.currentKey(lane, common);
      const sourceApi = row.sourceActual?.components.api ?? row.sourceActivation.components.api;
      requireUpgrade(
        upgradeRecord(binding.oldApi).digest === sourceApi.artifactDigest,
        'SOURCE_PROBE_ARTIFACT_MISMATCH',
      );
      let identity: (UpgradeProbeApiIdentity & { origin: string }) | undefined;
      if (lane === 'source')
        identity = this.sourceIdentity(
          await this.inspector.controlIdentity(upgradeRecord(binding.oldApi).origin),
          binding,
          common.coordinatorGeneration,
        );
      if (lane === 'candidate') identity = this.candidateIdentity(row, binding);
      const origin = identity?.origin ?? loopbackOrigin(process.env.PLATFORM_ENTRY_ORIGIN);
      scope = {
        ...common,
        origin,
        artifactDigest: identity?.artifactDigest ?? 'stable-entry',
        startIdentity: identity?.startIdentity ?? 'stable-entry',
      };
      key = this.probeEvidence.begin(lane, scope);
      at = this.clock.now().getTime();
      const headers = {
        'content-type': 'application/json',
        'x-platform-internal-key': process.env.PLATFORM_CONTROLLER_RPC_KEY ?? '',
        'x-platform-instance-id': this.store.instanceId,
        'x-operation-id': requestId,
      };
      const value = upgradeDigest({ attemptId: attempt.attemptId, requestId, lane });
      const request = async (url: string, options: RequestInit) => {
        const started = this.clock.now().getTime();
        const response = await fetch(url, {
          ...options,
          headers,
          redirect: 'error',
          signal: AbortSignal.timeout(row.plan.policy.requestDeadlineMs),
        });
        let actual: Json = {};
        try {
          actual = upgradeRecord(await response.json());
        } catch {
          /* Invalid identified JSON is a failed pair. */
        }
        httpLatency = Math.max(httpLatency, this.clock.now().getTime() - started);
        return { response, actual };
      };
      let writeResult: Awaited<ReturnType<typeof request>>,
        readResult: Awaited<ReturnType<typeof request>>;
      try {
        writeResult = await request(origin + '/api/system/upgrade/probe', {
          method: 'POST',
          body: JSON.stringify({
            attemptId: attempt.attemptId,
            fence: row.fence,
            requestId,
            value,
          }),
        });
        readResult = await request(origin + '/api/system/upgrade/probe?requestId=' + requestId, {});
      } catch {
        sampleState.transportFailed = true;
        throw new Error('ACTUAL_PROBE_TRANSPORT_FAILED');
      }
      completedAt = this.clock.now().getTime();
      const { response, actual } = writeResult;
      const { response: read, actual: actualRead } = readResult;
      if (identity) {
        // Legacy source A has no own-response metadata. Its actual private
        // process identity must be unchanged on both sides of this pair.
        if (
          lane === 'source' &&
          !hasProbeIdentity(response.headers) &&
          !hasProbeIdentity(read.headers)
        ) {
          const after = this.sourceIdentity(
            await this.inspector.controlIdentity(origin),
            binding,
            common.coordinatorGeneration,
          );
          sampleState.verified =
            after.startIdentity === identity.startIdentity &&
            after.artifactDigest === identity.artifactDigest;
        } else
          sampleState.verified =
            matchesProbeIdentity(response.headers, identity) &&
            matchesProbeIdentity(read.headers, identity);
      }
      if (!sampleState.verified) {
        this.probeEvidence.unknown(lane, key);
        return;
      }
      success =
        response.ok &&
        read.ok &&
        actual.request_id === requestId &&
        actualRead.request_id === requestId &&
        actual.value === value &&
        actualRead.value === value &&
        actualRead.revision === actual.revision;
      evidence = {
        requestId,
        lane,
        writeStatus: response.status,
        readStatus: read.status,
        actual,
        actualRead,
        pairDurationMs: this.clock.now().getTime() - at,
      };
    } catch {
      completedAt ??= this.clock.now().getTime();
      if (!sampleState.transportFailed && !sampleState.verified && key)
        this.probeEvidence.unknown(lane, key);
      evidence = { requestId, lane, code: 'ACTUAL_PROBE_FAILED' };
    } finally {
      try {
        if (scope && key && this.acceptsSamples()) {
          this.store.assertFence(attempt.attemptId, row.fence);
          const current = await this.inspector.entryBinding();
          const expected = this.currentScope(attempt.attemptId, row.fence, current);
          const api = optionalUpgradeRecord(
            lane === 'candidate' ? current.candidateApi : current.oldApi,
          );
          const unchanged =
            matchesProbeScope(scope, expected) &&
            (lane === 'gateway' ||
              (api?.origin === scope.origin && api.digest === scope.artifactDigest));
          this.store.assertFence(attempt.attemptId, row.fence);
          if (unchanged) {
            const sample = {
              observed_at: at,
              completed_at: completedAt ?? this.clock.now().getTime(),
              latency_ms: success
                ? httpLatency
                : Math.max(httpLatency, (completedAt ?? this.clock.now().getTime()) - at),
              success: Number(success),
              request_id: requestId,
            };
            const recorded = sampleState.transportFailed
              ? this.probeEvidence.transportFailure(lane, key, sample, keepMs)
              : sampleState.verified && this.probeEvidence.record(lane, key, sample, keepMs);
            if (recorded && lane === 'gateway')
              this.store.sqlite
                .prepare(
                  'INSERT INTO upgrade_observations(attempt_id,weight,route_generation,coordinator_generation,observed_at,latency_ms,success,request_id,evidence_digest) VALUES(?,?,?,?,?,?,?,?,?)',
                )
                .run(
                  attempt.attemptId,
                  scope.routeWeight,
                  scope.routeGeneration,
                  scope.coordinatorGeneration,
                  at,
                  sample.latency_ms,
                  Number(success),
                  requestId,
                  upgradeDigest(evidence),
                );
          }
        }
      } finally {
        this.inFlight[lane]--;
      }
    }
  }
  private async attachProof(
    id: string,
    fence: number,
    continuity: Json,
  ): Promise<{ qualified: boolean; maxMs: number }> {
    this.store.assertFence(id, fence);
    if (continuity.qualified !== true) return { qualified: false, maxMs: 0 };
    const resources = upgradeRecords(continuity.resources);
    let maxMs = 0;
    for (const resource of resources) {
      if (!['running', 'idle'].includes(String(resource.status)) || resource.headless === true)
        continue;
      const existing = this.store.sqlite
        .prepare<unknown[], Json>(
          'SELECT * FROM upgrade_attachment_observations WHERE attempt_id=? AND sandbox_id=?',
        )
        .get(id, resource.sandboxId);
      if (existing && existing.runtime_identity === resource.runtimeIdentity) {
        maxMs = Math.max(maxMs, Number(existing.duration_ms));
        continue;
      }
      const started = this.clock.now().getTime();
      const stream = await this.pty.openPty(String(resource.sandboxId), {
        cols: 80,
        rows: 24,
        cmd: ['tmux', '-u', 'attach-session', '-t', PLATFORM_AGENT_TMUX_SESSION],
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          new Promise<void>((ok, fail) => {
            stream.onData(() => {
              ok();
            });
            stream.onConnectionState?.((state) => {
              if (state === 'unconfirmed') fail(new Error('PTY_UNCONFIRMED'));
            });
          }),
          new Promise<never>((_, fail) => {
            timer = setTimeout(() => {
              fail(new Error('PTY_BUDGET_EXCEEDED'));
            }, 5000);
          }),
        ]);
        requireUpgrade(
          stream.runtimeIdentity === resource.runtimeIdentity,
          'ORIGINAL_PTY_IDENTITY_UNCONFIRMED',
        );
        const duration = this.clock.now().getTime() - started;
        this.store.sqlite
          .prepare('INSERT OR REPLACE INTO upgrade_attachment_observations VALUES(?,?,?,?,?)')
          .run(
            id,
            resource.sandboxId,
            resource.runtimeIdentity,
            duration,
            this.clock.now().getTime(),
          );
        maxMs = Math.max(maxMs, duration);
      } finally {
        if (timer) clearTimeout(timer);
        stream.detach();
      }
    }
    return { qualified: true, maxMs };
  }
  async observation(id: string, fence: number, weight: number): Promise<Json> {
    const writer = coordinatorWriterControl(this.store.sqlite);
    writer.assert();
    this.store.assertFence(id, fence);
    const writerGeneration = writer.generation,
      writerFence = writer.fence,
      initialBinding = await this.inspector.entryBinding(),
      initialScope = this.currentScope(id, fence, initialBinding),
      initialBindingDigest = upgradeDigest(persistedBinding(initialBinding));
    const assertAuthority = () => {
      writer.assert();
      this.store.assertFence(id, fence);
      requireUpgrade(
        writer.generation === writerGeneration &&
          writer.fence === writerFence &&
          Number(process.env.COORDINATOR_GENERATION) === writerGeneration,
        'OBSERVATION_SCOPE_CHANGED',
      );
    };
    const currentBinding = async () => {
      assertAuthority();
      const actual = await this.inspector.entryBinding();
      assertAuthority();
      requireUpgrade(
        upgradeDigest(this.currentScope(id, fence, actual)) === upgradeDigest(initialScope) &&
          upgradeDigest(persistedBinding(actual)) === initialBindingDigest,
        'OBSERVATION_SCOPE_CHANGED',
      );
      return actual;
    };
    // Scan every real database snapshot on an independent read-only connection.
    // A synchronous whole-database scan here starves the 20 Hz HTTP sampler.
    // Collect mutable continuity/Owner/Web proofs only after the worker exits.
    assertAuthority();
    const integrityStartedAt = this.clock.now().getTime();
    await verifyMigrationDatabaseIntegrity(this.store.sqlite);
    const binding = await currentBinding(),
      proofStartedAt = this.clock.now().getTime(),
      snapshot = this.store.snapshot(id),
      continuity = await this.inspector.continuity(id, fence);
    const baseRow = requiredUpgradeValue(
      this.store.sqlite
        .prepare<unknown[], { snapshot: string }>(
          'SELECT snapshot FROM upgrade_continuity_baselines WHERE attempt_id=?',
        )
        .get(id),
    );
    const base = upgradeRecord(JSON.parse(baseRow.snapshot));
    let attach = { qualified: false, maxMs: 0 };
    try {
      attach = await this.attachProof(id, fence, continuity);
    } catch {
      /* Original PTY unknown fails the gate. */
    }
    const originals = new Set(upgradeRecords(base.resources).map((r) => r.sandboxId));
    const owner = nullableUpgradeRecord(continuity.owner);
    const operations = Array.isArray(owner?.operations)
      ? upgradeRecords(owner.operations).filter(
          (op) => Date.parse(String(op.dispatchedAt)) >= Date.parse(String(base.observedAt)),
        )
      : null;
    const independentTimeout = (op: Json) =>
      op.method === 'jobs.killJob' &&
      upgradeRecords(base.tasks).some(
        (task) =>
          task.sandbox_id === op.sandboxId &&
          Date.parse(String(op.dispatchedAt)) >=
            Number(task.started_at) * 1000 + Number(task.timeout_ms),
      );
    const independentUserAction = (op: Json) => {
      const dispatched = Date.parse(String(op.dispatchedAt));
      if (op.method === 'jobs.killJob') {
        const originalTasks = upgradeRecords(base.tasks).filter(
          (task) => task.sandbox_id === op.sandboxId,
        );
        if (originalTasks.length !== 1) return false;
        const original = originalTasks[0];
        return Boolean(
          this.store.sqlite
            .prepare(
              'SELECT 1 FROM agent_tasks WHERE id=? AND job_handle=? AND cancel_requested_at IS NOT NULL AND cancel_requested_at*1000<=?',
            )
            .get(original.id, original.job_handle, dispatched),
        );
      }
      return Boolean(
        this.store.sqlite
          .prepare(
            "SELECT 1 FROM sandbox_state_transitions WHERE sandbox_id=? AND triggered_by='user' AND to_status IN ('stopping','destroying','destroyed') AND at*1000<=? AND rowid>?",
          )
          .get(op.sandboxId, dispatched, base.transitionsAfter),
      );
    };
    const unauthorizedStops = operations?.filter(
      (op) =>
        originals.has(op.sandboxId) &&
        ['stop', 'destroy', 'destroyBySandboxId', 'jobs.killJob'].includes(String(op.method)) &&
        upgradeRecord(op.actor).kind !== 'user' &&
        !independentUserAction(op) &&
        !independentTimeout(op),
    ).length;
    const resourceRebuilds = operations?.filter(
      (op) => originals.has(op.sandboxId) && op.method === 'create',
    ).length;
    const duplicates = operations
      ? operations.length - new Set(operations.map((op) => op.id)).size
      : undefined;
    const duplicateOccurrences = requiredUpgradeValue(
      this.store.sqlite
        .prepare<unknown[], { n: number }>(
          'SELECT count(*) n FROM automation_cron_occurrences o LEFT JOIN automation_runs r ON r.id=o.run_id WHERE r.id IS NULL OR r.automation_id<>o.automation_id',
        )
        .get(),
    ).n;
    const ownerAudits = Array.isArray(owner?.owners) ? upgradeRecords(owner.owners) : [];
    const ownerGenerationsValid =
      ownerAudits.length > 0 &&
      ownerAudits.every((audit) => {
        const lease = optionalUpgradeRecord(audit.lease);
        return (
          lease?.generation === Number(process.env.COORDINATOR_GENERATION) &&
          Number(lease.expiresAt ?? lease.leaseExpiresAt) > this.clock.now().getTime()
        );
      });
    const migration = snapshot.plan.migrationPath.migrationPlanDigest
      ? this.migrations.metrics(id)
      : null;
    let webHealth: Json;
    try {
      const web = await this.inspector.webBuild(binding),
        actual = upgradeRecord(binding.web);
      const expected = [
        snapshot.sourceActivation.components.web,
        snapshot.manifest.components.web,
      ].find((w) => w.artifactDigest === actual.digest);
      webHealth = {
        known: true,
        healthy: expected?.webRevision === web.webRevision,
        artifactDigest: actual.digest,
        observedAt: this.clock.now().toISOString(),
      };
    } catch {
      webHealth = { known: false, healthy: false, observedAt: this.clock.now().toISOString() };
    }
    const finalBinding = await currentBinding();
    const now = this.clock.now().getTime(),
      freshness = snapshot.plan.policy.observationFreshnessMs,
      continuityAge = now - Date.parse(String(continuity.observedAt));
    requireUpgrade(
      now >= integrityStartedAt &&
        now - integrityStartedAt <= freshness &&
        now >= proofStartedAt &&
        now - proofStartedAt <= freshness &&
        Number.isFinite(continuityAge) &&
        continuityAge >= -1000 &&
        continuityAge <= freshness,
      'OBSERVATION_STALE',
    );
    const stableBinding =
      upgradeDigest(persistedBinding(finalBinding)) === upgradeDigest(persistedBinding(binding));
    const expected = this.currentScope(id, fence, binding);
    const gateway = this.probeEvidence.read(
      'gateway',
      { ...expected, origin: loopbackOrigin(process.env.PLATFORM_ENTRY_ORIGIN) },
      freshness,
    );
    const oldApi = upgradeRecord(binding.oldApi);
    const expectedSourceApi =
      snapshot.sourceActual?.components.api ?? snapshot.sourceActivation.components.api;
    const source = this.probeEvidence.read(
      'source',
      {
        ...expected,
        origin: loopbackOrigin(oldApi.origin),
        artifactDigest: expectedSourceApi.artifactDigest,
      },
      freshness,
    );
    let candidateExpected: Partial<UpgradeProbeScope> = { ...expected, startIdentity: 'unknown' };
    try {
      candidateExpected = { ...expected, ...this.candidateIdentity(snapshot, binding) };
    } catch {
      /* Missing actual process receipt is unknown. */
    }
    const candidate = this.probeEvidence.read('candidate', candidateExpected, freshness);
    const baselineWindow = Math.min(gateway.windowMs, source.windowMs);
    const windowMs = weight === 0 ? baselineWindow : Math.min(baselineWindow, candidate.windowMs);
    const baselineQualified =
      source.known &&
      gateway.known &&
      baselineWindow >= Math.max(60000, snapshot.plan.policy.stageDurationMs) &&
      source.requests >= snapshot.plan.policy.minRequests &&
      source.failures === 0 &&
      source.maxLatencyMs <= snapshot.plan.policy.requestDeadlineMs;
    return {
      webHealth,
      observedAt: this.clock.now().toISOString(),
      fenceValid: true,
      ownerGenerationsValid,
      routeGenerationValid:
        stableBinding &&
        binding.attemptId === id &&
        Number(binding.fence) === fence &&
        Number(binding.weight) === weight,
      sharedStateHealthy: true, // The uncached read-only worker above completed successfully.
      continuity,
      projectionReads: this.migrations.projectionReadEvidence(),
      invariants: {
        unauthorizedStops,
        resourceRebuilds,
        duplicateCommands: duplicates,
        duplicateOccurrences,
        writerConflicts: process.env.COORDINATOR_WRITER_FENCE_VALID === 'true' ? 0 : 1,
        migrationDifferences: migration ? (migration.known ? migration.differences : undefined) : 0,
        integrityFailures: 0, // The uncached read-only worker above completed successfully.,
      },
      coordinatorGeneration: Number(process.env.COORDINATOR_GENERATION),
      observerEpoch: this.probeEvidence.observerEpoch,
      probes: {
        known: gateway.known,
        hz:
          gateway.windowMs > 0
            ? Math.min(
                snapshot.plan.policy.probeHz,
                (1000 * (gateway.requests - 1)) / gateway.windowMs,
              )
            : 0,
        samples: gateway.requests,
        failures: gateway.failures,
        maxLatencyMs: gateway.maxLatencyMs,
        windowMs: gateway.windowMs,
        attachMaxMs: attach.qualified ? attach.maxMs : snapshot.plan.policy.attachDeadlineMs + 1,
      },
      candidateProbes: {
        known: candidate.known,
        hz:
          candidate.windowMs > 0
            ? Math.min(
                snapshot.plan.policy.probeHz,
                (1000 * (candidate.requests - 1)) / candidate.windowMs,
              )
            : 0,
        samples: candidate.requests,
        failures: candidate.failures,
        maxLatencyMs: candidate.maxLatencyMs,
        windowMs: candidate.windowMs,
      },
      candidate: {
        known: candidate.known,
        requests: candidate.requests,
        errorRate: candidate.errorRate,
        p95Ms: candidate.p95Ms,
        windowMs: candidate.windowMs,
      },
      baseline: {
        known: baselineQualified,
        qualified: baselineQualified,
        requests: source.requests,
        errorRate: source.errorRate,
        p95Ms: source.p95Ms,
        windowMs: baselineWindow,
        failures: source.failures,
        source: source.scope ? { ...source.scope, weight: 0, observedAt: source.observedAt } : null,
      },
      windowMs,
    };
  }
}
