import { access, lstat, readFile, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, posix, resolve } from 'node:path';
import { SandboxProviderError, SandboxProviderErrorCode } from '@platform/contracts';

/** Read-only kernel witness for both current launch descriptors and immutable
 * legacy launchers. linuxRoot is only the same isolated kernel-file test seam
 * used by the capacity sampler; production always uses '/'. No SDK is opened. */
export async function resolveRuntimeOwnerWorkspaceRoot(
  input: { home: string; workspaceRoot?: string },
  linuxRoot = '/',
): Promise<string> {
  try {
    const home = canonicalPath(input.home);
    let selected: string;
    if (input.workspaceRoot !== undefined) {
      // Only the final trusted launcher supplies this reserved field. Current
      // descriptors need not use the legacy Owner-home naming convention.
      selected = canonicalPath(input.workspaceRoot);
    } else {
      const match =
        /^(.*)\/(?:original-owner|future-owners\/[a-f0-9]{64}\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/.exec(
          home,
        );
      if (!match?.[1]) throw new Error('Unconfirmed legacy Owner layout');
      selected = `${match[1]}/business/workspaces`;
    }
    if (
      !selected.endsWith('/workspaces') ||
      selected.startsWith(home + '/') ||
      home.startsWith(selected + '/') ||
      selected === home ||
      /^\/(?:proc|sys|dev|etc)(?:\/|$)/.test(selected)
    )
      throw new Error('Workspace is not independent of the Owner home');
    if (!isAbsolute(linuxRoot)) throw new Error('Invalid kernel root');
    const mountPath = resolve(linuxRoot, './proc/self/mountinfo');
    const beforeMounts = await readFile(mountPath, 'utf8');
    const mounts = workspaceMounts(beforeMounts);
    const witnessed = (path: string) => {
      const rows = mounts.filter((row) => row.point === path);
      if (rows.length !== 1 || !rows[0].writable) throw new Error('Workspace mount unconfirmed');
      return rows[0];
    };
    witnessed(selected);
    const [homeBefore, selectedBefore] = await Promise.all([directory(home), directory(selected)]);
    await access(selected, constants.W_OK);
    if (homeBefore.dev === selectedBefore.dev && homeBefore.ino === selectedBefore.ino)
      throw new Error('Workspace aliases the Owner home');
    const [afterMounts, homeAfter, selectedAfter] = await Promise.all([
      readFile(mountPath, 'utf8'),
      directory(home),
      directory(selected),
    ]);
    if (
      beforeMounts !== afterMounts ||
      !sameDirectory(homeBefore, homeAfter) ||
      !sameDirectory(selectedBefore, selectedAfter)
    )
      throw new Error('Workspace identity changed');
    return selected;
  } catch {
    throw new SandboxProviderError(
      SandboxProviderErrorCode.PROVIDER_UNAVAILABLE,
      'RuntimeOwner workspace mount could not be confirmed',
      undefined,
      true,
    );
  }
}

function canonicalPath(value: string): string {
  if (
    !isAbsolute(value) ||
    value.length > 4096 ||
    value.includes('\0') ||
    value.split('/').some((part) => part === '..' || part === '.') ||
    posix.normalize(value) !== value
  )
    throw new Error('Invalid workspace path');
  return value;
}

function workspaceMounts(value: string) {
  if (!value.trim() || value.length > 1048576) throw new Error('Invalid mount identity');
  return value
    .trim()
    .split('\n')
    .map((line) => {
      const parts = line.split(' - ');
      if (parts.length !== 2) throw new Error('Invalid mount record');
      const fields = parts[0].split(' '),
        details = parts[1].split(' ');
      if (fields.length < 6 || details.length < 3 || !/^\d+:\d+$/.test(fields[2]))
        throw new Error('Invalid mount record');
      const decode = (path: string) =>
        canonicalPath(
          path.replace(/\\([0-7]{3})/g, (_match, octal: string) =>
            String.fromCharCode(parseInt(octal, 8)),
          ),
        );
      const options = fields[5].split(',');
      return {
        point: decode(fields[4]),
        root: decode(fields[3]),
        device: fields[2],
        writable:
          options.includes('rw') &&
          !options.includes('ro') &&
          !details[2].split(',').includes('ro'),
      };
    });
}

async function directory(path: string) {
  const value = await lstat(path, { bigint: true });
  if (!value.isDirectory() || value.isSymbolicLink() || (await realpath(path)) !== path)
    throw new Error('Unconfirmed workspace directory');
  return value;
}
function sameDirectory(
  a: Awaited<ReturnType<typeof directory>>,
  b: Awaited<ReturnType<typeof directory>>,
) {
  return (
    a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.uid === b.uid && a.gid === b.gid
  );
}
