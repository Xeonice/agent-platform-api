import 'reflect-metadata';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProviderRegistry } from '@platform/contracts';
import { ImageApplicationService } from '../../../packages/modules/image/src/application/image-application.service';
import { ImageSeeder } from '../../../packages/modules/image/src/application/image-seeder';
import { AesGcmEnvSecretCipher } from '../../../packages/modules/image/src/infrastructure/crypto/env-secret.cipher';
import { SqliteImageRepository } from '../../../packages/modules/image/src/infrastructure/persistence/sqlite/image.repository.impl';
import { SqliteImageManifestRepository } from '../../../packages/modules/image/src/infrastructure/persistence/sqlite/image-manifest.repository.impl';
import { registryMetadataFixture } from '../../support/protocol-resources';
import { ScriptedProvider } from '../../support/external-provider';
import { currentDatabase } from '../../support/sqlite';
import { useEnv } from '../../support/strict-ports';

const closers: (() => void)[] = [];
afterEach(() =>
  closers
    .splice(0)
    .reverse()
    .forEach((close) => close()),
);
const newRef = 'registry.test/release:v2';

async function scenario() {
  closers.push(
    useEnv({
      SANDBOX_DEFAULT_IMAGE: newRef,
      SANDBOX_AIO_IMAGE: undefined,
      SANDBOX_DEFAULT_IMAGE_TMUX: 'true',
      PLATFORM_MASTER_KEY: Buffer.alloc(32, 31).toString('base64'),
    }),
  );
  const database = currentDatabase();
  closers.push(() => database.sqlite.close());
  const images = new SqliteImageRepository(database.db);
  const manifests = new SqliteImageManifestRepository(database.db);
  const registry = registryMetadataFixture();
  const spec = registry.get(registry.defaultProvider);
  const resolve = spec.resolve.bind(spec);
  let offline = false;
  let resolves = 0;
  spec.resolve = async (ref) => {
    resolves++;
    if (offline) throw new Error('registry unavailable');
    const result = await resolve(ref);
    result.manifest.runtimeVersions = { codex: '0.163.0', 'claude-code': '2.1.302' };
    return result;
  };
  let id = 0;
  const service = new ImageApplicationService(
    images,
    manifests,
    registry,
    new AesGcmEnvSecretCipher(),
    database.uow,
    { publishInTx: () => {}, subscribe: () => () => {} },
    { now: () => new Date('2026-10-17T00:00:00Z') },
    { next: () => `release-${++id}` },
  );
  const provider = new ScriptedProvider();
  const providers: ProviderRegistry = {
    defaultProvider: provider.name,
    list: () => [provider],
    get: () => provider,
    has: (name) => name === provider.name,
    register: () => {
      throw new Error('fixed provider registry');
    },
  };
  const seeder = () => new ImageSeeder(images, service, providers, manifests);
  const old = await service.registerImage('registry.test/release:v1', { builtin: true });
  return {
    ...database,
    images,
    manifests,
    service,
    old,
    seeder,
    offline: () => {
      offline = true;
    },
    online: () => {
      offline = false;
    },
    resolves: () => resolves,
  };
}

