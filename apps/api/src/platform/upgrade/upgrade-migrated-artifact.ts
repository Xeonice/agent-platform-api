import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { lstat, open, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { type Clock, verifyInstalledArtifactTree } from '@platform/shared-kernel';
import type { ConfirmedServiceRelease } from '@platform/contracts';
import {
  canonicalUpgrade,
  readUpgradeTrustRoot,
  requireUpgrade,
  upgradeDigest,
  verifyUpgradeEnvelope,
} from './upgrade-trust';
import { verifyUpgradeArtifact } from './verify-upgrade-artifact';
import { upgradeRecord, upgradeRecords } from './upgrade-values';

const receiptSchema = z
  .object({
    schemaVersion: z.literal(1),
    instanceId: z.string().min(1).max(64),
    artifactRoot: z.string(),
    signedManifest: z.unknown(),
    packageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    controlArtifactRoot: z.string(),
    archivePath: z.string(),
  })
  .strict();
const absolute = (path: string) =>
  isAbsolute(path) && resolve(path) === path && !/[\r\n\0]/.test(path);
const owner = (uid: number) => !process.getuid || uid === process.getuid() || uid === 0;
const stamp = (s: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }) =>
  [s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs].join(':');
async function checkedFile(path: string, maximum: number) {
  requireUpgrade(absolute(path), 'MIGRATED_SOURCE_PATH_INVALID');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    requireUpgrade(
      before.isFile() &&
        before.size <= maximum &&
        (before.mode & 0o077) === 0 &&
        owner(before.uid) &&
        (await realpath(path)) === path,
      'MIGRATED_SOURCE_FILE_INSECURE',
    );
    const bytes = await handle.readFile(),
      after = await handle.stat(),
      current = await lstat(path);
    requireUpgrade(
      bytes.length <= maximum &&
        stamp(before) === stamp(after) &&
        stamp(after) === stamp(current) &&
        !current.isSymbolicLink(),
      'MIGRATED_SOURCE_FILE_CHANGED',
    );
    return bytes;
  } finally {
    await handle.close();
  }
}

/** Migration installation provenance is a source candidate, never a confirmed
 * release or a version-chain anchor. Only the Coordinator reads this fixed
 * administrator file; the independent Agent uses its semantic inspection port. */
