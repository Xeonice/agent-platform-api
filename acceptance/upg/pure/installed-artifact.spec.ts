import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  rm,
  realpath,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { verifyInstalledArtifactTree } from '@platform/shared-kernel';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture(): Promise<{ root: string; files: Record<string, unknown>[] }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'upg-artifact-')));
  roots.push(root);
  await mkdir(join(root, 'api/node_modules/.pnpm/one/node_modules/shared'), { recursive: true });
  const regular = [
    [
      'api/node_modules/.pnpm/one/node_modules/shared/index.cjs',
      'module.exports = Symbol("one-instance");',
    ],
    ['api/node_modules/.pnpm/one/node_modules/shared/package.json', '{"main":"index.cjs"}'],
    ['api/package.json', '{"type":"commonjs"}'],
  ];
  const files: Record<string, unknown>[] = [];
  for (const [path, text] of regular) {
    await writeFile(join(root, path), text, { mode: 0o644 });
    files.push({
      path,
      mode: (await lstat(join(root, path))).mode & 0o777,
      digest: 'sha256:' + createHash('sha256').update(text).digest('hex'),
      bytes: Buffer.byteLength(text),
    });
  }
  for (const name of ['first', 'second']) {
    const path = 'api/node_modules/' + name,
      link = '.pnpm/one/node_modules/shared';
    await symlink(link, join(root, path));
    files.push({ path, mode: (await lstat(join(root, path))).mode & 0o777, link });
  }
  files.sort((a, b) => (String(a.path) < String(b.path) ? -1 : 1));
  return { root, files };
}

describe('physical installed production closure', () => {
  it('accepts contained pnpm links and Node resolves aliases to the same DI token', async () => {
    const { root, files } = await fixture();
    expect(await verifyInstalledArtifactTree(root, 'api', files)).toMatch(/^sha256:[a-f0-9]{64}$/);
    const require = createRequire(join(root, 'api/package.json'));
    expect(require('first')).toBe(require('second'));
  });

  it('rejects an extra executable file omitted from the installed manifest', async () => {
    const { root, files } = await fixture();
    await writeFile(
      join(root, 'api/node_modules/.pnpm/one/node_modules/shared/injected.cjs'),
      'evil',
    );
    await expect(verifyInstalledArtifactTree(root, 'api', files)).rejects.toThrow(
      'INSTALLED_ARTIFACT_CHANGED',
    );
  });

  it('rejects changed bytes and file permissions', async () => {
    const { root, files } = await fixture();
    const path = join(root, 'api/package.json');
    await chmod(path, 0o600);
    await expect(verifyInstalledArtifactTree(root, 'api', files)).rejects.toThrow(
      'INSTALLED_ARTIFACT_CHANGED',
    );
    await chmod(path, 0o644);
    await writeFile(path, '{"type":"module"}');
    await expect(verifyInstalledArtifactTree(root, 'api', files)).rejects.toThrow(
      'INSTALLED_ARTIFACT_CHANGED',
    );
  });

  it('rejects a relative link through another link to an external directory', async () => {
    const { root, files } = await fixture();
    const external = await mkdtemp(join(tmpdir(), 'upg-external-'));
    roots.push(external);
    await symlink(external, join(root, 'api/node_modules/bridge'));
    await unlink(join(root, 'api/node_modules/first'));
    await symlink('bridge', join(root, 'api/node_modules/first'));
    await expect(verifyInstalledArtifactTree(root, 'api', files)).rejects.toThrow(
      'INSTALLED_ARTIFACT_LINK_ESCAPE',
    );
  });

  it('rejects a link escaping the API closure into another package component', async () => {
    const { root, files } = await fixture();
    await mkdir(join(root, 'installer'));
    await unlink(join(root, 'api/node_modules/first'));
    await symlink('../../installer', join(root, 'api/node_modules/first'));
    await expect(verifyInstalledArtifactTree(root, 'api', files)).rejects.toThrow(
      'INSTALLED_ARTIFACT_LINK_ESCAPE',
    );
  });

  it('rejects broken and cyclic production links', async () => {
    const { root, files } = await fixture();
    const first = join(root, 'api/node_modules/first');
    await unlink(first);
    await symlink('missing', first);
    await expect(verifyInstalledArtifactTree(root, 'api', files)).rejects.toThrow();
    await unlink(first);
    await symlink('first', first);
    await expect(verifyInstalledArtifactTree(root, 'api', files)).rejects.toThrow();
  });
});
