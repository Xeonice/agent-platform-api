import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { fromEpochMs } from '@platform/shared-kernel';
import {
  UpgradeProbeEvidence,
  type UpgradeProbeScope,
} from '../../../apps/api/src/platform/upgrade/upgrade-probe-evidence';

function fixture() {
  let now = 0;
  const evidence = new UpgradeProbeEvidence({ now: () => fromEpochMs(now) }, { next: randomUUID });
  const scope: UpgradeProbeScope = {
    instanceId: 'memory-proof',
    attemptId: 'attempt',
    fence: 7,
    routeGeneration: 1,
    coordinatorGeneration: 2,
    observerEpoch: evidence.observerEpoch,
    routeWeight: 1,
    origin: 'http://127.0.0.1:1234',
    artifactDigest: 'sha256:' + 'b'.repeat(64),
    startIdentity: 'actual-process-1',
  };
  const key = evidence.begin('candidate', scope);
  const sample = (at: number) => ({
    observed_at: at,
    completed_at: at + 20,
    latency_ms: 20,
    success: 1,
    request_id: randomUUID(),
  });
  return {
    evidence,
    scope,
    key,
    sample,
    time: (value: number) => {
      now = value;
    },
  };
}

describe('UPG process-local rolling proof boundaries', () => {
  it('covers the real 60s boundary at 20Hz while statistics exclude older pairs', () => {
    const f = fixture();
    for (let at = 0; at <= 59950; at += 50) {
      f.time(at + 20);
      f.evidence.record(
        'candidate',
        f.key,
        { ...f.sample(at), success: at === 0 ? 0 : 1, latency_ms: at === 0 ? 1900 : 20 },
        71000,
      );
    }
    expect(f.evidence.read('candidate', f.scope, 5000)).toMatchObject({
      windowMs: 59950,
      requests: 1200,
      failures: 1,
    });
    f.time(60020);
    f.evidence.record('candidate', f.key, f.sample(60000), 71000);
    expect(f.evidence.read('candidate', f.scope, 5000)).toMatchObject({
      windowMs: 60000,
      requests: 1201,
      failures: 1,
    });
    f.time(60070);
    f.evidence.record('candidate', f.key, f.sample(60050), 71000);
    expect(f.evidence.read('candidate', f.scope, 5000)).toMatchObject({
      windowMs: 60000,
      requests: 1201,
      failures: 0,
      maxLatencyMs: 20,
      p95Ms: 20,
    });
  });
  it('invalidates same-millisecond late pairs after unknown identity and fresh scope changes', () => {
    const f = fixture();
    f.evidence.unknown('candidate', f.key);
    expect(f.evidence.record('candidate', f.key, f.sample(0), 71000)).toBe(false);
    const fresh = f.evidence.begin('candidate', f.scope);
    expect(fresh).not.toBe(f.key);
    expect(f.evidence.record('candidate', fresh, f.sample(0), 71000)).toBe(true);
    const next = { ...f.scope, coordinatorGeneration: 3 };
    f.evidence.begin('candidate', next);
    expect(f.evidence.record('candidate', fresh, f.sample(0), 71000)).toBe(false);
    expect(f.evidence.read('candidate', next, 5000)).toMatchObject({
      known: false,
      windowMs: 0,
      requests: 0,
      p95Ms: null,
    });
  });
  it('expires hard transport evidence without attributing it to verified requests', () => {
    const f = fixture();
    f.time(2020);
    f.evidence.transportFailure(
      'candidate',
      f.key,
      { ...f.sample(0), completed_at: 2020, latency_ms: 2020, success: 0 },
      71000,
    );
    expect(f.evidence.read('candidate', f.scope, 5000)).toMatchObject({
      known: false,
      requests: 0,
      failures: 1,
    });
    f.time(72000);
    expect(f.evidence.read('candidate', f.scope, 5000)).toMatchObject({
      known: false,
      requests: 0,
      failures: 0,
      maxLatencyMs: 0,
    });
  });
});
