import { assertDefined } from '../../support/assert-defined';
import 'reflect-metadata';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConfirmedServiceRelease } from '@platform/contracts';
import { sourceArtifactProof } from '../../../apps/api/src/platform/upgrade/upgrade-artifact-proof';
import { verifyUpgradeArtifact } from '../../../apps/api/src/platform/upgrade/verify-upgrade-artifact';
import { withUpgradeObservation } from '../../../apps/api/src/platform/upgrade/upgrade-observation';
import { upgradeDigest } from '../../../apps/api/src/platform/upgrade/upgrade-trust';
import { useEnv, stub, unused } from '../../support/strict-ports';
import { UpgradeService } from '../../../apps/api/src/platform/upgrade/upgrade-service';
import { UpgradeInspector } from '../../../apps/api/src/platform/upgrade/upgrade-inspector';
import type { UpgradeSecurity } from '../../../apps/api/src/platform/access-passcode/upgrade-security.service';

const roots: string[] = [],
  restores: (() => void)[] = [];
afterEach(async () => {
  restores
    .splice(0)
    .reverse()
    .forEach((restore) => restore());
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'upg-retained-proof-')));
  roots.push(root);
  const draft = join(root, 'draft'),
    installer = join(root, 'installer');
  await mkdir(draft, { mode: 0o700 });
  const files: Record<string, unknown>[] = [];
  for (const [path, text] of [
    ['api/main.js', 'api'],
    ['web/server.js', 'web'],
    ['installer/controller-main.mjs', 'installer'],
  ]) {
    await mkdir(join(draft, path, '..'), { recursive: true, mode: 0o700 });
    await writeFile(join(draft, path), text, { mode: 0o600 });
    files.push({
      path,
      mode: (await lstat(join(draft, path))).mode & 0o777,
      bytes: Buffer.byteLength(text),
      digest: 'sha256:' + createHash('sha256').update(text).digest('hex'),
    });
  }
  files.sort((a, b) => String(a.path).localeCompare(String(b.path), 'en'));
  const component = (name: string) => ({
    artifactDigest: upgradeDigest(files.filter((file) => String(file.path).startsWith(name + '/'))),
    inputFingerprint: upgradeDigest({ input: name }),
    sourceRevision: '1'.repeat(40),
    protocol: { min: 1, max: 2 },
  });
  const api = component('api'),
    components: ConfirmedServiceRelease['components'] = {
      api,
      coordinator: api,
      owner: api,
      installer: component('installer'),
      web: { ...component('web'), webRevision: '2'.repeat(40) },
    };
  const treeDigest = upgradeDigest(files);
  await writeFile(
    join(draft, 'upgrade-artifact.json'),
    JSON.stringify({
      schemaVersion: 1,
      platform: process.platform,
      arch: process.arch,
      components,
      files,
      treeDigest,
    }),
    { mode: 0o600 },
  );
  const temporaryArchive = join(root, 'package.tgz');
  await promisify(execFile)('tar', ['-czf', temporaryArchive, '-C', draft, '.']);
  const hex = createHash('sha256')
    .update(await readFile(temporaryArchive))
    .digest('hex');
  const source = join(root, 'external-not-mounted', hex),
    mirror = join(installer, 'artifacts', hex),
    archive = join(installer, 'artifacts', '.retained-packages', hex + '.tgz');
  await mkdir(join(installer, 'artifacts', '.retained-packages'), { recursive: true, mode: 0o700 });
  await rename(draft, mirror);
  await rename(temporaryArchive, archive);
  await chmod(archive, 0o400);
  const installed = { packageDigest: 'sha256:' + hex, components, treeDigest };
  await writeFile(join(mirror, 'installed.json'), JSON.stringify(installed), { mode: 0o600 });
  restores.push(
    useEnv({ UPGRADE_INITIAL_ARTIFACT_ROOT: source, UPGRADE_INSTALLER_ROOT: installer }),
  );
  return { root, source, mirror, archive, components, installed };
}

