import { afterEach, describe, expect, it } from 'vitest';
import type { EventBus } from '@platform/shared-kernel';
import { ImageApplicationService } from '../../../packages/modules/image/src/application/image-application.service';
import { AesGcmEnvSecretCipher } from '../../../packages/modules/image/src/infrastructure/crypto/env-secret.cipher';
import { SqliteImageRepository } from '../../../packages/modules/image/src/infrastructure/persistence/sqlite/image.repository.impl';
import { SqliteImageManifestRepository } from '../../../packages/modules/image/src/infrastructure/persistence/sqlite/image-manifest.repository.impl';
import { currentDatabase } from '../../support/sqlite';
import { registryMetadataFixture } from '../../support/protocol-resources';
import { useEnv } from '../../support/strict-ports';

const closers: (() => void)[] = [];
afterEach(() =>
  closers
    .splice(0)
    .reverse()
    .forEach((close) => close()),
);

async function scenario() {
  closers.push(useEnv({ PLATFORM_MASTER_KEY: Buffer.alloc(32, 23).toString('base64') }));
  const database = currentDatabase();
  closers.push(() => database.sqlite.close());
  const manifests = new SqliteImageManifestRepository(database.db);
  const cipher = new AesGcmEnvSecretCipher();
  const registry = registryMetadataFixture();
  const provider = registry.get(registry.defaultProvider);
  const resolveOriginal = provider.resolve.bind(provider);
  let revision = 1;
  provider.resolve = async (ref) => {
    const resolved = await resolveOriginal(ref);
    if (ref.startsWith('registry.test/model:')) {
      return { ...resolved, digest: `sha256:${String(revision).repeat(64)}` };
    }
    return resolved;
  };
  let id = 0;
  const events: EventBus = { publishInTx: () => {}, subscribe: () => () => {} };
  const service = new ImageApplicationService(
    new SqliteImageRepository(database.db),
    manifests,
    registry,
    cipher,
    database.uow,
    events,
    { now: () => new Date('2026-10-05T00:00:00Z') },
    { next: () => `inheritance-${++id}` },
  );
  await service.registerImage('ghcr.io/agent-infra/sandbox:latest', { builtin: true });
  return { ...database, manifests, cipher, service, nextRevision: () => revision++ };
}

describe('AC-IMG-026.1/024.6 · real SQLite and AES-GCM version inheritance', () => {
  it('copies all runtime parameters and exact ciphertext to a new digest, then activates only that version', async () => {
    const s = await scenario();
    const first = await s.service.registerImage('registry.test/model:v1');
    await s.service.patchImage(first.manifest.id, {
      imageConfig: {
        env: [
          { key: 'LOG_LEVEL', value: 'debug', secret: false },
          { key: 'MY_SECRET', value: 'synthetic-private-value', secret: true },
          { key: 'HTTP_TIMEOUT', value: '30', secret: false },
        ],
        cmdOverride: ['bash', '-lc', 'echo synthetic-command'],
      },
    });
    const original = await s.manifests.findById(first.manifest.id);
    expect(original?.config?.env[1]?.secret).toBe(true);
    const secret = original?.config?.env[1];
    if (!secret?.secret || !secret.valueEncrypted)
      throw new Error('secret fixture was not encrypted');
    expect(s.cipher.open(secret.valueEncrypted)).toBe('synthetic-private-value');
    const raw = s.sqlite
      .prepare('SELECT image_config AS config FROM image_manifests WHERE id=?')
      .get(first.manifest.id);
    expect(JSON.stringify(raw)).not.toContain('synthetic-private-value');

    s.nextRevision();
    const second = await s.service.registerImage('registry.test/model:v1', {
      copyConfigFromId: first.manifest.id,
    });
    expect(second.created).toBe(true);
    expect(second.manifest.id).not.toBe(first.manifest.id);
    expect(second.manifest.isActive).toBe(false);
    const inherited = await s.manifests.findById(second.manifest.id);
    expect(inherited?.config).toEqual(original?.config);
    expect(JSON.stringify(second.manifest)).not.toContain('synthetic-private-value');
    const inheritedSecret = inherited?.config?.env[1];
    if (!inheritedSecret?.secret || !inheritedSecret.valueEncrypted)
      throw new Error('inherited ciphertext missing');
    expect(s.cipher.open(inheritedSecret.valueEncrypted)).toBe('synthetic-private-value');
    await s.service.activateImage(second.manifest.id);
    const versions = (await s.service.listImages()).filter(
      (version) => version.imageName === 'registry.test/model',
    );
    expect(versions.filter((version) => version.isActive).map((version) => version.id)).toEqual([
      second.manifest.id,
    ]);
    expect((await s.manifests.findById(first.manifest.id))?.config).toEqual(original?.config);
  });

  it('preserves edited target parameters on a retried update and rejects inheritance from a different tag without writes', async () => {
    const s = await scenario();
    const source = await s.service.registerImage('registry.test/model:v1');
    await s.service.patchImage(source.manifest.id, {
      imageConfig: { env: [{ key: 'CUSTOM', value: 'source', secret: false }] },
    });
    s.nextRevision();
    const target = await s.service.registerImage('registry.test/model:v1', {
      copyConfigFromId: source.manifest.id,
    });
    await s.service.patchImage(target.manifest.id, {
      imageConfig: { env: [{ key: 'CUSTOM', value: 'target-edited', secret: false }] },
    });
    const beforeRetry = await s.manifests.findById(target.manifest.id);
    const retried = await s.service.registerImage('registry.test/model:v1', {
      copyConfigFromId: source.manifest.id,
    });
    expect(retried.created).toBe(false);
    expect(retried.manifest.id).toBe(target.manifest.id);
    expect((await s.manifests.findById(target.manifest.id))?.config).toEqual(beforeRetry?.config);
    const before = s.sqlite.prepare('SELECT total_changes() AS n').get();
    await expect(
      s.service.registerImage('registry.test/model:v2', { copyConfigFromId: source.manifest.id }),
    ).rejects.toThrow('同一 tag');
    expect(s.sqlite.prepare('SELECT total_changes() AS n').get()).toEqual(before);
    expect(
      (await s.service.listImages()).filter(
        (version) => version.imageName === 'registry.test/model',
      ),
    ).toHaveLength(2);
  });
});
