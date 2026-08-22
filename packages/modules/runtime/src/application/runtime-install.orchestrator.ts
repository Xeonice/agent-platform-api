import { Inject, Injectable, Logger } from '@nestjs/common';
import { CLOCK, EVENT_BUS, ID_GENERATOR, UNIT_OF_WORK } from '@platform/shared-kernel';
import type { Clock, EventBus, IdGenerator, UnitOfWork } from '@platform/shared-kernel';
import { RUNTIME_ADAPTER_REGISTRY, RuntimeInstallFailedError } from '@platform/contracts';
import type {
  EnsureRuntimeInstalledInput,
  RuntimeAdapter,
  RuntimeAdapterRegistry,
  RuntimeInstallOrchestrator,
  RuntimeInstallPlan,
  RuntimeInstallStatus,
  SandboxExecFn,
} from '@platform/contracts';
import { RuntimeInstallation } from '../domain/entities/runtime-installation.entity';
import type { RuntimeInstallState } from '../domain/entities/runtime-installation.entity';
import { RUNTIME_INSTALLATION_REPOSITORY } from '../domain/repositories/runtime-installation.repository';
import type { RuntimeInstallationRepository } from '../domain/repositories/runtime-installation.repository';

/**
 * Compile-time parity guard between the DOMAIN state union (which may not import
 * contracts, 23 §4.5) and the WIRE enum. Renaming a value on either side fails
 * typecheck HERE instead of silently emitting a status the frontend cannot render.
 */
type AssertTrue<T extends true> = T;
export type RuntimeInstallStatusParity = AssertTrue<
  [RuntimeInstallState] extends [RuntimeInstallStatus]
    ? [RuntimeInstallStatus] extends [RuntimeInstallState]
      ? true
      : false
    : false
>;

/** A cold `npm i -g @anthropic-ai/claude-code` was measured at 753s (04 §3 ★1). */
const INSTALL_TIMEOUT_MS = 30 * 60_000;
const PROBE_TIMEOUT_MS = 60_000;

/**
 * `ensureRuntimeInstalled` — step ③ of the `starting` 段 (03 §4.3, 26 §1).
 *
 *   getInstallPlan(imageSpec)   pure verdict on the (image, runtime) PAIR
 *   → isInstalled(exec)         a REAL `command -v` probe, never a path guess
 *   → install(exec)             only when absent AND the plan says install-on-start
 *
 * Ordering is fixed by physics, not taste: all three of the later `starting` steps
 * take a `SandboxExecFn`, which derives from `spawn({tty:false})` and therefore
 * requires a RUNNING instance (04 §2.3).
 *
 * WHY THE WRITES LIVE HERE AND NOT IN T1 (13 §2.3.2 / 23 §4.3): `RuntimeInstallation`
 * is its own aggregate, and — decisively — the `installed` verdict needs a probe
 * against a running container, which does not exist at T1 time. Each write below opens
 * its OWN short transaction; none of them ever joins the sandbox create transaction.
 */
@Injectable()
export class RuntimeInstallOrchestratorService implements RuntimeInstallOrchestrator {
  private readonly logger = new Logger('RuntimeInstallOrchestrator');

  constructor(
    @Inject(RUNTIME_ADAPTER_REGISTRY) private readonly registry: RuntimeAdapterRegistry,
    @Inject(RUNTIME_INSTALLATION_REPOSITORY) private readonly repo: RuntimeInstallationRepository,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(EVENT_BUS) private readonly events: EventBus,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
  ) {}

  async ensureInstalled(input: EnsureRuntimeInstalledInput): Promise<void> {
    const adapter = this.adapterFor(input.runtimeId);
    // PURE — no IO. The same call happens on the create path purely to warn the user
    // ("claude-code takes ~12.5 min on this image"); only this one drives behaviour.
    const plan = adapter.getInstallPlan(input.image);
    const present = await this.probeInstalled(adapter, input.exec, input.runtimeId);

    const installation = await this.openRecord(input, present, plan, adapter);
    if (present) return;

    if (plan.strategy !== 'install-on-start') {
      // The image DECLARED the CLI preinstalled and the live probe disagrees. Failing
      // loudly is the point: silently installing anyway would mask a broken image
      // contract behind a 12-minute pause (same discipline as the tmux self-check).
      const reason =
        `image ${input.image.ref} declares '${input.runtimeId}' as ${plan.strategy}, ` +
        'but it is not present in the running sandbox';
      await this.recordFailure(installation, reason);
      throw new RuntimeInstallFailedError(reason);
    }

    await this.transition(installation, (i, now) => i.markInstalling(now));
    try {
      await adapter.install(this.withTimeout(input.exec, INSTALL_TIMEOUT_MS));
    } catch (e) {
      const reason = `installing '${input.runtimeId}' failed: ${(e as Error).message}`;
      await this.recordFailure(installation, reason);
      throw new RuntimeInstallFailedError(reason);
    }
    // Re-probe rather than trusting a zero exit code: `install()` succeeding and the
    // binary being resolvable on PATH are two different claims (04 §2.1★ — codex
    // resolves through an fnm shim, so "npm said ok" proves nothing about lookup).
    if (!(await this.probeInstalled(adapter, input.exec, input.runtimeId))) {
      const reason = `'${input.runtimeId}' is still not on PATH after install`;
      await this.recordFailure(installation, reason);
      throw new RuntimeInstallFailedError(reason);
    }
    const version = await this.detectVersion(plan, input.exec);
    await this.transition(installation, (i, now) => i.markInstalled(version, now));
  }

