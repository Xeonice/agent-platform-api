import { isRecord } from '@platform/shared-kernel';
import { z } from 'zod';
import { upgradeRecord } from './upgrade-values';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { lstat, open, readFile, realpath } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { ConfirmedServiceReleaseSchema, type ConfirmedServiceRelease } from '@platform/contracts';
import type { UpgradeStore } from './upgrade-store';
import { canonicalUpgrade, requireUpgrade, upgradeDigest } from './upgrade-trust';
import { verifyUpgradeArtifact } from './verify-upgrade-artifact';
import { observeUpgradeOnce } from './upgrade-observation';

type Components = ConfirmedServiceRelease['components'];
export interface SourceArtifactProof {
  /** The retained process still executes from this original installation. */
  realSourceRoot: string;
  /** A content proof copy is never substituted for a process/mount identity. */
  verificationRoot: string;
  mirrored: boolean;
}
const proofScope = {};
const missing = (error: unknown) => isRecord(error) && error.code === 'ENOENT';
const owned = (uid: number) => !process.getuid || uid === process.getuid() || uid === 0;

async function secureFile(path: string): Promise<void> {
  const stat = await lstat(path);
  requireUpgrade(
    stat.isFile() &&
      !stat.isSymbolicLink() &&
      (stat.mode & 0o022) === 0 &&
      owned(stat.uid) &&
      (await realpath(path)) === path,
    'INSECURE_RETAINED_ARTIFACT_FILE',
  );
}

/** Only an invisible, fixed bootstrap root may use its verified retained package.
 * A visible but corrupt source is a failure, not a reason to try a clean copy. */
export function sourceArtifactProof(
  realSourceRoot: string,
  expected: Components,
  verify: typeof verifyUpgradeArtifact = verifyUpgradeArtifact,
): Promise<SourceArtifactProof> {
  return observeUpgradeOnce(
    proofScope,
    realSourceRoot + ':' + upgradeDigest(expected),
    async () => {
      requireUpgrade(
        isAbsolute(realSourceRoot) && resolve(realSourceRoot) === realSourceRoot,
        'SOURCE_ARTIFACT_ROOT_INVALID',
      );
      try {
        await lstat(realSourceRoot);
      } catch (error) {
        if (!missing(error)) throw error;
        const legacy = process.env.UPGRADE_INITIAL_ARTIFACT_ROOT,
          installer = process.env.UPGRADE_INSTALLER_ROOT,
          hex = basename(realSourceRoot);
        requireUpgrade(
          legacy === realSourceRoot &&
            /^[a-f0-9]{64}$/.test(hex) &&
            installer &&
            isAbsolute(installer) &&
            resolve(installer) === installer,
          'RETAINED_ARTIFACT_MIRROR_UNAVAILABLE',
        );
        const mirror = join(installer, 'artifacts', hex);
        requireUpgrade(mirror !== realSourceRoot, 'RETAINED_ARTIFACT_MIRROR_UNAVAILABLE');
        const installedPath = join(mirror, 'installed.json');
        await secureFile(installedPath);
        const installed = upgradeRecord(JSON.parse(await readFile(installedPath, 'utf8')));
        requireUpgrade(
          installed.packageDigest === 'sha256:' + hex &&
            canonicalUpgrade(installed.components) === canonicalUpgrade(expected),
          'RETAINED_ARTIFACT_IDENTITY_CHANGED',
        );
        // installed.json cannot establish a package identity by self-reporting it.
        // The immutable original bootstrap package is retained beside the mirror.
        const archive = join(installer, 'artifacts', '.retained-packages', hex + '.tgz');
        await secureFile(archive);
        const handle = await open(
          archive,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        try {
          const stat = await handle.stat();
          requireUpgrade(
            stat.isFile() && (stat.mode & 0o022) === 0 && owned(stat.uid),
            'INSECURE_RETAINED_ARTIFACT_FILE',
          );
          const hash = createHash('sha256');
          for await (const chunk of handle.createReadStream({ autoClose: false })) {
            requireUpgrade(
              Buffer.isBuffer(chunk) || typeof chunk === 'string',
              'INSTALLED_ARTIFACT_CHANGED',
            );
            hash.update(chunk);
          }
          requireUpgrade(hash.digest('hex') === hex, 'RETAINED_PACKAGE_DIGEST_CHANGED');
        } finally {
          await handle.close();
        }
        await verify(mirror, expected);
        const bundle = upgradeRecord(
          JSON.parse(await readFile(join(mirror, 'upgrade-artifact.json'), 'utf8')),
        );
        requireUpgrade(
          installed.treeDigest === bundle.treeDigest,
          'RETAINED_ARTIFACT_IDENTITY_CHANGED',
        );
        return { realSourceRoot, verificationRoot: mirror, mirrored: true };
      }
      await verify(realSourceRoot, expected);
      return { realSourceRoot, verificationRoot: realSourceRoot, mirrored: false };
    },
    (value) =>
      z
        .object({ realSourceRoot: z.string(), verificationRoot: z.string(), mirrored: z.boolean() })
        .parse(value),
  );
}

/** An accepted attempt persisted the complete confirmed bootstrap identity.
 * Candidate Coordinators need not mount the bootstrap receipt to read it. */
export async function initialSourceActivation(
  store: UpgradeStore,
): Promise<ConfirmedServiceRelease> {
  const rows = store.sqlite
    .prepare<unknown[], { source_activation: string }>(
      'SELECT source_activation FROM upgrade_attempts WHERE instance_id=? ORDER BY generation ASC',
    )
    .all(store.instanceId);
  requireUpgrade(rows.length > 0, 'INITIAL_SOURCE_ACTIVATION_UNKNOWN');
  const initial = ConfirmedServiceReleaseSchema.parse(JSON.parse(rows[0].source_activation));
  requireUpgrade(initial.activationGeneration === 1, 'INITIAL_SOURCE_ACTIVATION_UNKNOWN');
  for (const row of rows) {
    const release = ConfirmedServiceReleaseSchema.parse(JSON.parse(row.source_activation));
    if (release.activationGeneration === 1)
      requireUpgrade(
        canonicalUpgrade(release) === canonicalUpgrade(initial),
        'INITIAL_SOURCE_ACTIVATION_CHANGED',
      );
  }
  const confirmed = store.confirmed();
  if (confirmed?.activationGeneration === 1)
    requireUpgrade(
      canonicalUpgrade(confirmed) === canonicalUpgrade(initial),
      'INITIAL_SOURCE_ACTIVATION_CHANGED',
    );
  const path = process.env.UPGRADE_INITIAL_RELEASE_PATH;
  if (path) {
    try {
      await lstat(path);
    } catch (error) {
      if (!missing(error)) throw error;
      return initial;
    }
    await secureFile(path);
    const raw = upgradeRecord(JSON.parse(await readFile(path, 'utf8')));
    const receipt = ConfirmedServiceReleaseSchema.parse(raw.release ?? raw);
    requireUpgrade(
      canonicalUpgrade(receipt) === canonicalUpgrade(initial),
      'INITIAL_SOURCE_ACTIVATION_CHANGED',
    );
  }
  return initial;
}
