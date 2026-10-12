import { readFile, lstat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve, relative, isAbsolute } from 'node:path';

function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map(
          (key) => JSON.stringify(key) + ':' + canonical((value as Record<string, unknown>)[key]),
        )
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}
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
    (file) => typeof file.path === 'string' && file.path.startsWith('api/'),
  );
  if (!files.length) throw new Error('INSTALLED_API_ARTIFACT_EMPTY');
  for (const file of files) {
    if (
      typeof file.path !== 'string' ||
      isAbsolute(file.path) ||
      file.path.split(/[\\/]/).includes('..')
    )
      throw new Error('INSTALLED_API_PATH_INVALID');
    const path = resolve(root, file.path),
      rel = relative(root, path),
      stat = await lstat(path);
    if (
      rel.startsWith('..') ||
      isAbsolute(rel) ||
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size !== file.bytes ||
      (stat.mode & 0o777) !== file.mode
    )
      throw new Error('INSTALLED_API_ARTIFACT_CHANGED');
    const hash = createHash('sha256');
    for await (const bytes of createReadStream(path)) hash.update(bytes);
    if ('sha256:' + hash.digest('hex') !== file.digest)
      throw new Error('INSTALLED_API_ARTIFACT_CHANGED');
  }
  const actual = 'sha256:' + createHash('sha256').update(canonical(files)).digest('hex');
  if (
    actual !== identity.artifactDigest ||
    (process.env.PLATFORM_ARTIFACT_DIGEST && actual !== process.env.PLATFORM_ARTIFACT_DIGEST)
  )
    throw new Error('INSTALLED_API_DIGEST_MISMATCH');
  return { artifactDigest: actual, inputFingerprint: identity.inputFingerprint };
}
