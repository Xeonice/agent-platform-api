import 'reflect-metadata';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, describe, expect, it } from 'vitest';
import { ImageManifestSchema, type ImageSpecRegistry } from '@platform/contracts';
import {
  createConnection,
  runMigrations,
} from '../../../apps/api/src/platform/persistence/drizzle.connection';
import { SqliteUnitOfWork } from '../../../apps/api/src/platform/persistence/unit-of-work.impl';
import { ImageApplicationService } from '../../../packages/modules/image/src/application/image-application.service';
import { SqliteImageRepository } from '../../../packages/modules/image/src/infrastructure/persistence/sqlite/image.repository.impl';
import { SqliteImageManifestRepository } from '../../../packages/modules/image/src/infrastructure/persistence/sqlite/image-manifest.repository.impl';
import { OciImageSpecProvider } from '../../../packages/modules/image/src/infrastructure/spec/oci-image-spec.provider';
import { OciRegistryClient } from '../../../packages/modules/image/src/infrastructure/spec/oci-registry.client';
import { useEnv } from '../../support/strict-ports';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const hash = (bytes: Buffer) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const baseLayer = `sha256:${'b'.repeat(64)}`;
const childLayer = `sha256:${'c'.repeat(64)}`;

/** Actual HTTP Distribution endpoints; any request for a filesystem layer fails. */
async function scenario() {
  cleanup.push(useEnv({ SANDBOX_DEFAULT_IMAGE_TMUX: 'true' }));
  const directory = mkdtempSync(join(tmpdir(), 'img-version-sqlite-'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const filename = join(directory, 'platform.db');
  const connection = createConnection(filename);
  runMigrations(connection.db, connection.sqlite);
  const database = { ...connection, uow: new SqliteUnitOfWork(connection.sqlite) };
  cleanup.push(() => {
    if (database.sqlite.open) database.sqlite.close();
  });
  const requests: string[] = [];
  const configurations = new Map<string, Buffer>();
  const manifests = new Map<string, Buffer>();
  function publish(repository: string, label?: string, revision = 1) {
    const config = Buffer.from(
      JSON.stringify({
        architecture: process.arch === 'arm64' ? 'arm64' : 'amd64',
        os: 'linux',
        rootfs: {
          type: 'layers',
          diff_ids: repository === 'platform/base' ? [baseLayer] : [baseLayer, childLayer],
        },
        config: {
          WorkingDir: '/',
          Entrypoint: ['/bin/sh'],
          Labels: {
            'platform.supportedRuntimes': 'codex,claude-code',
            ...(label === undefined ? {} : { 'platform.runtimeVersions': label }),
            'fixture.revision': String(revision),
          },
        },
      }),
    );
    const digest = hash(config);
    configurations.set(digest, config);
    manifests.set(
      repository,
      Buffer.from(
        JSON.stringify({
          mediaType: 'application/vnd.oci.image.manifest.v1+json',
          schemaVersion: 2,
          config: {
            digest,
            size: config.length,
            mediaType: 'application/vnd.oci.image.config.v1+json',
          },
          layers: [{ digest: `sha256:${'f'.repeat(64)}`, size: 999_999 }],
        }),
      ),
    );
  }
  publish('platform/base', '{"codex":"0.163.0","claude-code":"2.1.302"}');
  publish('platform/agent');
  const server: Server = createServer((request, response) => {
    const url = request.url ?? '';
    requests.push(url);
    const match = /^\/v2\/(.+)\/(manifests|blobs)\/([^/]+)$/.exec(url);
    const bytes =
      match?.[2] === 'manifests'
        ? manifests.get(match[1])
        : match?.[2] === 'blobs'
          ? configurations.get(match[3])
          : undefined;
    if (!bytes) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, {
      'content-type': 'application/json',
      'docker-content-digest': hash(bytes),
    });
    response.end(bytes);
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  cleanup.push(
    () =>
      new Promise<void>((done, reject) =>
        server.close((error) => (error ? reject(error) : done())),
      ),
  );
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('registry fixture not listening');
  const name = `127.0.0.1:${address.port}`;
  const clock = { now: () => new Date('2026-10-17T00:00:00Z') };
  const provider = new OciImageSpecProvider(
    clock,
    { list: () => [{ id: 'codex' }, { id: 'claude-code' }] },
    new OciRegistryClient(),
  );
  const specs: ImageSpecRegistry = {
    defaultProvider: 'oci',
    get: () => provider,
    has: () => true,
    list: () => [provider],
    register: () => {
      throw new Error('fixed fixture registry');
    },
  };
  const repository = new SqliteImageManifestRepository(database.db);
  let id = 0;
  const service = new ImageApplicationService(
    new SqliteImageRepository(database.db),
    repository,
    specs,
    {
      seal: () => {
        throw new Error('no secrets in fixture');
      },
      open: () => {
        throw new Error('no secrets in fixture');
      },
    },
    database.uow,
    { publishInTx: () => {}, subscribe: () => () => {} },
    clock,
    { next: () => `versions-${++id}` },
  );
  const base = await service.registerImage(`${name}/platform/base:latest`, { builtin: true });
  return {
    ...database,
    filename,
    requests,
    publish,
    provider,
    repository,
    service,
    base,
    ref: `${name}/platform/agent:latest`,
  };
}

describe('AC-IMG-062.1/062.2/062.3/062.4 · image CLI declarations · actual OCI HTTP → service → SQLite → DTO', () => {
  it('reads versions from the config only, keeps preflight read-only and lists cached digest metadata offline', async () => {
    const s = await scenario();
    s.publish('platform/agent', '{"codex":"0.163.0","claude-code":"2.1.302-rc.1+arm64"}');
    const changes = s.sqlite.prepare('SELECT total_changes() AS n').get();
    expect(await s.service.validateImage(s.ref)).toMatchObject({
      status: 'valid',
      runtimeVersions: { codex: '0.163.0', 'claude-code': '2.1.302-rc.1+arm64' },
    });
    expect(s.sqlite.prepare('SELECT total_changes() AS n').get()).toEqual(changes);
    const registered = await s.service.registerImage(s.ref);
    expect(ImageManifestSchema.parse(registered.manifest).runtimeVersions).toEqual({
      codex: '0.163.0',
      'claude-code': '2.1.302-rc.1+arm64',
    });
    const requestCount = s.requests.length;
    for (const args of [[], ['codex'], ['codex', 'aio']] as const) {
      expect(
        (await s.service.listImages(...args)).find((row) => row.id === registered.manifest.id)
          ?.runtimeVersions,
      ).toEqual(registered.manifest.runtimeVersions);
    }
    expect(s.requests).toHaveLength(requestCount);
    await s.service.patchImage(registered.manifest.id, {
      isActive: false,
      alias: 'CLI version fixture',
    });
    expect(s.requests).toHaveLength(requestCount);
    expect(
      (await s.service.listImages()).find((row) => row.id === registered.manifest.id)
        ?.runtimeVersions,
    ).toEqual(registered.manifest.runtimeVersions);
    expect(
      s.requests
        .filter((url) => url.includes('/blobs/'))
        .every((url) => !url.endsWith('f'.repeat(64))),
    ).toBe(true);
    s.sqlite.close();
    const reopened = createConnection(s.filename);
    cleanup.push(() => {
      reopened.sqlite.close();
    });
    expect(
      await new SqliteImageManifestRepository(reopened.db).findById(registered.manifest.id),
    ).toMatchObject({ runtimeVersions: registered.manifest.runtimeVersions });
  });

  it('keeps old/no-label declarations unknown despite supportedRuntimes and a versioned base, then backfills the same digest only', async () => {
    const s = await scenario();
    const unknown = await s.service.registerImage(s.ref);
    expect(unknown.manifest).toMatchObject({
      runtimeVersions: {},
      supportedRuntimes: ['codex', 'claude-code'],
      validationStatus: 'valid',
    });
    s.publish('platform/agent', '{"codex":"0.163.0","claude-code":"2.1.302"}');
    const known = await s.service.registerImage(s.ref);
    expect(known.manifest.id).not.toBe(unknown.manifest.id);
    expect(known.manifest.isActive).toBe(false);
    // A real pre-feature row has the same immutable digest but no stored declaration.
    s.sqlite
      .prepare("UPDATE image_manifests SET runtime_versions='{}' WHERE id=?")
      .run(known.manifest.id);
    expect(
      (await s.service.listImages()).find((row) => row.id === known.manifest.id)?.runtimeVersions,
    ).toEqual({});
    const same = await s.service.registerImage(s.ref);
    expect(same.created).toBe(false);
    expect(same.manifest.runtimeVersions).toEqual({ codex: '0.163.0', 'claude-code': '2.1.302' });
    expect(same.manifest.isActive).toBe(false);
    s.sqlite
      .prepare("UPDATE image_manifests SET runtime_versions='{}' WHERE id=?")
      .run(known.manifest.id);
    expect(await s.service.revalidateImage(known.manifest.id)).toMatchObject({
      digestChanged: false,
      runtimeVersions: same.manifest.runtimeVersions,
    });
    const stale = await s.repository.findById(known.manifest.id);
    if (stale === null) throw new Error('missing fixture manifest');
    s.sqlite
      .prepare("UPDATE image_manifests SET runtime_versions='{}' WHERE id=?")
      .run(known.manifest.id);
    const staleEmpty = await s.repository.findById(known.manifest.id);
    if (staleEmpty === null) throw new Error('missing fixture manifest');
    await s.service.revalidateImage(known.manifest.id);
    s.uow.run((tx) => s.repository.saveSync(tx, staleEmpty));
    expect((await s.repository.findById(known.manifest.id))?.runtimeVersions).toEqual(
      same.manifest.runtimeVersions,
    );
    expect(
      (await s.service.listImages()).find((row) => row.id === unknown.manifest.id)?.runtimeVersions,
    ).toEqual({});
  });

  it('never stamps tag drift onto history, and malformed optional labels stay usable with unknown versions', async () => {
    const s = await scenario();
    s.publish('platform/agent', '{"codex":"0.150.1","claude-code":"2.1.251"}');
    const old = await s.service.registerImage(s.ref);
    const before = s.sqlite
      .prepare('SELECT * FROM image_manifests WHERE id=?')
      .get(old.manifest.id);
    s.publish('platform/agent', '{"codex":"0.163.0","claude-code":"2.1.302"}', 2);
    expect(await s.service.checkImageUpdate(old.manifest.id)).toMatchObject({
      current: { digest: old.manifest.digest },
      changed: true,
      upstream: { validation: { runtimeVersions: { codex: '0.163.0', 'claude-code': '2.1.302' } } },
    });
    expect(
      s.sqlite.prepare('SELECT * FROM image_manifests WHERE id=?').get(old.manifest.id),
    ).toEqual(before);
    expect(await s.service.revalidateImage(old.manifest.id)).toMatchObject({
      digestChanged: true,
      currentDigest: old.manifest.digest,
      runtimeVersions: { codex: '0.163.0', 'claude-code': '2.1.302' },
    });
    expect(
      s.sqlite.prepare('SELECT * FROM image_manifests WHERE id=?').get(old.manifest.id),
    ).toEqual(before);
    const current = await s.service.registerImage(s.ref);
    await s.service.activateImage(current.manifest.id);
    expect((await s.service.listImages()).find((row) => row.id === old.manifest.id)).toMatchObject({
      isActive: false,
      runtimeVersions: { codex: '0.150.1', 'claude-code': '2.1.251' },
    });
    s.publish('platform/agent', '{"codex":"<script>bad</script>","claude-code":"2.1.302\\n"}', 3);
    const malformed = await s.service.registerImage(s.ref);
    expect(malformed.manifest).toMatchObject({ runtimeVersions: {}, validationStatus: 'valid' });
    expect(malformed.validation.errors).toEqual([]);
  });
});

describe('AC-IMG-062.1/062.3 · image CLI declarations · committed additive migration', () => {
  it('migrates a real schema28 database to29 while preserving business rows, historical digests and the active pointer', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'img-version-migration-'));
    cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
    mkdirSync(join(directory, 'meta'));
    const committed = resolve(process.cwd(), 'drizzle');
    const journal = JSON.parse(readFileSync(join(committed, 'meta/_journal.json'), 'utf8')) as {
      entries: { tag: string }[];
    };
    const boundary = journal.entries.findIndex(
      (entry) => entry.tag === '0028_image_runtime_versions',
    );
    expect(boundary).toBe(28);
    writeFileSync(
      join(directory, 'meta/_journal.json'),
      JSON.stringify({ ...journal, entries: journal.entries.slice(0, boundary) }),
    );
    for (const entry of journal.entries.slice(0, boundary))
      copyFileSync(join(committed, `${entry.tag}.sql`), join(directory, `${entry.tag}.sql`));
    const sqlite = new Database(':memory:');
    cleanup.push(() => {
      sqlite.close();
    });
    const db = drizzle(sqlite);
    migrate(db, { migrationsFolder: directory });
    sqlite.pragma('foreign_keys = ON');
    sqlite.exec(
      "INSERT INTO images (id,name,is_builtin,created_at) VALUES ('image','registry.test/existing',0,0)",
    );
    const insert = sqlite.prepare(
      "INSERT INTO image_manifests (id,image_id,version,base_image,digest,entrypoint_contract,supported_runtimes,resource_defaults,labels_required,validation_status,is_active,registered_at) VALUES (?,'image','latest','debian',?,'{}','[\"codex\"]','{}','[]','valid',?,0)",
    );
    insert.run('old', `sha256:${'a'.repeat(64)}`, 0);
    insert.run('active', `sha256:${'b'.repeat(64)}`, 1);
    sqlite.exec(
      "INSERT INTO sandboxes (id,project_id,runtime,provider,image_ref,status,headless,created_at,updated_at) VALUES ('task','project','codex','aio','old','stopped',0,0,0)",
    );
    const history = sqlite.prepare('SELECT * FROM image_manifests ORDER BY id').all() as Record<
      string,
      unknown
    >[];
    const tasks = sqlite.prepare('SELECT * FROM sandboxes').all();
    runMigrations(db, sqlite);
    expect(sqlite.prepare('SELECT count(*) AS n FROM __drizzle_migrations').get()).toEqual({
      n: 29,
    });
    const after = sqlite.prepare('SELECT * FROM image_manifests ORDER BY id').all() as Record<
      string,
      unknown
    >[];
    expect(
      after.map(({ runtime_versions, ...row }) => {
        expect(runtime_versions).toBe('{}');
        return row;
      }),
    ).toEqual(history);
    expect(sqlite.prepare('SELECT * FROM sandboxes').all()).toEqual(tasks);
    expect(sqlite.pragma('foreign_key_check')).toEqual([]);
    const repository = new SqliteImageManifestRepository(db);
    expect((await repository.findActiveByVersion('image', 'latest'))?.id).toBe('active');
    expect((await repository.findById('old'))?.runtimeVersions).toEqual({});
    runMigrations(db, sqlite);
    expect(sqlite.prepare('SELECT count(*) AS n FROM __drizzle_migrations').get()).toEqual({
      n: 29,
    });
  });
});
