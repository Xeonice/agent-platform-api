import { isRecord } from '@platform/shared-kernel';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { HttpException } from '@nestjs/common';
import {
  SignedUpgradeManifestSchema,
  UpgradePlanSchema,
  UpgradeTrustRootSchema,
  type ConfirmedServiceRelease,
  type SignedUpgradeManifest,
  type UpgradeManifest,
  type UpgradePlan,
  type UpgradeTrustRoot,
} from '@platform/contracts';
import { compatibleGlobalSchemaPath } from './image-runtime-schema-plan';

export class UpgradeError extends HttpException {
  constructor(
    readonly code: string,
    statusCode = 409,
  ) {
    super({ code, message: code }, statusCode);
  }
}
export function requireUpgrade(condition: unknown, code: string, status = 409): asserts condition {
  if (!condition) throw new UpgradeError(code, status);
}
/** The CD and instance sign/hash precisely these bytes. Never normalize a signed value. */
export function canonicalUpgrade(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return JSON.stringify(value);
  if (typeof value === 'number') {
    requireUpgrade(Number.isFinite(value), 'INVALID_JSON', 400);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalUpgrade).join(',')}]`;
  requireUpgrade(
    isRecord(value) && Object.getPrototypeOf(value) === Object.prototype,
    'INVALID_JSON',
    400,
  );
  const obj = value;
  return `{${Object.keys(obj)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalUpgrade(obj[key])}`)
    .join(',')}}`;
}
export function upgradeDigest(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalUpgrade(value)).digest('hex')}`;
}
export function upgradeRunInputFingerprint(manifest: UpgradeManifest): string {
  return upgradeDigest({
    commits: manifest.commits,
    components: manifest.components,
    packages: manifest.packages.map(({ platform, arch, digest, bytes, format, unpackedBytes }) => ({
      platform,
      arch,
      digest,
      bytes,
      format,
      ...(unpackedBytes === undefined ? {} : { unpackedBytes }),
    })),
    upgradePaths: manifest.upgradePaths,
    policy: {
      ...manifest.policy,
      fallbacks: manifest.policy.fallbacks.map(
        ({ rehearsed: _rehearsed, ...identity }) => identity,
      ),
    },
  });
}
export async function readUpgradeTrustRoot(path: string): Promise<UpgradeTrustRoot> {
  const stat = await lstat(path);
  requireUpgrade(
    stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o022) === 0,
    'INSECURE_TRUST_ROOT',
  );
  requireUpgrade(
    !process.getuid || stat.uid === process.getuid() || stat.uid === 0,
    'TRUST_ROOT_OWNER',
  );
  return UpgradeTrustRootSchema.parse(JSON.parse(await readFile(path, 'utf8')));
}
export function verifyUpgradeEnvelope(
  raw: unknown,
  roots: UpgradeTrustRoot,
  now: number,
): SignedUpgradeManifest {
  // Parse only after verifying the raw manifest, otherwise stripped keys can alter signed bytes.
  requireUpgrade(
    raw !== null &&
      typeof raw === 'object' &&
      'manifest' in raw &&
      'manifestDigest' in raw &&
      'signature' in raw,
    'SIGNATURE_MISSING',
  );
  const signature = raw.signature;
  requireUpgrade(
    signature !== null &&
      typeof signature === 'object' &&
      'keyId' in signature &&
      'value' in signature &&
      'algorithm' in signature &&
      signature.algorithm === 'Ed25519' &&
      typeof signature.value === 'string' &&
      /^[A-Za-z0-9+/]+={0,2}$/.test(signature.value),
    'SIGNATURE_MISSING',
  );
  const trusted = roots.keys.find(
    (key) =>
      key.id === signature.keyId &&
      !key.revoked &&
      (!key.notBefore || Date.parse(key.notBefore) <= now) &&
      (!key.notAfter || Date.parse(key.notAfter) >= now),
  );
  requireUpgrade(trusted, 'UNTRUSTED_SIGNING_KEY');
  const key = createPublicKey(trusted.publicKey);
  const bytes = canonicalUpgrade(raw.manifest);
  const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  requireUpgrade(
    key.asymmetricKeyType === 'ed25519' &&
      raw.manifestDigest === digest &&
      verify(null, Buffer.from(bytes), key, Buffer.from(signature.value, 'base64')),
    'SIGNATURE_OR_MANIFEST_DIGEST_INVALID',
  );
  const envelope = SignedUpgradeManifestSchema.parse(raw);
  const manifest = envelope.manifest;
  const qualification = (manifest.purpose ?? 'release') === 'qualification';
  requireUpgrade(
    (manifest.purpose ?? 'release') === (roots.purpose ?? 'release'),
    'TRUST_PURPOSE_MISMATCH',
  );
  if (qualification) {
    requireUpgrade(
      roots.qualificationInstanceId === process.env.PLATFORM_INSTANCE_ID &&
        manifest.qualification?.instanceId === roots.qualificationInstanceId,
      'QUALIFICATION_INSTANCE_MISMATCH',
    );
    requireUpgrade(
      manifest.qualification?.inputFingerprint === upgradeRunInputFingerprint(manifest),
      'QUALIFICATION_INPUT_MISMATCH',
    );
  } else
    requireUpgrade(
      manifest.qualification === undefined && manifest.policy.fallbacks.every((f) => f.rehearsed),
      'FALLBACK_NOT_REHEARSED',
    );
  requireUpgrade(
    manifest.withdrawn !== true && manifest.channel === roots.channel,
    'RELEASE_WITHDRAWN_OR_WRONG_CHANNEL',
  );
  const names = new Set<string>();
  const platforms = new Set<string>();
  for (const pkg of manifest.packages) {
    const url = new URL(pkg.url);
    requireUpgrade(
      url.protocol === 'https:' &&
        !url.username &&
        !url.password &&
        !url.hash &&
        roots.distributionOrigins.includes(url.origin),
      'UNTRUSTED_DISTRIBUTION_ORIGIN',
    );
    const platform = `${pkg.platform}:${pkg.arch}`;
    requireUpgrade(!names.has(pkg.name) && !platforms.has(platform), 'DUPLICATE_PACKAGE');
    names.add(pkg.name);
    platforms.add(platform);
  }
  requireUpgrade(
    manifest.policy.migrationBatchMs < manifest.policy.requestDeadlineMs,
    'INVALID_BUDGET_POLICY',
  );
  for (const kind of qualification
    ? []
    : ['build', 'contracts', 'four-combinations', 'native-continuity', 'fault-recovery']) {
    requireUpgrade(
      manifest.evidence.some((e) => e.kind === kind && e.result === 'passed'),
      'RELEASE_GATES_MISSING',
    );
  }
  requireUpgrade(
    manifest.evidence.every((e) => e.inputFingerprint === upgradeRunInputFingerprint(manifest)),
    'GATE_INPUT_FINGERPRINT_MISMATCH',
  );
  if (!qualification && manifest.upgradePaths.some((path) => path.migrationPlanDigest)) {
    requireUpgrade(
      manifest.evidence.some(
        (e) =>
          e.kind === 'online-migration' &&
          e.result === 'passed' &&
          e.maxDataTested === true &&
          e.forwardOnlyTested === true,
      ),
      'MIGRATION_GATES_MISSING',
    );
  }
  return envelope;
}
export function freezeUpgradePlan(
  envelope: SignedUpgradeManifest,
  current: ConfirmedServiceRelease,
  appliedBridges: readonly string[] = [],
): UpgradePlan {
  const manifest: UpgradeManifest = envelope.manifest;
  const repairingSameRelease =
    manifest.releaseId === current.releaseId &&
    canonicalUpgrade(manifest.components) !== canonicalUpgrade(current.components);
  requireUpgrade(
    manifest.channel === current.channel &&
      (manifest.releaseId !== current.releaseId || repairingSameRelease),
    'ALREADY_INSTALLED_OR_WRONG_CHANNEL',
  );
  const pkg = manifest.packages.find(
    (p) => p.platform === process.platform && p.arch === process.arch,
  );
  requireUpgrade(pkg, 'UNSUPPORTED_ARCHITECTURE');
  const path = manifest.upgradePaths.find(
    (p) =>
      p.fromRelease === current.releaseId &&
      current.schema >= p.minSchema &&
      current.schema <= p.maxSchema,
  );
  requireUpgrade(path, 'UPGRADE_PATH_NOT_SUPPORTED');
  // The single reviewed additive recipe is the only global-version exception.
  // Neither a shadow read epoch nor arbitrary package SQL proves compatibility.
  requireUpgrade(
    compatibleGlobalSchemaPath(path, current.schema),
    'GLOBAL_SCHEMA_MIGRATION_UNQUALIFIED',
  );
  requireUpgrade(
    path.bridgeReleases.every(
      (release) => release === current.releaseId || appliedBridges.includes(release),
    ),
    'REQUIRED_BRIDGE_NOT_INSTALLED',
  );
  for (const name of ['api', 'web', 'installer', 'coordinator', 'owner'] as const) {
    const live = (
      current.components[name] ?? (name === 'coordinator' ? current.components.api : undefined)
    )?.protocol;
    const next = manifest.components[name]?.protocol;
    if (!live || !next) continue;
    requireUpgrade(live.min <= next.max && live.max >= next.min, 'INCOMPATIBLE_PROTOCOL');
  }
  const apiReused =
    current.components.api.artifactDigest === manifest.components.api.artifactDigest &&
    current.components.api.inputFingerprint === manifest.components.api.inputFingerprint;
  const webReused =
    current.components.web.artifactDigest === manifest.components.web.artifactDigest &&
    current.components.web.inputFingerprint === manifest.components.web.inputFingerprint;
  const liveCoordinator = current.components.coordinator ?? current.components.api;
  const coordinatorReused =
    liveCoordinator.artifactDigest === manifest.components.coordinator.artifactDigest &&
    liveCoordinator.inputFingerprint === manifest.components.coordinator.inputFingerprint;
  const ownerReused =
    !manifest.components.owner ||
    (current.components.owner?.artifactDigest === manifest.components.owner.artifactDigest &&
      current.components.owner.inputFingerprint === manifest.components.owner.inputFingerprint);
  const installerReused =
    current.components.installer.artifactDigest === manifest.components.installer.artifactDigest &&
    current.components.installer.inputFingerprint ===
      manifest.components.installer.inputFingerprint;
  const steps: UpgradePlan['steps'] = [
    { stepId: 'package-download', kind: 'download', artifactName: pkg.name, totalWork: pkg.bytes },
    { stepId: 'package-verify', kind: 'verify', totalWork: 1 },
  ];
  if (!installerReused)
    steps.push({ stepId: 'installer-handoff', kind: 'installer-handoff', totalWork: 1 });
  if (path.migrationPlanDigest)
    steps.push({
      stepId: 'migration',
      kind: 'migration',
      planDigest: path.migrationPlanDigest,
      totalWork: null,
    });
  if (!ownerReused)
    steps.push({ stepId: 'owner-candidate', kind: 'owner-candidate', totalWork: 1 });
  if (!apiReused) steps.push({ stepId: 'candidate', kind: 'candidate', totalWork: 1 });
  if (!coordinatorReused)
    steps.push({ stepId: 'coordinator-handoff', kind: 'coordinator-handoff', totalWork: 1 });
  if (!apiReused) {
    for (const weight of manifest.policy.weights)
      steps.push(
        { stepId: `route-${String(weight)}`, kind: 'route', weight, totalWork: 1 },
        {
          stepId: `observe-${String(weight)}`,
          kind: 'observe',
          weight,
          totalWork: manifest.policy.minRequests,
        },
      );
  }
  if (!webReused) steps.push({ stepId: 'web-bind', kind: 'web', totalWork: 1 });
  steps.push({ stepId: 'activation-confirm', kind: 'activation', totalWork: 1 });
  const plan = {
    schemaVersion: 1,
    releaseId: manifest.releaseId,
    manifestDigest: envelope.manifestDigest,
    package: pkg,
    migrationPath: path,
    apiReused,
    webReused,
    coordinatorReused,
    ownerReused,
    installerReused,
    policy: manifest.policy,
    steps,
    sourceActivationGeneration: current.activationGeneration,
    sourceApiDigest: current.components.api.artifactDigest,
    sourceWebDigest: current.components.web.artifactDigest,
    sourceCoordinatorDigest: liveCoordinator.artifactDigest,
    sourceOwnerDigest: current.components.owner?.artifactDigest ?? null,
    sourceInstallerDigest: current.components.installer.artifactDigest,
    sourceInstallerInputFingerprint: current.components.installer.inputFingerprint,
  };
  return UpgradePlanSchema.parse({ ...plan, planDigest: upgradeDigest(plan) });
}
