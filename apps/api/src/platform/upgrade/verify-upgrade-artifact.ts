import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { verifyInstalledArtifactTree } from '@platform/shared-kernel';
import type { ConfirmedServiceRelease } from '@platform/contracts';
import { canonicalUpgrade, requireUpgrade, upgradeDigest } from './upgrade-trust';

/** Whole installed closure proof; component links must stay within their own physical tree. */
export async function verifyUpgradeArtifact(
  inputRoot: string,
  expected: ConfirmedServiceRelease['components'],
): Promise<void> {
  const root = resolve(inputRoot),
    stat = await lstat(root);
  requireUpgrade(
    stat.isDirectory() &&
      !stat.isSymbolicLink() &&
      (stat.mode & 0o022) === 0 &&
      (await realpath(root)) === root,
    'INSECURE_ARTIFACT_ROOT',
  );
  const metadataPath = join(root, 'upgrade-artifact.json');
  const metadataStat = await lstat(metadataPath);
  requireUpgrade(metadataStat.isFile() && !metadataStat.isSymbolicLink(), 'UNSAFE_ARTIFACT_PATH');
  const bundle = JSON.parse(await readFile(metadataPath, 'utf8')) as Record<string, unknown>;
  requireUpgrade(
    bundle.schemaVersion === 1 &&
      bundle.platform === process.platform &&
      bundle.arch === process.arch &&
      Array.isArray(bundle.files) &&
      canonicalUpgrade(bundle.components) === canonicalUpgrade(expected),
    'INSTALLED_ARTIFACT_METADATA_MISMATCH',
  );
  const files = bundle.files as Record<string, unknown>[];
  const names = new Set<string>();
  for (const file of files) {
    requireUpgrade(
      file &&
        typeof file.path === 'string' &&
        /^(?:api\/|web\/|installer\/|upgrade-migration\.json$)/.test(file.path) &&
        !file.path.includes('\\') &&
        !file.path.split('/').some((part) => !part || part === '.' || part === '..') &&
        !names.has(file.path),
      'UNSAFE_ARTIFACT_PATH',
    );
    names.add(file.path);
  }
  for (const name of await readdir(root)) {
    requireUpgrade(
      ['api', 'web', 'installer', 'upgrade-artifact.json', 'installed.json'].includes(name) ||
        (name === 'upgrade-migration.json' && names.has(name)),
      'INSTALLED_ARTIFACT_EXTRA_FILE',
    );
  }
  const actual: Record<string, string> = {};
  for (const scope of ['api', 'web', 'installer'] as const) {
    actual[scope] = await verifyInstalledArtifactTree(
      root,
      scope,
      files.filter((file) => String(file.path).startsWith(scope + '/')),
    );
  }
  const declaration = files.find((file) => file.path === 'upgrade-migration.json');
  if (declaration) {
    const path = join(root, 'upgrade-migration.json'),
      s = await lstat(path);
    requireUpgrade(
      s.isFile() &&
        !s.isSymbolicLink() &&
        s.size === declaration.bytes &&
        (s.mode & 0o777) === declaration.mode &&
        typeof declaration.digest === 'string' &&
        !('link' in declaration),
      'INSTALLED_ARTIFACT_CHANGED',
    );
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    requireUpgrade(
      'sha256:' + hash.digest('hex') === declaration.digest,
      'INSTALLED_ARTIFACT_CHANGED',
    );
  }
  requireUpgrade(
    upgradeDigest(files) === bundle.treeDigest &&
      actual.api === expected.api.artifactDigest &&
      actual.web === expected.web.artifactDigest &&
      actual.installer === expected.installer.artifactDigest &&
      (!expected.coordinator || actual.api === expected.coordinator.artifactDigest) &&
      (!expected.owner || actual.api === expected.owner.artifactDigest),
    'INSTALLED_COMPONENT_DIGEST_MISMATCH',
  );
}
