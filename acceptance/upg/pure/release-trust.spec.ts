import { generateKeyPairSync, sign } from 'node:crypto';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ConfirmedServiceReleaseSchema,
  UpgradeManifestSchema,
  type UpgradeManifest,
} from '@platform/contracts';
import {
  canonicalUpgrade,
  freezeUpgradePlan,
  upgradeDigest,
  upgradeRunInputFingerprint,
  verifyUpgradeEnvelope,
} from '../../../apps/api/src/platform/upgrade/upgrade-trust';
import { useEnv } from '../../support/strict-ports';

// Cryptographic validation fixtures only. These are NOT real passed native
// reports, installable catalog releases or deployment qualification evidence.
const at = '2026-10-12T02:00:00.000Z';
const key = generateKeyPairSync('ed25519');
const publicKey = key.publicKey.export({ type: 'spki', format: 'pem' }).toString();
let restore: () => void;
beforeEach(() => {
  restore = useEnv({ PLATFORM_INSTANCE_ID: 'trust-test-instance' });
});
afterEach(() => restore());
function artifact(name: string) {
  return {
    artifactDigest: upgradeDigest({ artifact: name }),
    inputFingerprint: upgradeDigest({ input: name }),
    sourceRevision: '1'.repeat(40),
    protocol: { min: 1, max: 2 },
  };
}
function source() {
  return ConfirmedServiceReleaseSchema.parse({
    releaseId: '0.2.0',
    activationGeneration: 1,
    activatedAt: at,
    schema: 28,
    channel: 'unit-test-only',
    components: {
      api: artifact('api-a'),
      web: { ...artifact('web-a'), webRevision: '2'.repeat(40) },
      installer: artifact('installer-a'),
      coordinator: artifact('coordinator-a'),
      owner: artifact('owner-a'),
    },
    commits: { project: '1'.repeat(40), api: '2'.repeat(40), web: '3'.repeat(40) },
    productionWebBinding: 'http://127.0.0.1:4000',
  });
}
function manifest(qualification = false): UpgradeManifest {
  const old = source();
  const value = UpgradeManifestSchema.parse({
    schemaVersion: 2,
    releaseId: '0.2.1',
    channel: old.channel,
    publishedAt: at,
    ...(qualification
      ? {
          purpose: 'qualification',
          qualification: {
            instanceId: 'trust-test-instance',
            inputFingerprint: upgradeDigest({ pending: true }),
          },
        }
      : {}),
    commits: old.commits,
    components: {
      api: artifact('api-b'),
      web: { ...artifact('web-b'), webRevision: '4'.repeat(40) },
      installer: artifact('installer-b'),
      coordinator: artifact('coordinator-b'),
      owner: artifact('owner-b'),
    },
    packages: [
      {
        platform: process.platform,
        arch: process.arch,
        name: 'unit-only-package',
        url: 'https://distribution.invalid/pkg.tar',
        digest: upgradeDigest({ package: 'test-only' }),
        bytes: 1000,
        format: 'native-tar',
      },
    ],
    upgradePaths: [
      {
        fromRelease: old.releaseId,
        minSchema: 28,
        maxSchema: 28,
        targetSchema: 28,
        bridgeReleases: [],
        migrationPlanDigest: null,
      },
    ],
    policy: {
      id: 'unit-only-policy',
      weights: [1, 5, 25, 100],
      stageDurationMs: 60000,
      minRequests: 100,
      observationFreshnessMs: 5000,
      probeHz: 10,
      requestDeadlineMs: 2000,
      attachDeadlineMs: 5000,
      softErrorDelta: 0.01,
      p95Ratio: 2,
      p95FloorMs: 1000,
      evaluationIntervalMs: 10000,
      consecutiveEvaluations: 2,
      retentionMs: 60000,
      migrationBatchMs: 50,
      maxWalBytes: 10000000,
      minFreeBytes: 1000000,
      fallbacks: [
        {
          releaseId: old.releaseId,
          apiDigest: old.components.api.artifactDigest,
          webDigest: old.components.web.artifactDigest,
          rehearsed: !qualification,
        },
      ],
      stopUserResources: false,
      restoreLiveVolume: false,
      contractInUpgrade: false,
    },
    evidence: [],
  });
  const input = upgradeRunInputFingerprint(value);
  if (value.qualification) value.qualification.inputFingerprint = input;
  if (!qualification)
    value.evidence = [
      'build',
      'contracts',
      'four-combinations',
      'native-continuity',
      'fault-recovery',
    ].map((kind) => ({
      kind,
      result: 'passed',
      inputFingerprint: input,
      reportDigest: upgradeDigest({ syntheticUnitValidation: kind }),
      runId: 'unit-validation-only',
      recordedAt: at,
    }));
  return value;
}
function envelope(m: UpgradeManifest) {
  return {
    manifest: m,
    manifestDigest: upgradeDigest(m),
    signature: {
      algorithm: 'Ed25519' as const,
      keyId: 'unit-only-key',
      value: sign(null, Buffer.from(canonicalUpgrade(m)), key.privateKey).toString('base64'),
    },
  };
}
function roots(qualification = false) {
  return {
    schemaVersion: 1 as const,
    channel: 'unit-test-only',
    distributionOrigins: ['https://distribution.invalid'],
    keys: [{ id: 'unit-only-key', publicKey }],
    ...(qualification
      ? { purpose: 'qualification' as const, qualificationInstanceId: 'trust-test-instance' }
      : {}),
  };
}

