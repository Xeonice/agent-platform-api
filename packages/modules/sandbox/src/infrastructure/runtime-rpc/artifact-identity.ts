import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { verifyInstalledArtifactTree } from '@platform/shared-kernel';
import { ownerRecord } from './wire-codec';
export interface OwnerArtifactIdentity {
  artifactDigest: string;
  inputFingerprint: string;
}
/** Verify installed physical code; an environment release label is not evidence. */
export async function ownerArtifactIdentity(): Promise<OwnerArtifactIdentity | null> {
  const root = resolve(dirname(process.argv[1] ?? process.cwd()), '../../../../..');
  let bundle: Record<string, unknown>;
  try {
    bundle = ownerRecord(
      JSON.parse(await readFile(resolve(root, 'upgrade-artifact.json'), 'utf8')),
    );
  } catch {
    if (process.env.PLATFORM_ARTIFACT_DIGEST) throw new Error('OWNER_INSTALLED_ARTIFACT_REQUIRED');
    return null;
  }
  const components = ownerRecord(bundle.components),
    component = ownerRecord(components.owner ?? components.api);
  if (
    !Array.isArray(bundle.files) ||
    typeof component.artifactDigest !== 'string' ||
    typeof component.inputFingerprint !== 'string'
  )
    throw new Error('OWNER_ARTIFACT_IDENTITY_UNKNOWN');
  const files = bundle.files.filter(
    (file) =>
      typeof file === 'object' &&
      file !== null &&
      'path' in file &&
      String(file.path).startsWith('api/'),
  ) as Record<string, unknown>[];
  if (!files.length) throw new Error('OWNER_ARTIFACT_EMPTY');
  const actual = await verifyInstalledArtifactTree(root, 'api', files);
  if (
    actual !== component.artifactDigest ||
    (process.env.PLATFORM_ARTIFACT_DIGEST && actual !== process.env.PLATFORM_ARTIFACT_DIGEST)
  )
    throw new Error('OWNER_ARTIFACT_DIGEST_MISMATCH');
  return { artifactDigest: actual, inputFingerprint: component.inputFingerprint };
}
