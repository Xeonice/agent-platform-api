import { afterEach, describe, expect, it } from 'vitest';
import { lstat, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConfirmedServiceRelease } from '@platform/contracts';
import { verifyUpgradeArtifact } from '../../../apps/api/src/platform/upgrade/verify-upgrade-artifact';
import { upgradeDigest } from '../../../apps/api/src/platform/upgrade/upgrade-trust';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'upg-full-closure-')));
  roots.push(root);
  const files: Record<string, unknown>[] = [];
  for (const [path, text] of [
    ['api/node_modules/.pnpm/shared/index.js', 'module.exports=1;'],
    ['installer/controller-main.mjs', 'export const installed=true;'],
    ['web/server.js', 'console.log("web");'],
    ['upgrade-migration.json', '{"schemaVersion":1}'],
  ]) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), text);
    files.push({
      path,
      mode: (await lstat(join(root, path))).mode & 0o777,
      bytes: Buffer.byteLength(text),
      digest: 'sha256:' + createHash('sha256').update(text).digest('hex'),
    });
  }
  const path = 'api/node_modules/shared',
    link = '.pnpm/shared';
  await symlink(link, join(root, path));
  files.push({ path, mode: (await lstat(join(root, path))).mode & 0o777, link });
  files.sort((a, b) => String(a.path).localeCompare(String(b.path), 'en'));
  const identity = (prefix: string) => ({
    artifactDigest: upgradeDigest(
      files.filter((file) => String(file.path).startsWith(prefix + '/')),
    ),
    inputFingerprint: upgradeDigest({ input: prefix }),
    sourceRevision: '1'.repeat(40),
    protocol: { min: 1, max: 2 },
  });
  const api = identity('api');
  const components: ConfirmedServiceRelease['components'] = {
    api,
    coordinator: api,
    owner: api,
    installer: identity('installer'),
    web: { ...identity('web'), webRevision: '2'.repeat(40) },
  };
  await writeFile(
    join(root, 'upgrade-artifact.json'),
    JSON.stringify({
      schemaVersion: 1,
      platform: process.platform,
      arch: process.arch,
      components,
      files,
      treeDigest: upgradeDigest(files),
    }),
  );
  return { root, components };
}
describe('whole physical upgrade bundle verification', () => {
  it('accepts a real contained pnpm link plus all actual component trees and declaration', async () => {
    const { root, components } = await fixture();
    await expect(verifyUpgradeArtifact(root, components)).resolves.toBeUndefined();
  });
  it('rejects an unlisted executable inside any component and at the bundle root', async () => {
    for (const path of ['api/extra.js', 'web/extra.js', 'installer/extra.mjs', 'extra.mjs']) {
      const { root, components } = await fixture();
      await writeFile(join(root, path), 'console.log("unlisted");', { mode: 0o755 });
      await expect(verifyUpgradeArtifact(root, components)).rejects.toThrow();
    }
  });
  it('rejects changed root migration bytes instead of proving only API/Web contents', async () => {
    const { root, components } = await fixture();
    await writeFile(join(root, 'upgrade-migration.json'), '{"schemaVersion":9}');
    await expect(verifyUpgradeArtifact(root, components)).rejects.toThrow(
      'INSTALLED_ARTIFACT_CHANGED',
    );
  });
});
