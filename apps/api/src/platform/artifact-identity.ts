import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { verifyInstalledArtifactTree } from '@platform/shared-kernel';

/** Startup proof of the installed API tree, independent of DB/SDK/role labels. */
export async function installedApiIdentity(
  component: 'api' | 'coordinator',
): Promise<{ artifactDigest: string; inputFingerprint: string } | null> {
  const root = resolve(dirname(process.argv[1] ?? process.cwd()), '../../../../..');
  let bundle: Record<string, unknown>;
  try {
    bundle = JSON.parse(await readFile(resolve(root, 'upgrade-artifact.json'), 'utf8')) as Record<
      string,
      unknown
    >;
  } catch {
    if (process.env.PLATFORM_ARTIFACT_DIGEST) throw new Error('INSTALLED_API_ARTIFACT_REQUIRED');
    return null;
  }
  const components = bundle.components as Record<
    string,
    { artifactDigest?: unknown; inputFingerprint?: unknown }
  >;
  const identity = components?.[component];
  if (
    !identity ||
    typeof identity.artifactDigest !== 'string' ||
    typeof identity.inputFingerprint !== 'string' ||
    !Array.isArray(bundle.files)
  )
    throw new Error('INSTALLED_API_IDENTITY_UNKNOWN');
  const files = (bundle.files as Record<string, unknown>[]).filter(
    (file) => file && typeof file.path === 'string' && file.path.startsWith('api/'),
  );
  if (!files.length) throw new Error('INSTALLED_API_ARTIFACT_EMPTY');
  const actual = await verifyInstalledArtifactTree(root, 'api', files);
  if (
    actual !== identity.artifactDigest ||
    (process.env.PLATFORM_ARTIFACT_DIGEST && actual !== process.env.PLATFORM_ARTIFACT_DIGEST)
  )
    throw new Error('INSTALLED_API_DIGEST_MISMATCH');
  return { artifactDigest: actual, inputFingerprint: identity.inputFingerprint };
}
