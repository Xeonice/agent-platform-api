import { afterEach, describe, expect, it } from 'vitest';
import type { DomainEvent, EventBus } from '@platform/shared-kernel';
import { ImageAliasUpdated } from '../../../packages/modules/image/src/domain/events/image-events';
import { ImageApplicationService } from '../../../packages/modules/image/src/application/image-application.service';
import { AesGcmEnvSecretCipher } from '../../../packages/modules/image/src/infrastructure/crypto/env-secret.cipher';
import { SqliteImageRepository } from '../../../packages/modules/image/src/infrastructure/persistence/sqlite/image.repository.impl';
import { SqliteImageManifestRepository } from '../../../packages/modules/image/src/infrastructure/persistence/sqlite/image-manifest.repository.impl';
import { project } from '../../../apps/api/src/platform/audit/audit.projector';
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
  closers.push(useEnv({ PLATFORM_MASTER_KEY: Buffer.alloc(32, 29).toString('base64') }));
  const database = currentDatabase();
  closers.push(() => database.sqlite.close());
  const images = new SqliteImageRepository(database.db);
  const manifests = new SqliteImageManifestRepository(database.db);
  const registry = registryMetadataFixture();
  const provider = registry.get(registry.defaultProvider);
  const originalResolve = provider.resolve.bind(provider);
  let revision = 1;
  let resolveCount = 0;
  provider.resolve = async (ref) => {
    resolveCount++;
    const resolved = await originalResolve(ref);
    return ref.startsWith('registry.test/agent:')
      ? { ...resolved, digest: `sha256:${String(revision).repeat(64)}` }
      : resolved;
  };
  let id = 0;
  const emitted: DomainEvent[] = [];
  const events: EventBus = {
    publishInTx: (_tx, batch) => {
      emitted.push(...batch);
    },
    subscribe: () => () => {},
  };
  const cipher = new AesGcmEnvSecretCipher();
  const service = new ImageApplicationService(
    images,
    manifests,
    registry,
    cipher,
    database.uow,
    events,
    { now: () => new Date('2026-10-09T00:00:00Z') },
    { next: () => `alias-${++id}` },
  );
  const builtin = await service.registerImage('ghcr.io/agent-infra/sandbox:latest', {
    builtin: true,
  });
  return {
    ...database,
    images,
    manifests,
    provider,
    cipher,
    service,
    emitted,
    builtin,
    nextRevision: () => revision++,
    resolveCount: () => resolveCount,
  };
}

