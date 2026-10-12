import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readlink, realpath, readdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

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

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return !isAbsolute(rel) && rel !== '..' && !rel.startsWith('../');
}

/** Verify the complete physical closure, including contained production package links. */
export async function verifyInstalledArtifactTree(
  root: string,
  prefix: string,
  expected: readonly Record<string, unknown>[],
): Promise<string> {
  if (!/^[a-z][a-z0-9-]*$/.test(prefix) || !expected.length)
    throw new Error('INSTALLED_ARTIFACT_PATH_INVALID');
  const scope = resolve(root, prefix);
  if ((await realpath(scope)) !== scope || !(await lstat(scope)).isDirectory())
    throw new Error('INSTALLED_ARTIFACT_PATH_INVALID');
  const actual: Record<string, unknown>[] = [];
  async function visit(folder: string): Promise<void> {
    for (const name of (await readdir(folder)).sort()) {
      const path = join(folder, name),
        stat = await lstat(path),
        rel = relative(root, path).split('\\').join('/'),
        mode = stat.mode & 0o777;
      if (stat.isSymbolicLink()) {
        const link = await readlink(path);
        if (
          !link ||
          link.includes('\\') ||
          isAbsolute(link) ||
          !inside(scope, resolve(dirname(path), link)) ||
          !inside(scope, await realpath(path))
        )
          throw new Error('INSTALLED_ARTIFACT_LINK_ESCAPE');
        actual.push({ path: rel, mode, link });
      } else if (stat.isDirectory()) {
        await visit(path);
      } else {
        if (!stat.isFile()) throw new Error('INSTALLED_ARTIFACT_SPECIAL_FILE');
        const hash = createHash('sha256');
        let bytes = 0;
        for await (const chunk of createReadStream(path)) {
          hash.update(chunk);
          bytes += chunk.length;
        }
        actual.push({ path: rel, mode, digest: 'sha256:' + hash.digest('hex'), bytes });
      }
    }
  }
  await visit(scope);
  if (canonical(actual) !== canonical(expected)) throw new Error('INSTALLED_ARTIFACT_CHANGED');
  return 'sha256:' + createHash('sha256').update(canonical(actual)).digest('hex');
}
