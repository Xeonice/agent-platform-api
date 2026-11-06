import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  lstat,
  cp,
  rm,
  realpath,
  chmod,
} from 'node:fs/promises';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fromEpochMs } from '@platform/shared-kernel';
import { UpgradeManifestSchema, type ConfirmedServiceRelease } from '@platform/contracts';
import { migratedSourceArtifact } from '../../../apps/api/src/platform/upgrade/upgrade-migrated-artifact';
import {
  canonicalUpgrade,
  upgradeDigest,
  upgradeRunInputFingerprint,
} from '../../../apps/api/src/platform/upgrade/upgrade-trust';
import { planFixtureEnvelope, planFixtureSource } from '../../support/upgrade-plan-fixture';
import { useEnv } from '../../support/strict-ports';

let directory: string, restore: () => void;
const instanceId = 'migrated-source-boundary-fixture',
  clock = { now: () => fromEpochMs(Date.now()) };
async function fixture() {
  const artifactRoot = join(directory, 'business-artifact'),
    controlArtifactRoot = join(directory, 'control-artifact'),
    bindings = join(directory, 'bindings'),
    installer = join(directory, 'installer');
  for (const path of [artifactRoot, controlArtifactRoot, bindings, join(installer, 'artifacts')])
    await mkdir(path, { mode: 0o700, recursive: true });
  const files: Array<Record<string, unknown>> = [];
  for (const [path, text] of [
    ['api/main.js', 'actual api boundary bytes'],
    ['web/server.js', 'actual web boundary bytes'],
    ['installer/controller-main.mjs', 'actual installer boundary bytes'],
  ]) {
    const file = join(artifactRoot, path);
    await mkdir(join(file, '..'), { recursive: true, mode: 0o700 });
    await writeFile(file, text, { mode: 0o600 });
    files.push({
      path,
      mode: (await lstat(file)).mode & 0o777,
      bytes: Buffer.byteLength(text),
      digest: 'sha256:' + createHash('sha256').update(text).digest('hex'),
    });
  }
  files.sort((a, b) => String(a.path).localeCompare(String(b.path)));
  const part = (name: string) => ({
    artifactDigest: upgradeDigest(files.filter((file) => String(file.path).startsWith(name + '/'))),
    inputFingerprint: upgradeDigest({ input: name }),
    sourceRevision: '1'.repeat(40),
    protocol: { min: 1, max: 2 },
  });
  const api = part('api'),
    components: ConfirmedServiceRelease['components'] = {
      api,
      coordinator: api,
      owner: api,
      installer: part('installer'),
      web: { ...part('web'), webRevision: '2'.repeat(40) },
    };
  const bundle = {
    schemaVersion: 1,
    platform: process.platform,
    arch: process.arch,
    components,
    files,
    treeDigest: upgradeDigest(files),
  };
  await writeFile(join(artifactRoot, 'upgrade-artifact.json'), JSON.stringify(bundle), {
    mode: 0o600,
  });
  await cp(join(artifactRoot, 'installer'), join(controlArtifactRoot, 'installer'), {
    recursive: true,
  });
  // This tests signature/package/tree boundary only. The byte fixture is never
  // submitted to a real installer and is not a native or release qualification.
  const bytes = Buffer.from('boundary package identity bytes'),
    packageDigest = 'sha256:' + createHash('sha256').update(bytes).digest('hex'),
    archivePath = join(installer, 'artifacts', packageDigest.slice(7) + '.tgz');
  await writeFile(archivePath, bytes, { mode: 0o600 });
  if (process.platform !== 'linux' && process.platform !== 'darwin')
    throw new Error('Unsupported boundary fixture platform');
  if (process.arch !== 'arm64' && process.arch !== 'x64')
    throw new Error('Unsupported boundary fixture architecture');
  const base = planFixtureEnvelope(planFixtureSource(), '0.2.1').manifest;
  const manifest = UpgradeManifestSchema.parse({
    ...base,
    components,
    packages: [
      {
        ...base.packages[0],
        platform: process.platform,
        arch: process.arch,
        name: 'boundary.tgz',
        digest: packageDigest,
        bytes: bytes.length,
        format: 'native-tar',
        url: 'https://distribution.invalid/boundary.tgz',
      },
    ],
  });
  const fingerprint = upgradeRunInputFingerprint(manifest);
  manifest.evidence = manifest.evidence.map((item) => ({ ...item, inputFingerprint: fingerprint }));
  const keys = generateKeyPairSync('ed25519'),
    signedManifest = {
      manifest,
      manifestDigest: upgradeDigest(manifest),
      signature: {
        algorithm: 'Ed25519',
        keyId: 'migration-boundary',
        value: sign(null, Buffer.from(canonicalUpgrade(manifest)), keys.privateKey).toString(
          'base64',
        ),
      },
    };
  const trustPath = join(directory, 'trust.json');
  await writeFile(
    trustPath,
    JSON.stringify({
      schemaVersion: 1,
      channel: manifest.channel,
      distributionOrigins: ['https://distribution.invalid'],
      keys: [
        {
          id: 'migration-boundary',
          publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }),
        },
      ],
    }),
    { mode: 0o600 },
  );
  const installed = { packageDigest, treeDigest: bundle.treeDigest, components };
  await writeFile(join(artifactRoot, 'installed.json'), JSON.stringify(installed), { mode: 0o600 });
  const receipt = {
      schemaVersion: 1,
      instanceId,
      artifactRoot,
      signedManifest,
      packageDigest,
      controlArtifactRoot,
      archivePath,
    },
    path = join(bindings, 'migration-source.json');
  await writeFile(path, JSON.stringify(receipt), { mode: 0o600 });
  restore = useEnv({
    UPGRADE_MIGRATED_ARTIFACT_PATH: path,
    PLATFORM_COORDINATOR_BINDING_PATH: join(bindings, 'coordinator.json'),
    UPGRADE_INSTALLER_ROOT: installer,
    UPGRADE_TRUST_ROOT_PATH: trustPath,
    PLATFORM_INSTANCE_ID: instanceId,
  });
  return {
    path,
    receipt,
    artifactRoot,
    controlArtifactRoot,
    archivePath,
    installed,
    read: () =>
      migratedSourceArtifact({
        instanceId,
        clock,
        installerProgramRoot: join(controlArtifactRoot, 'installer'),
      }),
  };
}
beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), 'migrated-source-provenance-')));
  restore = () => {};
});
afterEach(async () => {
  restore();
  await rm(directory, { recursive: true, force: true });
});
describe('explicit signed migration source provenance without confirming a release', () => {
  it('returns only a fully verified source candidate and keeps the signed receipt bytes unchanged', async () => {
    const f = await fixture(),
      before = await readFile(f.path);
    const result = await f.read();
    expect(result).toEqual({
      root: f.artifactRoot,
      components: f.receipt.signedManifest.manifest.components,
      provenanceVerified: true,
    });
    expect(await readFile(f.path)).toEqual(before);
  });
  it('is absent when no explicit installation provenance was configured', async () => {
    const f = await fixture();
    delete process.env.UPGRADE_MIGRATED_ARTIFACT_PATH;
    expect(await f.read()).toBeNull();
  });
  it('rejects an untrusted signature instead of treating installed.json as publisher authority', async () => {
    const f = await fixture();
    f.receipt.signedManifest.signature.value = Buffer.alloc(64).toString('base64');
    await writeFile(f.path, JSON.stringify(f.receipt));
    await expect(f.read()).rejects.toThrow('SIGNATURE_OR_MANIFEST_DIGEST_INVALID');
  });
  it('rejects archive bytes changed beneath a matching installed package name', async () => {
    const f = await fixture();
    await writeFile(
      f.archivePath,
      Buffer.alloc(Buffer.byteLength('boundary package identity bytes'), 1),
    );
    await expect(f.read()).rejects.toThrow('MIGRATED_SOURCE_ARCHIVE_CHANGED');
  });
  it('rejects an unlisted executable and an independent engine whose actual installer tree changed', async () => {
    const f = await fixture();
    const extra = join(f.artifactRoot, 'api/extra.js');
    await writeFile(extra, 'unlisted');
    await expect(f.read()).rejects.toThrow('INSTALLED_ARTIFACT_CHANGED');
    await rm(extra);
    await writeFile(
      join(f.controlArtifactRoot, 'installer/controller-main.mjs'),
      'different engine',
    );
    await expect(f.read()).rejects.toThrow('INSTALLED_ARTIFACT_CHANGED');
  });
  it('binds the fixed receipt path, instance and actual independent installer root', async () => {
    const f = await fixture();
    await expect(
      migratedSourceArtifact({
        instanceId: 'foreign',
        clock,
        installerProgramRoot: join(f.controlArtifactRoot, 'installer'),
      }),
    ).rejects.toThrow('MIGRATED_SOURCE_SCOPE_INVALID');
    await expect(
      migratedSourceArtifact({
        instanceId,
        clock,
        installerProgramRoot: join(f.artifactRoot, 'installer'),
      }),
    ).rejects.toThrow('MIGRATED_SOURCE_SCOPE_INVALID');
    process.env.UPGRADE_MIGRATED_ARTIFACT_PATH = join(directory, 'any.json');
    await expect(f.read()).rejects.toThrow('MIGRATED_SOURCE_SCOPE_INVALID');
  });
  it('requires a private receipt and installed package/tree receipt agreement', async () => {
    const f = await fixture();
    await chmod(f.path, 0o644);
    await expect(f.read()).rejects.toThrow('MIGRATED_SOURCE_FILE_INSECURE');
    await chmod(f.path, 0o600);
    await writeFile(
      join(f.artifactRoot, 'installed.json'),
      JSON.stringify({ ...f.installed, packageDigest: 'sha256:' + '0'.repeat(64) }),
    );
    await expect(f.read()).rejects.toThrow('MIGRATED_SOURCE_INSTALLED_RECEIPT_MISMATCH');
  });
});