describe('AC-IMG-060 · actual services, SQLite, encrypted config and registration windows', () => {
  it('shares aliases across versions, keeps immutable/config state and logs only changes', async () => {
    const s = await scenario();
    const first = await s.service.registerImage('registry.test/agent:v1', {
      alias: '  研发 Agent  ',
    });
    s.sqlite
      .prepare(
        'INSERT INTO sandboxes (id,project_id,runtime,provider,image_ref,status,headless,created_at,updated_at) VALUES (?,?,?,?,?,?,0,0,0)',
      )
      .run('bound-task', 'project', 'codex', 'aio', first.manifest.id, 'stopped');
    const boundTask = s.sqlite.prepare('SELECT * FROM sandboxes WHERE id=?').get('bound-task');
    await s.service.patchImage(first.manifest.id, {
      imageConfig: { env: [{ key: 'PRIVATE_VALUE', value: 'synthetic-secret', secret: true }] },
    });
    const before = await s.manifests.findById(first.manifest.id);
    s.nextRevision();
    const second = await s.service.registerImage('registry.test/agent:v1', {
      copyConfigFromId: first.manifest.id,
    });
    expect(second.manifest.imageAlias).toBe('研发 Agent');
    const networkCount = s.resolveCount();
    const renamed = await s.service.patchImage(second.manifest.id, { alias: ' 联调环境 ' });
    expect(renamed.imageAlias).toBe('联调环境');
    expect(s.resolveCount()).toBe(networkCount);
    expect(s.sqlite.prepare('SELECT * FROM sandboxes WHERE id=?').get('bound-task')).toEqual(
      boundTask,
    );
    expect(await s.manifests.findById(first.manifest.id)).toEqual(before);
    expect((await s.manifests.findById(second.manifest.id))?.config).toEqual(before?.config);
    await s.service.activateImage(second.manifest.id);
    await s.service.activateImage(first.manifest.id);
    expect(
      (await s.service.listImages())
        .filter((m) => m.imageId === first.manifest.imageId)
        .map((m) => m.imageAlias),
    ).toEqual(['联调环境', '联调环境']);
    await s.service.patchImage(first.manifest.id, { alias: '联调环境' });
    const aliasEvents = s.emitted.filter((event) => event instanceof ImageAliasUpdated);
    expect(aliasEvents).toHaveLength(1);
    expect(project(aliasEvents[0])).toMatchObject({
      type: 'image.alias_updated',
      subjectId: first.manifest.imageId,
      detail: { previousAlias: '研发 Agent', alias: '联调环境' },
    });
    await s.service.patchImage(s.builtin.manifest.id, { alias: '预制环境' });
    expect(
      (await s.service.registerImage('ghcr.io/agent-infra/sandbox:latest', { builtin: true }))
        .manifest.imageAlias,
    ).toBe('预制环境');
  });

  it('validates the complete mixed request before writing alias, enabled state, config or events', async () => {
    const s = await scenario();
    const result = await s.service.registerImage('registry.test/agent:v1', { alias: '原值' });
    const before = s.sqlite.prepare('SELECT total_changes() AS n').get();
    const eventCount = s.emitted.length;
    await expect(
      s.service.patchImage(result.manifest.id, {
        alias: '新值',
        isActive: false,
        imageConfig: { env: [{ key: 'HOME', value: 'forbidden' }] },
      }),
    ).rejects.toThrow();
    await expect(
      s.service.patchImage(result.manifest.id, {
        alias: '\n新值',
        imageConfig: { env: [{ key: 'CUSTOM', value: 'would-change' }] },
      }),
    ).rejects.toThrow();
    expect(s.sqlite.prepare('SELECT total_changes() AS n').get()).toEqual(before);
    expect(s.emitted).toHaveLength(eventCount);
    expect((await s.service.listImages()).find((m) => m.id === result.manifest.id)).toMatchObject({
      imageAlias: '原值',
      isActive: true,
      imageConfig: null,
    });
    await s.service.patchImage(result.manifest.id, {});
    expect(s.sqlite.prepare('SELECT total_changes() AS n').get()).toEqual(before);
  });

  it('rolls alias and config back together if the version write fails inside the transaction', async () => {
    const s = await scenario();
    const result = await s.service.registerImage('registry.test/agent:v1', { alias: '原值' });
    const before = (await s.service.listImages()).find(
      (manifest) => manifest.id === result.manifest.id,
    );
    const eventCount = s.emitted.length;
    s.manifests.saveSync = () => {
      throw new Error('controlled persistence failure');
    };
    await expect(
      s.service.patchImage(result.manifest.id, {
        alias: '不提交',
        imageConfig: { env: [{ key: 'CUSTOM', value: 'not-committed' }] },
      }),
    ).rejects.toThrow('controlled persistence failure');
    expect(
      (await s.service.listImages()).find((manifest) => manifest.id === result.manifest.id),
    ).toEqual(before);
    expect(s.emitted).toHaveLength(eventCount);
  });

  it('preserves concurrent alias edits on new-version registration and returns the committed value', async () => {
    const s = await scenario();
    const first = await s.service.registerImage('registry.test/agent:v1', { alias: '旧值' });
    s.nextRevision();
    const findActive = s.manifests.findActiveByVersion.bind(s.manifests);
    let reached!: () => void;
    let release!: () => void;
    const paused = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const resumed = new Promise<void>((resolve) => {
      release = resolve;
    });
    s.manifests.findActiveByVersion = async (...args) => {
      reached();
      await resumed;
      return findActive(...args);
    };
    const registering = s.service.registerImage('registry.test/agent:v1');
    await paused;
    await s.service.patchImage(first.manifest.id, { alias: '并发修改' });
    release();
    expect((await registering).manifest.imageAlias).toBe('并发修改');
    expect((await s.images.findById(first.manifest.imageId))?.alias).toBe('并发修改');
  });

  it('rejects explicit registration rename, including a name changed while registration was paused, with zero writes', async () => {
    const s = await scenario();
    const first = await s.service.registerImage('registry.test/agent:v1', { alias: '旧值' });
    let before = s.sqlite.prepare('SELECT total_changes() AS n').get();
    await expect(
      s.service.registerImage('registry.test/agent:v1', { alias: '新值' }),
    ).rejects.toThrow('镜像卡片');
    expect(s.sqlite.prepare('SELECT total_changes() AS n').get()).toEqual(before);
    s.nextRevision();
    const original = s.manifests.findActiveByVersion.bind(s.manifests);
    let reached!: () => void;
    let release!: () => void;
    const paused = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const resumed = new Promise<void>((resolve) => {
      release = resolve;
    });
    s.manifests.findActiveByVersion = async (...args) => {
      reached();
      await resumed;
      return original(...args);
    };
    const registering = s.service.registerImage('registry.test/agent:v1', { alias: '旧值' });
    await paused;
    await s.service.patchImage(first.manifest.id, { alias: '并发修改' });
    before = s.sqlite.prepare('SELECT total_changes() AS n').get();
    release();
    await expect(registering).rejects.toThrow('镜像卡片');
    expect(s.sqlite.prepare('SELECT total_changes() AS n').get()).toEqual(before);
  });
});
