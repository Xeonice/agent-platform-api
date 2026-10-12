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
import { loopbackOrigin, UpgradeInspector } from './upgrade-inspector';
import { requireUpgrade, upgradeDigest } from './upgrade-trust';
import { UpgradeOnlineMigration } from './upgrade-online-migration';
import { withCoordinatorBusinessEpoch } from '../persistence/coordinator-lease';

type Json = Record<string, unknown>;
interface Sample {
  observed_at: number;
  latency_ms: number;
  success: number;
  route_generation: number;
}
const p95 = (samples: Sample[]): number => {
  const sorted = samples.map((s) => s.latency_ms).sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
};

/** Durable actual 10 Hz HTTP read/write evidence, no timer-derived success. */
@Injectable()
export class UpgradeObserver implements OnApplicationBootstrap, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private inFlight = 0;
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
  ) {}
  onApplicationBootstrap(): void {
    if (process.env.PLATFORM_PROCESS_ROLE !== 'coordinator') return;
    this.timer = setInterval(() => {
      if (this.retired || process.env.COORDINATOR_WRITER_FENCE_VALID !== 'true') return;
      try {
        void withCoordinatorBusinessEpoch(this.store.sqlite, () => this.sample()).catch(
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
  private async sample(): Promise<void> {
    if (
      this.inFlight >= this.maxInFlight ||
      this.retired ||
      process.env.COORDINATOR_WRITER_FENCE_VALID !== 'true'
    )
      return;
    const attempt = this.store.latest();
    if (!attempt) return;
    const row = this.store.snapshot(attempt.attemptId);
    if (row.fence < 1 || row.leaseExpiresAt <= this.clock.now().getTime()) return;
    this.inFlight++;
    const requestId = this.ids.next(),
      at = this.clock.now().getTime(),
      origin = loopbackOrigin(process.env.PLATFORM_ENTRY_ORIGIN);
    let httpLatency = 0;
    let success = false,
      binding: Json | null = null,
      evidence: Json = {};
    try {
      binding = await this.inspector.entryBinding();
      const headers = {
        'content-type': 'application/json',
        'x-platform-internal-key': process.env.PLATFORM_CONTROLLER_RPC_KEY ?? '',
        'x-platform-instance-id': this.store.instanceId,
      };
      const value = upgradeDigest({ attemptId: attempt.attemptId, requestId });
      const writeStarted = this.clock.now().getTime();
      const response = await fetch(origin + '/api/system/upgrade/probe', {
        method: 'POST',
        headers,
        body: JSON.stringify({ attemptId: attempt.attemptId, fence: row.fence, requestId, value }),
        signal: AbortSignal.timeout(row.plan.policy.requestDeadlineMs),
      });
      const actual = (await response.json()) as Json;
      httpLatency = this.clock.now().getTime() - writeStarted;
      const readStarted = this.clock.now().getTime();
      const read = await fetch(origin + '/api/system/upgrade/probe?requestId=' + requestId, {
        headers,
        signal: AbortSignal.timeout(row.plan.policy.requestDeadlineMs),
      });
      const actualRead = (await read.json()) as Json;
      httpLatency = Math.max(httpLatency, this.clock.now().getTime() - readStarted);
      success =
        response.ok &&
        read.ok &&
        actual.request_id === requestId &&
        actual.value === value &&
        actualRead.value === value &&
        actualRead.revision === actual.revision;
      evidence = {
        requestId,
        writeStatus: response.status,
        readStatus: read.status,
        actual,
        actualRead,
        pairDurationMs: this.clock.now().getTime() - at,
      };
    } catch {
      evidence = { requestId, code: 'ACTUAL_PROBE_FAILED' };
    } finally {
      const latency = success
        ? httpLatency
        : Math.max(httpLatency, this.clock.now().getTime() - at);
      try {
        if (!this.retired && process.env.COORDINATOR_WRITER_FENCE_VALID === 'true') {
          // An old async probe may finish after A1->B2->retained A3. The ALS
          // admitted epoch and durable controller fence both remain mandatory.
          this.store.assertFence(attempt.attemptId, row.fence);
          this.store.sqlite
            .prepare(
              'INSERT INTO upgrade_observations(attempt_id,weight,route_generation,coordinator_generation,observed_at,latency_ms,success,request_id,evidence_digest) VALUES(?,?,?,?,?,?,?,?,?)',
            )
            .run(
              attempt.attemptId,
              Number(binding?.weight ?? -1),
              Number(binding?.routeGeneration ?? -1),
              Number(process.env.COORDINATOR_GENERATION),
              at,
              latency,
              Number(success),
              requestId,
              upgradeDigest(evidence),
            );
        }
      } finally {
        this.inFlight--;
      }
    }
  }
  private async attachProof(
    id: string,
    fence: number,
  ): Promise<{ qualified: boolean; maxMs: number }> {
    const continuity = await this.inspector.continuity(id, fence);
    if (continuity.qualified !== true) return { qualified: false, maxMs: 0 };
    const resources = continuity.resources as Json[];
    let maxMs = 0;
    for (const resource of resources) {
      if (!['running', 'idle'].includes(String(resource.status)) || resource.headless === true)
        continue;
      const existing = this.store.sqlite
        .prepare(
          'SELECT * FROM upgrade_attachment_observations WHERE attempt_id=? AND sandbox_id=?',
        )
        .get(id, resource.sandboxId) as Json | undefined;
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
            stream.onData(() => ok());
            stream.onConnectionState?.((state) => {
              if (state === 'unconfirmed') fail(new Error('PTY_UNCONFIRMED'));
            });
          }),
          new Promise<never>((_, fail) => {
            timer = setTimeout(() => fail(new Error('PTY_BUDGET_EXCEEDED')), 5000);
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
    this.store.assertFence(id, fence);
    const snapshot = this.store.snapshot(id),
      binding = await this.inspector.entryBinding(),
      continuity = await this.inspector.continuity(id, fence);
    const samples = this.store.sqlite
      .prepare(
        'SELECT * FROM upgrade_observations WHERE attempt_id=? AND weight=? AND route_generation=? ORDER BY observed_at',
      )
      .all(id, weight, binding.routeGeneration) as Sample[];
    const baseRow = this.store.sqlite
      .prepare('SELECT snapshot FROM upgrade_continuity_baselines WHERE attempt_id=?')
      .get(id) as { snapshot: string };
    const base = JSON.parse(baseRow.snapshot) as Json;
    const baseline = this.store.sqlite
      .prepare(
        'SELECT * FROM upgrade_observations WHERE attempt_id=? AND weight=0 AND coordinator_generation=? ORDER BY observed_at',
      )
      .all(id, base.coordinatorGeneration) as Sample[];
    const windowMs =
      samples.length > 1 ? samples[samples.length - 1].observed_at - samples[0].observed_at : 0;
    let attach = { qualified: false, maxMs: 0 };
    try {
      attach = await this.attachProof(id, fence);
    } catch {
      /* Original PTY unknown fails the gate. */
    }
    const originals = new Set((base.resources as Json[]).map((r) => r.sandboxId));
    const owner = continuity.owner as Json | null;
    const operations = Array.isArray(owner?.operations)
      ? (owner.operations as Json[]).filter(
          (op) => Date.parse(String(op.dispatchedAt)) >= Date.parse(String(base.observedAt)),
        )
      : null;
    const independentTimeout = (op: Json) =>
      op.method === 'jobs.killJob' &&
      (base.tasks as Json[]).some(
        (task) =>
          task.sandbox_id === op.sandboxId &&
          Date.parse(String(op.dispatchedAt)) >=
            Number(task.started_at) * 1000 + Number(task.timeout_ms),
      );
    const independentUserAction = (op: Json) => {
      const dispatched = Date.parse(String(op.dispatchedAt));
      if (op.method === 'jobs.killJob') {
        const originalTasks = (base.tasks as Json[]).filter(
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
        (op.actor as Json)?.kind !== 'user' &&
        !independentUserAction(op) &&
        !independentTimeout(op),
    ).length;
    const resourceRebuilds = operations?.filter(
      (op) => originals.has(op.sandboxId) && op.method === 'create',
    ).length;
    const duplicates = operations
      ? operations.length - new Set(operations.map((op) => op.id)).size
      : undefined;
    const duplicateOccurrences = (
      this.store.sqlite
        .prepare(
          'SELECT count(*) n FROM automation_cron_occurrences o LEFT JOIN automation_runs r ON r.id=o.run_id WHERE r.id IS NULL OR r.automation_id<>o.automation_id',
        )
        .get() as { n: number }
    ).n;
    const integrity = this.store.sqlite.pragma('quick_check', { simple: true }) === 'ok';
    const ownerAudits = Array.isArray(owner?.owners) ? (owner.owners as Json[]) : [];
    const ownerGenerationsValid =
      ownerAudits.length > 0 &&
      ownerAudits.every((audit) => {
        const lease = audit.lease as Json | undefined;
        return Boolean(
          lease &&
          lease.generation === Number(process.env.COORDINATOR_GENERATION) &&
          Number(lease.expiresAt ?? lease.leaseExpiresAt) > this.clock.now().getTime(),
        );
      });
    const enoughBaseline = baseline.length >= snapshot.plan.policy.minRequests;
    const migration = snapshot.plan.migrationPath.migrationPlanDigest
      ? this.migrations.metrics(id)
      : null;
    let webHealth: Json;
    try {
      const web = await this.inspector.webBuild(binding),
        actual = binding.web as Json;
      const expected = [
        snapshot.sourceActivation.components.web,
        snapshot.manifest.components.web,
      ].find((w) => w.artifactDigest === actual.digest);
      webHealth = {
        known: true,
        healthy: Boolean(expected && web.webRevision === expected.webRevision),
        artifactDigest: actual.digest,
        observedAt: this.clock.now().toISOString(),
      };
    } catch {
      webHealth = { known: false, healthy: false, observedAt: this.clock.now().toISOString() };
    }
    return {
      webHealth,
      observedAt: this.clock.now().toISOString(),
      fenceValid: true,
      ownerGenerationsValid,
      routeGenerationValid: Number(binding.fence) === fence && Number(binding.weight) === weight,
      sharedStateHealthy: integrity,
      continuity,
      projectionReads: this.migrations.projectionReadEvidence(),
      invariants: {
        unauthorizedStops,
        resourceRebuilds,
        duplicateCommands: duplicates,
        duplicateOccurrences,
        writerConflicts: process.env.COORDINATOR_WRITER_FENCE_VALID === 'true' ? 0 : 1,
        migrationDifferences: migration ? (migration.known ? migration.differences : undefined) : 0,
        integrityFailures: integrity ? 0 : 1,
      },
      probes: {
        hz:
          windowMs > 0
            ? Math.min(snapshot.plan.policy.probeHz, (1000 * (samples.length - 1)) / windowMs)
            : 0,
        samples: samples.length,
        failures: samples.filter((s) => s.success !== 1).length,
        maxLatencyMs: Math.max(0, ...samples.map((s) => s.latency_ms)),
        attachMaxMs: attach.qualified ? attach.maxMs : snapshot.plan.policy.attachDeadlineMs + 1,
      },
      candidate: {
        requests: samples.length,
        errorRate: samples.length
          ? samples.filter((s) => s.success !== 1).length / samples.length
          : 0,
        p95Ms: p95(samples),
      },
      baseline: {
        requests: baseline.length,
        errorRate: enoughBaseline
          ? baseline.filter((s) => s.success !== 1).length / baseline.length
          : null,
        p95Ms: enoughBaseline ? p95(baseline) : null,
      },
      windowMs,
    };
  }
}