  private adapterFor(runtimeId: string): RuntimeAdapter {
    if (!this.registry.has(runtimeId)) {
      throw new RuntimeInstallFailedError(`unknown runtime '${runtimeId}'`);
    }
    return this.registry.get(runtimeId);
  }

  private async probeInstalled(
    adapter: RuntimeAdapter,
    exec: SandboxExecFn,
    runtimeId: string,
  ): Promise<boolean> {
    try {
      return await adapter.isInstalled(this.withTimeout(exec, PROBE_TIMEOUT_MS));
    } catch (e) {
      this.logger.warn(`isInstalled probe for '${runtimeId}' threw: ${(e as Error).message}`);
      return false;
    }
  }

  /**
   * Fill `version_detected` (I-RIN-2) from a REAL `--version` run against the binary
   * the PLAN names — so the platform never hard-codes a per-runtime executable.
   */
  private async detectVersion(plan: RuntimeInstallPlan, exec: SandboxExecFn): Promise<string> {
    const binary = plan.requiredBinaries[0];
    if (binary === undefined) return 'unknown';
    try {
      const r = await exec([binary, '--version'], { timeoutMs: PROBE_TIMEOUT_MS });
      const line = r.stdout.split('\n').find((l) => l.trim() !== '');
      return r.exitCode === 0 && line ? line.trim() : 'unknown';
    } catch {
      // I-RIN-2 only demands a non-empty value; refusing to record `installed` because
      // a cosmetic version string was unreadable would fail a sandbox that works.
      return 'unknown';
    }
  }

  /** Open (or re-open, on a re-provision) the record at its probed initial status. */
  private async openRecord(
    input: EnsureRuntimeInstalledInput,
    present: boolean,
    plan: RuntimeInstallPlan,
    adapter: RuntimeAdapter,
  ): Promise<RuntimeInstallation> {
    const version = present ? await this.detectVersion(plan, input.exec) : null;
    const status: RuntimeInstallState = present ? 'installed' : 'not_installed';
    const existing = await this.repo.find(input.sandboxId, input.runtimeId);
    const now = this.clock.now();
    if (existing) {
      // I-RIN-1: one row per (sandbox, runtime) — a restart re-states the same row
      // rather than inserting a second one.
      if (present) existing.markInstalled(version ?? 'unknown', now);
      this.persist(existing);
      return existing;
    }
    const opened = RuntimeInstallation.open({
      id: this.ids.next(),
      sandboxId: input.sandboxId,
      runtimeId: adapter.id,
      status,
      versionDetected: version,
      now,
    });
    this.persist(opened);
    return opened;
  }

  private async transition(
    installation: RuntimeInstallation,
    move: (i: RuntimeInstallation, now: Date) => void,
  ): Promise<void> {
    move(installation, this.clock.now());
    this.persist(installation);
  }

  private async recordFailure(installation: RuntimeInstallation, reason: string): Promise<void> {
    await this.transition(installation, (i, now) => i.markFailed(reason, now));
  }

  /** One SHORT transaction per state change — deliberately never joined to T1. */
  private persist(installation: RuntimeInstallation): void {
    this.uow.run((tx) => {
      this.repo.saveSync(tx, installation);
      this.events.publishInTx(tx, installation.pullEvents());
    });
  }

  /** Apply a default timeout unless the caller already set one (03 §8.3 backstop). */
  private withTimeout(exec: SandboxExecFn, timeoutMs: number): SandboxExecFn {
    return (cmd, opts) => exec(cmd, { timeoutMs, ...(opts ?? {}) });
  }
}
