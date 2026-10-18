import { requiredUpgradeValue } from './upgrade-values';
import { Inject, Injectable } from '@nestjs/common';
import {
  CLOCK,
  ID_GENERATOR,
  type Clock,
  type IdGenerator,
  fromEpochMs,
} from '@platform/shared-kernel';

export type UpgradeProbeLane = 'gateway' | 'source' | 'candidate';
export interface UpgradeProbeScope {
  instanceId: string;
  attemptId: string;
  fence: number;
  routeGeneration: number;
  coordinatorGeneration: number;
  observerEpoch: string;
  routeWeight: number;
  origin: string;
  artifactDigest: string;
  startIdentity: string;
}
export function matchesProbeScope(
  scope: UpgradeProbeScope,
  expected: Partial<UpgradeProbeScope>,
): boolean {
  const values: Record<string, unknown> = { ...scope };
  return Object.entries(expected).every(([field, value]) => values[field] === value);
}
export interface UpgradeHttpSample {
  observed_at: number;
  completed_at: number;
  latency_ms: number;
  success: number;
  request_id: string;
}
interface Cohort {
  scope: UpgradeProbeScope;
  key: string;
  scopeKey: string;
  resetAt: number;
  samples: UpgradeHttpSample[];
  transportFailures: UpgradeHttpSample[];
  verified: boolean;
  keepMs: number;
}

/** Proof is process-local. A restart, route change or unknown identity needs fresh HTTP evidence. */
@Injectable()
export class UpgradeProbeEvidence {
  readonly observerEpoch: string;
  private readonly cohorts = new Map<UpgradeProbeLane, Cohort>();
  constructor(
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
  ) {
    this.observerEpoch = ids.next();
  }
  begin(lane: UpgradeProbeLane, scope: UpgradeProbeScope): string {
    const scopeKey = JSON.stringify(scope);
    const previous = this.cohorts.get(lane);
    if (previous?.scopeKey !== scopeKey)
      this.cohorts.set(lane, {
        scope,
        scopeKey,
        key: this.ids.next(),
        resetAt: this.clock.now().getTime(),
        samples: [],
        transportFailures: [],
        verified: false,
        keepMs: 0,
      });
    return requiredUpgradeValue(this.cohorts.get(lane)).key;
  }
  record(lane: UpgradeProbeLane, key: string, sample: UpgradeHttpSample, keepMs: number): boolean {
    const cohort = this.cohorts.get(lane);
    if (cohort?.key !== key || sample.observed_at < cohort.resetAt) return false;
    cohort.keepMs = keepMs;
    cohort.samples.push(sample);
    cohort.samples = cohort.samples.filter(
      (row) => row.observed_at >= this.clock.now().getTime() - keepMs,
    );
    cohort.verified = true;
    return true;
  }
  transportFailure(
    lane: UpgradeProbeLane,
    key: string,
    sample: UpgradeHttpSample,
    keepMs: number,
  ): boolean {
    const cohort = this.cohorts.get(lane);
    if (cohort?.key !== key || sample.observed_at < cohort.resetAt) return false;
    cohort.keepMs = keepMs;
    cohort.transportFailures.push(sample);
    cohort.transportFailures = cohort.transportFailures.filter(
      (row) => row.observed_at >= this.clock.now().getTime() - keepMs,
    );
    return true;
  }
  unknown(lane: UpgradeProbeLane, key: string): void {
    const cohort = this.cohorts.get(lane);
    if (cohort?.key !== key) return;
    cohort.samples = [];
    cohort.transportFailures = [];
    cohort.verified = false;
    cohort.resetAt = this.clock.now().getTime();
    // Invalidating an unknown group also rejects same-millisecond old pairs.
    cohort.key = this.ids.next();
  }
  currentKey(lane: UpgradeProbeLane, expected: Partial<UpgradeProbeScope>): string | undefined {
    const cohort = this.cohorts.get(lane);
    return cohort && matchesProbeScope(cohort.scope, expected) ? cohort.key : undefined;
  }
  read(
    lane: UpgradeProbeLane,
    expected: Partial<UpgradeProbeScope>,
    freshnessMs: number,
    durationMs = 60000,
  ) {
    const cohort = this.cohorts.get(lane);
    const matches = cohort && matchesProbeScope(cohort.scope, expected);
    if (cohort && matches) {
      const cutoff = this.clock.now().getTime() - cohort.keepMs;
      cohort.samples = cohort.samples.filter((row) => row.observed_at >= cutoff);
      cohort.transportFailures = cohort.transportFailures.filter(
        (row) => row.observed_at >= cutoff,
      );
    }
    const retained = matches
      ? [...cohort.samples].sort((a, b) => a.observed_at - b.observed_at)
      : [];
    const last = retained.at(-1);
    const cutoff = (last?.observed_at ?? this.clock.now().getTime()) - durationMs;
    const samples = retained.filter((row) => row.observed_at >= cutoff);
    const hardFailures = matches
      ? cohort.transportFailures.filter((row) => row.observed_at >= cutoff)
      : [];
    const known = Boolean(
      matches &&
      cohort.verified &&
      last &&
      this.clock.now().getTime() - last.completed_at <= freshnessMs,
    );
    const sorted = samples.map((row) => row.latency_ms).sort((a, b) => a - b);
    // Keep a real pair before the cutoff as coverage evidence. Counting only
    // the rolling rows would otherwise remain at 59.95s at a 20Hz cadence.
    const windowMs =
      retained.length > 1
        ? Math.min(durationMs, requiredUpgradeValue(last).observed_at - retained[0].observed_at)
        : 0;
    return {
      known,
      scope: matches ? cohort.scope : null,
      samples,
      requests: samples.length,
      failures: samples.filter((row) => row.success !== 1).length + hardFailures.length,
      errorRate:
        known && samples.length
          ? samples.filter((row) => row.success !== 1).length / samples.length
          : null,
      p95Ms:
        known && samples.length ? sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] : null,
      maxLatencyMs: Math.max(0, ...sorted, ...hardFailures.map((row) => row.latency_ms)),
      windowMs,
      observedAt: last ? fromEpochMs(last.completed_at).toISOString() : null,
    };
  }
}