describe('release builtin seeding and Coordinator metadata preparation · real SQLite', () => {
  it('prepares without DB writes and adopts offline, retaining historical config, alias, disabled state and task reference', async () => {
    const s = await scenario();
    await s.service.patchImage(s.old.manifest.id, {
      alias: '研发默认',
      isActive: false,
      imageConfig: { env: [{ key: 'EXAMPLE', value: 'retained', secret: false }] },
    });
    s.sqlite
      .prepare(
        'INSERT INTO sandboxes (id,project_id,runtime,provider,image_ref,status,headless,created_at,updated_at) VALUES (?,?,?,?,?,?,0,0,0)',
      )
      .run('original-task', 'project', 'codex', 'aio', s.old.manifest.id, 'stopped');
    const old = s.sqlite.prepare('SELECT * FROM image_manifests WHERE id=?').get(s.old.manifest.id);
    const image = s.sqlite.prepare('SELECT * FROM images').all();
    const task = s.sqlite.prepare('SELECT * FROM sandboxes').all();
    const changes = s.sqlite.prepare('SELECT total_changes() AS n').get();
    const seeder = s.seeder();
    await seeder.prepare();
    expect(s.sqlite.prepare('SELECT total_changes() AS n').get()).toEqual(changes);
    const count = s.resolves();
    s.offline();
    await seeder.onApplicationBootstrap();
    expect(s.resolves()).toBe(count);
    const rows = await s.service.listImages();
    expect(rows.find((row) => row.version === 'v2')).toMatchObject({
      isBuiltin: true,
      isActive: true,
      imageAlias: '研发默认',
      runtimeVersions: { codex: '0.163.0', 'claude-code': '2.1.302' },
    });
    expect(
      s.sqlite.prepare('SELECT * FROM image_manifests WHERE id=?').get(s.old.manifest.id),
    ).toEqual(old);
    expect(s.sqlite.prepare('SELECT * FROM images').all()).toEqual(image);
    expect(s.sqlite.prepare('SELECT * FROM sandboxes').all()).toEqual(task);
    await seeder.onApplicationBootstrap();
    expect(await s.manifests.listAll()).toHaveLength(2);
    expect(s.resolves()).toBe(count);
  });

  it('does not resolve or reactivate a previously registered but disabled target ref', async () => {
    const s = await scenario();
    const target = await s.service.registerImage(newRef, { builtin: true });
    await s.service.patchImage(target.manifest.id, { isActive: false });
    const rows = s.sqlite.prepare('SELECT * FROM image_manifests ORDER BY id').all();
    const count = s.resolves();
    s.offline();
    const seeder = s.seeder();
    await seeder.prepare();
    await seeder.onApplicationBootstrap();
    expect(s.resolves()).toBe(count);
    expect(s.sqlite.prepare('SELECT * FROM image_manifests ORDER BY id').all()).toEqual(rows);
    expect((await s.manifests.findActiveByVersion(s.old.manifest.imageId, 'v1'))?.id).toBe(
      s.old.manifest.id,
    );
  });

  it('refuses failed preparation without writes or bootstrap network fallback', async () => {
    const s = await scenario();
    const before = s.sqlite.prepare('SELECT total_changes() AS n').get();
    s.offline();
    const seeder = s.seeder();
    await expect(seeder.prepare()).rejects.toThrow('registry unavailable');
    s.online();
    const count = s.resolves();
    await expect(seeder.onApplicationBootstrap()).rejects.toThrow('PREPARATION_INCOMPLETE');
    expect(s.resolves()).toBe(count);
    expect(s.sqlite.prepare('SELECT total_changes() AS n').get()).toEqual(before);
  });

  it('refuses a changed default after preparation without resolving the replacement during adoption', async () => {
    const s = await scenario();
    const seeder = s.seeder();
    await seeder.prepare();
    const count = s.resolves();
    const before = s.sqlite.prepare('SELECT total_changes() AS n').get();
    closers.push(useEnv({ SANDBOX_DEFAULT_IMAGE: 'registry.test/release:v3' }));
    await expect(seeder.onApplicationBootstrap()).rejects.toThrow('PREPARATION_MISSING');
    expect(s.resolves()).toBe(count);
    expect(s.sqlite.prepare('SELECT total_changes() AS n').get()).toEqual(before);
  });

  it('preserves user-owned repositories and refuses both builtin exemption and forged prepared handles', async () => {
    const s = await scenario();
    const ref = 'registry.test/user-owned:v2';
    const prepared = await s.service.prepareBuiltinImage(ref);
    const user = await s.service.registerImage(ref, { alias: '用户仓库' });
    closers.push(useEnv({ SANDBOX_DEFAULT_IMAGE: ref }));
    const count = s.resolves();
    const rows = s.sqlite.prepare('SELECT * FROM image_manifests ORDER BY id').all();
    await s.seeder().onApplicationBootstrap();
    expect(s.resolves()).toBe(count);
    await expect(
      s.service.registerImage('registry.test/user-owned:v3', { builtin: true }),
    ).rejects.toThrow('准入豁免');
    await expect(s.service.registerPreparedBuiltinImage(prepared)).rejects.toThrow('准入豁免');
    await expect(s.service.registerPreparedBuiltinImage({ ref })).rejects.toThrow('本进程完成准备');
    expect(s.sqlite.prepare('SELECT * FROM image_manifests ORDER BY id').all()).toEqual(rows);
    expect((await s.images.findById(user.manifest.imageId))?.isBuiltin).toBe(false);
    expect((await s.images.findById(user.manifest.imageId))?.alias).toBe('用户仓库');
  });

  it('cold start appends an absent release ref while preserving the older active tag', async () => {
    const s = await scenario();
    const count = s.resolves();
    await s.seeder().onApplicationBootstrap();
    expect(s.resolves()).toBe(count + 1);
    expect(
      (await s.manifests.listByImage(s.old.manifest.imageId))
        .map((row) => [row.version, row.isActive])
        .sort(),
    ).toEqual([
      ['v1', true],
      ['v2', true],
    ]);
  });
});