export async function migratedSourceArtifact({
  instanceId,
  clock,
  installerProgramRoot,
}: {
  instanceId: string;
  clock: Clock;
  installerProgramRoot: unknown;
}): Promise<{
  root: string;
  components: ConfirmedServiceRelease['components'];
  provenanceVerified: true;
} | null> {
  const path = process.env.UPGRADE_MIGRATED_ARTIFACT_PATH;
  if (!path) return null;
  const binding = process.env.PLATFORM_COORDINATOR_BINDING_PATH,
    installer = process.env.UPGRADE_INSTALLER_ROOT,
    trust = process.env.UPGRADE_TRUST_ROOT_PATH;
  requireUpgrade(
    binding &&
      absolute(binding) &&
      path === join(dirname(binding), 'migration-source.json') &&
      installer &&
      absolute(installer) &&
      trust,
    'MIGRATED_SOURCE_SCOPE_INVALID',
  );
  const raw = await checkedFile(path, 1024 * 1024),
    receipt = receiptSchema.parse(JSON.parse(raw.toString('utf8')));
  requireUpgrade(
    receipt.instanceId === instanceId &&
      absolute(receipt.artifactRoot) &&
      absolute(receipt.controlArtifactRoot) &&
      receipt.artifactRoot !== receipt.controlArtifactRoot &&
      receipt.archivePath ===
        join(installer, 'artifacts', receipt.packageDigest.slice(7) + '.tgz') &&
      typeof installerProgramRoot === 'string' &&
      installerProgramRoot === join(receipt.controlArtifactRoot, 'installer'),
    'MIGRATED_SOURCE_SCOPE_INVALID',
  );
  const roots = await readUpgradeTrustRoot(trust),
    envelope = verifyUpgradeEnvelope(receipt.signedManifest, roots, clock.now().getTime());
  const packages = envelope.manifest.packages.filter(
    (pkg) =>
      pkg.platform === process.platform &&
      pkg.arch === process.arch &&
      pkg.digest === receipt.packageDigest &&
      pkg.format === 'native-tar',
  );
  requireUpgrade(packages.length === 1, 'MIGRATED_SOURCE_PACKAGE_SCOPE_INVALID');
  const pkg = packages[0];
  requireUpgrade(pkg, 'MIGRATED_SOURCE_PACKAGE_SCOPE_INVALID');
  const installed = upgradeRecord(
    JSON.parse(
      (await checkedFile(join(receipt.artifactRoot, 'installed.json'), 1024 * 1024)).toString(
        'utf8',
      ),
    ),
  );
  requireUpgrade(
    installed.packageDigest === pkg.digest &&
      canonicalUpgrade(installed.components) === canonicalUpgrade(envelope.manifest.components),
    'MIGRATED_SOURCE_INSTALLED_RECEIPT_MISMATCH',
  );
  // Retain and hash the actual package. installed.json is not sufficient
  // evidence of a package digest merely because it repeats the signed name.
  const archive = await open(
    receipt.archivePath,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = await archive.stat();
    requireUpgrade(
      before.isFile() &&
        before.size === pkg.bytes &&
        (before.mode & 0o022) === 0 &&
        owner(before.uid) &&
        (await realpath(receipt.archivePath)) === receipt.archivePath,
      'MIGRATED_SOURCE_ARCHIVE_INSECURE',
    );
    let bytes = 0;
    const hash = createHash('sha256');
    for await (const chunk of archive.createReadStream({ autoClose: false })) {
      requireUpgrade(Buffer.isBuffer(chunk), 'MIGRATED_SOURCE_ARCHIVE_CHANGED');
      bytes += chunk.length;
      requireUpgrade(bytes <= pkg.bytes, 'MIGRATED_SOURCE_ARCHIVE_CHANGED');
      hash.update(chunk);
    }
    const after = await archive.stat(),
      current = await lstat(receipt.archivePath);
    requireUpgrade(
      bytes === pkg.bytes &&
        'sha256:' + hash.digest('hex') === pkg.digest &&
        stamp(before) === stamp(after) &&
        stamp(after) === stamp(current) &&
        !current.isSymbolicLink(),
      'MIGRATED_SOURCE_ARCHIVE_CHANGED',
    );
  } finally {
    await archive.close();
  }
  await verifyUpgradeArtifact(receipt.artifactRoot, envelope.manifest.components);
  // The independent engine runs from its own immutable package. Prove its
  // complete installer subtree against the same signed business component;
  // no arbitrary control package or self-reported component is admitted.
  const controlStat = await lstat(receipt.controlArtifactRoot);
  requireUpgrade(
    controlStat.isDirectory() &&
      !controlStat.isSymbolicLink() &&
      (controlStat.mode & 0o022) === 0 &&
      owner(controlStat.uid) &&
      (await realpath(receipt.controlArtifactRoot)) === receipt.controlArtifactRoot,
    'MIGRATED_SOURCE_CONTROL_ROOT_INSECURE',
  );
  const bundle = upgradeRecord(
      JSON.parse(
        (
          await checkedFile(join(receipt.artifactRoot, 'upgrade-artifact.json'), 16 * 1024 * 1024)
        ).toString('utf8'),
      ),
    ),
    files = upgradeRecords(bundle.files);
  requireUpgrade(
    installed.treeDigest === bundle.treeDigest && upgradeDigest(files) === bundle.treeDigest,
    'MIGRATED_SOURCE_INSTALLED_RECEIPT_MISMATCH',
  );
  const actual = await verifyInstalledArtifactTree(
    receipt.controlArtifactRoot,
    'installer',
    files.filter((file) => String(file.path).startsWith('installer/')),
  );
  requireUpgrade(
    actual === envelope.manifest.components.installer.artifactDigest,
    'MIGRATED_SOURCE_CONTROL_ENGINE_CHANGED',
  );
  requireUpgrade(
    (await checkedFile(path, 1024 * 1024)).equals(raw),
    'MIGRATED_SOURCE_FILE_CHANGED',
  );
  return {
    root: receipt.artifactRoot,
    components: envelope.manifest.components,
    provenanceVerified: true,
  };
}