describe('retained source proof copies never replace the executing installation identity', () => {
  it('accepts only a missing fixed legacy root plus the actual retained package, exact tuple and complete physical tree', async () => {
    const f = await fixture();
    await expect(sourceArtifactProof(f.source, f.components)).resolves.toEqual({
      realSourceRoot: f.source,
      verificationRoot: f.mirror,
      mirrored: true,
    });
    const other = join(f.root, 'other', assertDefined(f.source.split('/').at(-1)));
    await expect(sourceArtifactProof(other, f.components)).rejects.toThrow(
      'RETAINED_ARTIFACT_MIRROR_UNAVAILABLE',
    );
  });
  it('uses a visible source directly and rejects a corrupt/missing child rather than borrowing a clean mirror', async () => {
    const f = await fixture();
    await mkdir(f.source, { recursive: true, mode: 0o700 });
    await expect(sourceArtifactProof(f.source, f.components)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await rm(f.source, { recursive: true });
    // A symlink is visible but unsafe; its missing target is no mirror authority.
    await symlink(join(f.root, 'missing'), f.source);
    await expect(sourceArtifactProof(f.source, f.components)).rejects.toThrow(
      'INSECURE_ARTIFACT_ROOT',
    );
  });
  it('verifies the real visible source without requiring a mirror archive', async () => {
    const f = await fixture();
    await mkdir(join(f.source, '..'), { recursive: true, mode: 0o700 });
    await cp(f.mirror, f.source, { recursive: true });
    await rm(f.archive);
    await expect(sourceArtifactProof(f.source, f.components)).resolves.toEqual({
      realSourceRoot: f.source,
      verificationRoot: f.source,
      mirrored: false,
    });
  });
  it.each([
    'identity',
    'tuple',
    'tree',
    'package',
    'installed-tree',
    'package-link',
    'package-missing',
    'extra-file',
  ])('rejects a forged or changed retained %s', async (fault) => {
    const f = await fixture();
    if (fault === 'identity')
      await writeFile(
        join(f.mirror, 'installed.json'),
        JSON.stringify({ ...f.installed, packageDigest: 'sha256:' + 'f'.repeat(64) }),
      );
    if (fault === 'tuple')
      await writeFile(
        join(f.mirror, 'installed.json'),
        JSON.stringify({
          ...f.installed,
          components: {
            ...f.components,
            web: { ...f.components.web, webRevision: 'f'.repeat(40) },
          },
        }),
      );
    if (fault === 'tree') await writeFile(join(f.mirror, 'web/server.js'), 'changed');
    if (fault === 'package') {
      await chmod(f.archive, 0o600);
      await writeFile(f.archive, 'not the signed package');
    }
    if (fault === 'installed-tree')
      await writeFile(
        join(f.mirror, 'installed.json'),
        JSON.stringify({ ...f.installed, treeDigest: 'sha256:' + 'f'.repeat(64) }),
      );
    if (fault === 'package-link') {
      await rename(f.archive, f.archive + '.real');
      await symlink(f.archive + '.real', f.archive);
    }
    if (fault === 'package-missing') await rm(f.archive);
    if (fault === 'extra-file') await writeFile(join(f.mirror, 'api/unlisted.js'), 'extra');
    await expect(sourceArtifactProof(f.source, f.components)).rejects.toThrow();
  });
  it('checks the metadata tuple even when all file digests remain identical', async () => {
    const f = await fixture();
    const changed = {
      ...f.components,
      api: { ...f.components.api, inputFingerprint: upgradeDigest('other-input') },
    };
    await expect(sourceArtifactProof(f.source, changed)).rejects.toThrow(
      'RETAINED_ARTIFACT_IDENTITY_CHANGED',
    );
  });
  it('deduplicates full tree proof within one observation, but rechecks tampering in the next response', async () => {
    const f = await fixture();
    let trees = 0;
    const verify = async (root: string, expected: typeof f.components) => {
      trees++;
      await verifyUpgradeArtifact(root, expected);
    };
    await withUpgradeObservation(async () => {
      await Promise.all([
        sourceArtifactProof(f.source, f.components, verify),
        sourceArtifactProof(f.source, f.components, verify),
      ]);
      expect(trees).toBe(1);
    });
    await writeFile(join(f.mirror, 'web/server.js'), 'changed-after-response');
    await expect(
      withUpgradeObservation(() => sourceArtifactProof(f.source, f.components, verify)),
    ).rejects.toThrow();
    expect(trees).toBe(2);
  });
  it('shares catalog/repair tree inspection within a real status call and starts fresh for its next call', async () => {
    const f = await fixture(),
      clock = { now: () => new Date() };
    const last: ConfirmedServiceRelease = {
      releaseId: '0.3.10',
      activationGeneration: 1,
      activatedAt: clock.now().toISOString(),
      schema: 28,
      channel: 'test',
      components: f.components,
      commits: { api: '1'.repeat(40), web: '2'.repeat(40), project: '3'.repeat(40) },
      productionWebBinding: 'http://127.0.0.1:7000',
    };
    // This boundary fixture measures status orchestration and real tree I/O;
    // it deliberately grants no live-health, repair or runtime qualification.
    const store = stub<ConstructorParameters<typeof UpgradeInspector>[0]>({
      instanceId: 'status-tree-proof',
      confirmed: () => last,
      instance: () => ({
        instance_id: 'status-tree-proof',
        service_state: 'unknown',
        activation_generation: 1,
        ready: 0,
        updated_at: clock.now().getTime(),
        confirmed_release: JSON.stringify(last),
      }),
      latest: () => null,
      recovery: () => null,
    });
    const inspector = new UpgradeInspector(
      store,
      clock,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
    );
    const trees = vi.spyOn(inspector, 'verifyArtifact');
    vi.spyOn(inspector, 'sourceActual').mockImplementation(async () => {
      await inspector.verifySourceArtifact(f.source, f.components);
      return null;
    });
    const catalog = stub<ConstructorParameters<typeof UpgradeService>[1]>({
      refresh: async () => {
        await inspector.sourceActual();
      },
      status: () => ({
        state: 'unknown',
        observedAt: null,
        reason: 'BOUNDARY_FIXTURE',
        availableRelease: null,
      }),
    });
    const security = stub<UpgradeSecurity>({ canAuthenticate: false });
    const service = new UpgradeService(store, catalog, security, inspector, clock);
    const req = unused<Parameters<UpgradeService['status']>[0]>('unused status request'),
      res = stub<Parameters<UpgradeService['status']>[1]>({ setHeader: vi.fn() });
    const granted: ReturnType<UpgradeSecurity['principal']> = {
      actorId: 'status-test-user',
      viewerId: 'status-test-user',
      userScope: 'status-test-user',
      canUpgrade: false,
      csrfToken: '',
    };
    expect((await service.status(req, res, granted)).repairableCurrent).toBeNull();
    expect(trees).toHaveBeenCalledTimes(1);
    await service.status(req, res, granted);
    expect(trees).toHaveBeenCalledTimes(2);
    await writeFile(join(f.mirror, 'api/main.js'), 'changed-after-response');
    await expect(service.status(req, res, granted)).rejects.toThrow('INSTALLED_ARTIFACT_CHANGED');
    expect(trees).toHaveBeenCalledTimes(3);
  });
  it('memoizes sourceActual only within the current observation, including unqualified measurements', async () => {
    const confirmed = vi.fn(() => null),
      latest = vi.fn(() => null);
    const store = stub<ConstructorParameters<typeof UpgradeInspector>[0]>({ confirmed, latest });
    const inspector = new UpgradeInspector(
      store,
      { now: () => new Date() },
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
    );
    await withUpgradeObservation(async () => {
      await Promise.all([inspector.sourceActual(), inspector.sourceActual()]);
    });
    expect(confirmed).toHaveBeenCalledTimes(1);
    await withUpgradeObservation(() => inspector.sourceActual());
    expect(confirmed).toHaveBeenCalledTimes(2);
  });
});
