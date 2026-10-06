import { afterEach, describe, expect, it } from 'vitest';
import type {
  ImageSpecProvider,
  ImageSpecRegistry,
  ResolvedImage,
  SandboxFacade,
} from '@platform/contracts';
import type { EventBus } from '@platform/shared-kernel';
import { ImageApplicationService } from '../../../packages/modules/image/src/application/image-application.service';
import { SqliteImageRepository } from '../../../packages/modules/image/src/infrastructure/persistence/sqlite/image.repository.impl';
import { SqliteImageManifestRepository } from '../../../packages/modules/image/src/infrastructure/persistence/sqlite/image-manifest.repository.impl';
import type { EnvSecretCipher } from '../../../packages/modules/image/src/domain/ports/env-secret.cipher.port';
import { currentDatabase, seedImageManifest } from '../../support/sqlite';
import { unused } from '../../support/strict-ports';

const databases: ReturnType<typeof currentDatabase>[] = [];
const digest = `sha256:${'b'.repeat(64)}`;
function scenario(
  references?: Pick<SandboxFacade, 'imageReferences'>,
  specs = unused<ImageSpecRegistry>('registry'),
) {
  const database = currentDatabase();
  databases.push(database);
  const manifest = seedImageManifest(database.sqlite, { digest });
  const service = new ImageApplicationService(
    new SqliteImageRepository(database.db),
    new SqliteImageManifestRepository(database.db),
    specs,
    unused<EnvSecretCipher>('cipher'),
    database.uow,
    unused<EventBus>('events'),
    { now: () => new Date('2026-10-05T00:00:00Z') },
    {
      next: () => {
        throw new Error('read-only ID allocation');
      },
    },
    references,
  );
  return { ...database, manifest, service };
}
afterEach(() => databases.splice(0).forEach(({ sqlite }) => sqlite.close()));

describe('AC-IMG-004.2/006.1/034.3 · real service with current SQLite', () => {
  it('returns the resolved immutable digest without writing a manifest, including a lineage refusal', async () => {
    const resolved: ResolvedImage = {
      ref: 'registry.test/agent:v2',
      digest,
      entrypoint: ['/bin/sh'],
      resolvedAt: '2026-10-05T00:00:00Z',
      manifest: {
        name: 'registry.test/agent',
        version: 'v2',
        baseImage: 'debian',
        entrypointContract: { workdir: '/', entrypoint: ['/bin/sh'] },
        supportedRuntimes: ['codex'],
        resourceDefaults: { cores: 1, ramMb: 512, diskMb: 1024 },
        diffIds: ['sha256:outside'],
      },
    };
    const provider: ImageSpecProvider = {
      name: 'scenario',
      resolve: async () => resolved,
      validate: () => ({ valid: true, errors: [] }),
    };
    const specs: ImageSpecRegistry = {
      defaultProvider: 'scenario',
      get: () => provider,
      has: () => true,
      list: () => [provider],
      register: () => {
        throw new Error('read-only provider registration');
      },
    };
    const s = scenario(undefined, specs);
    const base = seedImageManifest(s.sqlite, {
      manifestId: 'builtin-base',
      name: 'registry.test/platform-base',
      digest: `sha256:${'a'.repeat(64)}`,
    });
    s.sqlite
      .prepare(
        'UPDATE images SET is_builtin=1 WHERE id=(SELECT image_id FROM image_manifests WHERE id=?)',
      )
      .run(base);
    s.sqlite
      .prepare('UPDATE image_manifests SET diff_ids=? WHERE id=?')
      .run(JSON.stringify(['sha256:platform']), base);
    const before = s.sqlite.prepare('SELECT total_changes() AS n').get();
    const result = await s.service.validateImage(resolved.ref);
    expect(result.digest).toBe(digest);
    expect(result.status).toBe('invalid');
    expect(result.errors.some((finding) => finding.code === 'IMAGE_BASE_REQUIRED')).toBe(true);
    expect(s.sqlite.prepare('SELECT total_changes() AS n').get()).toEqual(before);
    expect((await s.service.listImages()).map((image) => image.id).sort()).toEqual(
      [base, s.manifest].sort(),
    );
  });

  it('returns the actual affected stopped/waiting tasks, project names and version digest without side effects', async () => {
    const tasks = [
      {
        id: 'task-stopped',
        name: '整理接口',
        status: 'stopped',
        projectId: 'project',
        projectName: '实际项目',
      },
      {
        id: 'task-waiting',
        name: '等审批',
        status: 'waiting_input',
        projectId: 'other',
        projectName: '另一个项目',
      },
    ];
    const s = scenario({ imageReferences: async () => tasks });
    const before = s.sqlite.prepare('SELECT total_changes() AS n').get();
    expect(await s.service.deletionPreview(s.manifest)).toEqual({
      canDelete: false,
      tasks,
      versions: [{ id: s.manifest, version: s.manifest, digest, isActive: true }],
    });
    expect(s.sqlite.prepare('SELECT total_changes() AS n').get()).toEqual(before);
  });

  it('fails closed when the task-list source is missing or unreadable, and rejects an unknown status at the contract boundary', async () => {
    const missing = scenario();
    await expect(missing.service.deletionPreview(missing.manifest)).rejects.toThrow(
      '任务引用清单服务未配置',
    );
    const unreadable = scenario({
      imageReferences: async () => {
        throw new Error('actual database unavailable');
      },
    });
    await expect(unreadable.service.deletionPreview(unreadable.manifest)).rejects.toThrow(
      'actual database unavailable',
    );
    const invalid = scenario({
      imageReferences: async () => [
        { id: 'x', name: 'x', status: 'made-up', projectId: 'p', projectName: 'p' },
      ],
    });
    await expect(invalid.service.deletionPreview(invalid.manifest)).rejects.toThrow();
  });
});
