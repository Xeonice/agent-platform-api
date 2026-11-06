import { generateKeyPairSync, sign } from 'node:crypto';
import {
  ConfirmedServiceReleaseSchema,
  UpgradeManifestSchema,
  type ConfirmedServiceRelease,
} from '@platform/contracts';
import {
  canonicalUpgrade,
  upgradeDigest,
  upgradeRunInputFingerprint,
} from '../../apps/api/src/platform/upgrade/upgrade-trust';

// Crypto/state boundary fixtures only. Synthetic report identities are never
// submitted to a real installer or represented as production qualification.
const key = generateKeyPairSync('ed25519');
export const planFixtureAt = '2026-10-18T08:00:00.000Z';
export function planFixtureArtifact(label: string) {
  return {
    artifactDigest: upgradeDigest({ label }),
    inputFingerprint: upgradeDigest({ input: label }),
    sourceRevision: '1'.repeat(40),
    protocol: { min: 1, max: 2 },
  };
}
export function planFixtureSource(schema = 29): ConfirmedServiceRelease {
  return ConfirmedServiceReleaseSchema.parse({
    releaseId: '0.2.0',
    activationGeneration: 1,
    activatedAt: planFixtureAt,
    schema,
    channel: 'upgrade-plan-fixture',
    components: {
      api: planFixtureArtifact('old-api'),
      coordinator: planFixtureArtifact('old-coordinator'),
      owner: planFixtureArtifact('old-owner'),
      installer: planFixtureArtifact('old-installer'),
      web: { ...planFixtureArtifact('old-web'), webRevision: '2'.repeat(40) },
    },
    commits: { project: '1'.repeat(40), api: '2'.repeat(40), web: '3'.repeat(40) },
    productionWebBinding: 'http://127.0.0.1:4000',
  });
}
export function planFixtureEnvelope(
  source: ConfirmedServiceRelease,
  releaseId: string,
  bridges: string[] = [],
  capable = true,
) {
  const manifest = UpgradeManifestSchema.parse({
    schemaVersion: 2,
    releaseId,
    channel: source.channel,
    publishedAt: planFixtureAt,
    commits: source.commits,
    components: {
      api: planFixtureArtifact(releaseId + '-api'),
      coordinator: {
        ...planFixtureArtifact(releaseId + '-coordinator'),
        ...(capable ? { upgradeOperationFormats: ['upgrade-plan-v1'] } : {}),
      },
      owner: source.components.owner,
      installer: source.components.installer,
      web: source.components.web,
    },
    packages: [
      {
        platform: process.platform,
        arch: process.arch,
        name: 'fixture-' + releaseId,
        url: 'https://distribution.invalid/' + releaseId + '.tgz',
        digest: upgradeDigest({ package: releaseId }),
        bytes: 1000,
        format: 'native-tar',
      },
    ],
    upgradePaths: [
      {
        fromRelease: source.releaseId,
        minSchema: source.schema,
        maxSchema: source.schema,
        targetSchema: source.schema,
        bridgeReleases: bridges,
        migrationPlanDigest: null,
      },
    ],
    policy: {
      id: 'fixture-only',
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
      migrationBatchMs: 500,
      maxWalBytes: 1048576,
      minFreeBytes: 1048576,
      fallbacks: [
        {
          releaseId: source.releaseId,
          apiDigest: source.components.api.artifactDigest,
          webDigest: source.components.web.artifactDigest,
          rehearsed: true,
        },
      ],
      stopUserResources: false,
      restoreLiveVolume: false,
      contractInUpgrade: false,
    },
    evidence: [],
  });
  const inputFingerprint = upgradeRunInputFingerprint(manifest);
  manifest.evidence = [
    'build',
    'contracts',
    'four-combinations',
    'native-continuity',
    'fault-recovery',
  ].map((kind) => ({
    kind,
    result: 'passed' as const,
    inputFingerprint,
    reportDigest: upgradeDigest({ syntheticBoundaryFixture: kind }),
    runId: 'boundary-fixture-only',
    recordedAt: planFixtureAt,
  }));
  return {
    manifest,
    manifestDigest: upgradeDigest(manifest),
    signature: {
      algorithm: 'Ed25519' as const,
      keyId: 'fixture-only',
      value: sign(null, Buffer.from(canonicalUpgrade(manifest)), key.privateKey).toString('base64'),
    },
  };
}
export function planFixtureRoots() {
  return {
    schemaVersion: 1 as const,
    channel: 'upgrade-plan-fixture',
    distributionOrigins: ['https://distribution.invalid'],
    keys: [
      {
        id: 'fixture-only',
        publicKey: key.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      },
    ],
  };
}
