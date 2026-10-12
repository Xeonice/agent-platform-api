import { readFile, lstat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve, isAbsolute, relative } from 'node:path';
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
  for (const file of files) {
    if (
      typeof file.path !== 'string' ||
      isAbsolute(file.path) ||
      file.path.split(/[\\/]/).includes('..')
    )
      throw new Error('OWNER_ARTIFACT_PATH_INVALID');
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
      throw new Error('OWNER_ARTIFACT_CHANGED');
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    if ('sha256:' + hash.digest('hex') !== file.digest) throw new Error('OWNER_ARTIFACT_CHANGED');
  }
  const canonical = (value: unknown): string => {
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
  };
  const actual = 'sha256:' + createHash('sha256').update(canonical(files)).digest('hex');
  if (
    actual !== component.artifactDigest ||
    (process.env.PLATFORM_ARTIFACT_DIGEST && actual !== process.env.PLATFORM_ARTIFACT_DIGEST)
  )
    throw new Error('OWNER_ARTIFACT_DIGEST_MISMATCH');
  return { artifactDigest: actual, inputFingerprint: component.inputFingerprint };
}