describe('REQ-UPG-008/009 — actual Ed25519 trust and fixed deployment plans', () => {
  it('repairs a same-release mixed Web tuple only through its explicit signed path, refusing an unchanged installation or borrowing the older path', () => {
    const m = manifest(true);
    const installedB = {
      ...source(),
      releaseId: m.releaseId,
      components: m.components,
      activationGeneration: 2,
    };
    const mixed = {
      ...installedB,
      components: { ...installedB.components, web: source().components.web },
    };
    expect(() => freezeUpgradePlan(envelope(m), installedB)).toThrow(
      'ALREADY_INSTALLED_OR_WRONG_CHANNEL',
    );
    expect(() => freezeUpgradePlan(envelope(m), mixed)).toThrow('UPGRADE_PATH_NOT_SUPPORTED');
    m.upgradePaths.push({ ...m.upgradePaths[0]!, fromRelease: m.releaseId });
    const fixed = freezeUpgradePlan(envelope(m), mixed);
    expect(fixed.migrationPath.fromRelease).toBe(m.releaseId);
    expect(
      fixed.apiReused && fixed.coordinatorReused && fixed.ownerReused && fixed.installerReused,
    ).toBe(true);
    expect(fixed.webReused).toBe(false);
    expect(fixed.steps.map((s) => s.kind)).toEqual(['download', 'verify', 'web', 'activation']);
  });
  it('verifies exact canonical raw bytes and rejects content/digest/signature/key substitutions', () => {
    const signed = envelope(manifest());
    expect(verifyUpgradeEnvelope(signed, roots(), Date.parse(at))).toEqual(signed);
    expect(() =>
      verifyUpgradeEnvelope(
        { ...signed, manifest: { ...signed.manifest, releaseId: '0.2.2' } },
        roots(),
        Date.parse(at),
      ),
    ).toThrow('SIGNATURE_OR_MANIFEST_DIGEST_INVALID');
    expect(() =>
      verifyUpgradeEnvelope(
        { ...signed, manifestDigest: upgradeDigest({ wrong: true }) },
        roots(),
        Date.parse(at),
      ),
    ).toThrow('SIGNATURE_OR_MANIFEST_DIGEST_INVALID');
    expect(() =>
      verifyUpgradeEnvelope(
        {
          ...signed,
          signature: { ...signed.signature, value: Buffer.alloc(64).toString('base64') },
        },
        roots(),
        Date.parse(at),
      ),
    ).toThrow('SIGNATURE_OR_MANIFEST_DIGEST_INVALID');
    expect(() =>
      verifyUpgradeEnvelope(
        signed,
        { ...roots(), keys: [{ id: 'unit-only-key', publicKey, revoked: true }] },
        Date.parse(at),
      ),
    ).toThrow('UNTRUSTED_SIGNING_KEY');
  });
  it('keeps qualification keys instance-bound and cannot turn missing native gates into a production release', () => {
    const q = envelope(manifest(true));
    expect(verifyUpgradeEnvelope(q, roots(true), Date.parse(at))).toEqual(q);
    expect(() => verifyUpgradeEnvelope(q, roots(), Date.parse(at))).toThrow(
      'TRUST_PURPOSE_MISMATCH',
    );
    expect(() =>
      verifyUpgradeEnvelope(
        q,
        { ...roots(true), qualificationInstanceId: 'another-instance' },
        Date.parse(at),
      ),
    ).toThrow('QUALIFICATION_INSTANCE_MISMATCH');
    const noGates = manifest();
    noGates.evidence = [];
    expect(() => verifyUpgradeEnvelope(envelope(noGates), roots(), Date.parse(at))).toThrow(
      'RELEASE_GATES_MISSING',
    );
    const notRehearsed = manifest();
    notRehearsed.policy.fallbacks[0].rehearsed = false;
    expect(() => verifyUpgradeEnvelope(envelope(notRehearsed), roots(), Date.parse(at))).toThrow(
      'FALLBACK_NOT_REHEARSED',
    );
  });
  it('requires package origin, fresh input-bound gates, fixed budgets, upgrade path and live protocol overlap', () => {
    const untrusted = manifest();
    untrusted.packages[0].url = 'https://evil.invalid/package';
    expect(() => verifyUpgradeEnvelope(envelope(untrusted), roots(), Date.parse(at))).toThrow(
      'UNTRUSTED_DISTRIBUTION_ORIGIN',
    );
    const stale = manifest();
    stale.components.api.inputFingerprint = upgradeDigest({ changed: true });
    expect(() => verifyUpgradeEnvelope(envelope(stale), roots(), Date.parse(at))).toThrow(
      'GATE_INPUT_FINGERPRINT_MISMATCH',
    );
    const wrongPath = manifest();
    wrongPath.upgradePaths[0].minSchema = 29;
    expect(() => freezeUpgradePlan(envelope(wrongPath), source())).toThrow(
      'UPGRADE_PATH_NOT_SUPPORTED',
    );
    const incompatible = manifest();
    incompatible.components.coordinator.protocol = { min: 3, max: 3 };
    expect(() => freezeUpgradePlan(envelope(incompatible), source())).toThrow(
      'INCOMPATIBLE_PROTOCOL',
    );
  });
  it('has identical canonical bytes, qualification input and fixed plan to the real CD/controller module', async () => {
    const deploy = await import(resolve('../deploy/upgrade/trust.mjs'));
    const old = source(),
      m = manifest(true),
      signed = envelope(m);
    const apiPlan = freezeUpgradePlan(signed, old);
    const current = {
      instanceId: 'trust-test-instance',
      releaseId: old.releaseId,
      channel: old.channel,
      schema: old.schema,
      generation: old.activationGeneration,
      platform: process.platform,
      arch: process.arch,
      protocols: Object.fromEntries(
        (['api', 'web', 'coordinator', 'owner', 'installer'] as const).map((name) => [
          name,
          old.components[name]!.protocol,
        ]),
      ),
      ...Object.fromEntries(
        (['api', 'web', 'coordinator', 'owner', 'installer'] as const).flatMap((name) => [
          [name + 'Digest', old.components[name]!.artifactDigest],
          [name + 'InputFingerprint', old.components[name]!.inputFingerprint],
        ]),
      ),
    };
    const verified = deploy.verifyManifest(signed, roots(true), current, Date.parse(at));
    expect(deploy.canonical(m)).toBe(canonicalUpgrade(m));
    expect(deploy.runInputFingerprint(m)).toBe(upgradeRunInputFingerprint(m));
    expect(deploy.freezePlan(verified, current)).toEqual(apiPlan);
    expect(apiPlan.steps.map((s) => s.kind)).toContain('installer-handoff');
    expect(apiPlan.steps.map((s) => s.kind)).toContain('coordinator-handoff');
  });
  it('reuses exact artifacts without replacing real component provenance or the three audit SHAs', () => {
    const old = source(),
      m = manifest(true);
    m.components = old.components as UpgradeManifest['components'];
    m.commits = { project: 'a'.repeat(40), api: 'b'.repeat(40), web: 'c'.repeat(40) };
    const plan = freezeUpgradePlan(envelope(m), old);
    expect(plan).toMatchObject({
      apiReused: true,
      webReused: true,
      coordinatorReused: true,
      ownerReused: true,
      installerReused: true,
    });
    expect(plan.steps.map((s) => s.kind)).toEqual(['download', 'verify', 'activation']);
    expect(m.components.api.sourceRevision).toBe(old.components.api.sourceRevision);
    expect(m.commits.api).not.toBe(m.components.api.sourceRevision);
  });
  it('refuses non-JSON/nonfinite canonical inputs rather than hashing lossy representations', () => {
    expect(() => canonicalUpgrade({ x: Number.NaN })).toThrow('INVALID_JSON');
    expect(() => canonicalUpgrade({ x: undefined })).toThrow('INVALID_JSON');
    expect(() => canonicalUpgrade(new Date(at))).toThrow('INVALID_JSON');
    expect(canonicalUpgrade({ b: [2, 1], a: { z: false, y: null } })).toBe(
      '{"a":{"y":null,"z":false},"b":[2,1]}',
    );
  });
});
