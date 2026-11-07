import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Server } from 'node:http';
import {
  ConsoleLogger,
  Controller,
  Get,
  Global,
  HttpException,
  Inject,
  Logger,
  Module,
  type INestApplication,
} from '@nestjs/common';
import { createRequire } from 'node:module';
import { CLOCK } from '@platform/shared-kernel';
import { Test } from '@nestjs/testing';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import {
  prepareCoordinatorHttpTransport,
  preparedCoordinatorBusinessTransportReady,
  attachPreparedCoordinatorLogger,
} from '../../../apps/api/src/roles/coordinator-prepared-main';
import {
  LoggingModule,
  RuntimeLogWriter,
  RUNTIME_LOG_WRITER,
} from '../../../apps/api/src/platform/logging';
import { preparedConnection } from '../../../apps/api/src/platform/persistence/prepared-connection';
import {
  coordinatorWriterControl,
  fenceCoordinatorConnection,
} from '../../../apps/api/src/platform/persistence/coordinator-lease';
import { readPublicNetworkConfig } from '../../../apps/api/src/platform/config/public-network';
import { DeploymentState } from '../../../apps/api/src/platform/deployment/deployment-state';
import { useEnv } from '../../support/strict-ports';

const SQLITE = Symbol('prepared-transport-test-sqlite');
const { NestFactory } = createRequire(resolve('apps/api/package.json'))('@nestjs/core');
@Global()
@Module({
  providers: [{ provide: CLOCK, useValue: { now: () => new Date('2026-11-07T00:00:00.000Z') } }],
  exports: [CLOCK],
})
class PreparedLogClock {}
@Module({})
class PreparedLogModule {}
@Controller('prepared-log-proof')
class PreparedLogProof {
  @Get() capacity() {
    new Logger('prepared-capacity').warn('PROVIDER_UNAVAILABLE workspace unconfirmed');
    throw new HttpException({ code: 'PROVIDER_UNAVAILABLE' }, 409);
  }
}
@Controller('prepared-transport-proof')
class PreparedTransportProof {
  constructor(@Inject(SQLITE) private readonly sqlite: Database.Database) {}
  @Get() read() {
    return this.sqlite.prepare('SELECT count(*) n FROM transport_hooks').get();
  }
}
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

describe('REQ-UPG-001/006 — actual prepared HTTP listener and SQLite writer boundary', () => {
  it('flushes real Nest startup logs before initialization and keeps later capacity rejections in the existing redacted writer', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'prepared-real-logger-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    cleanup.push(() => {
      Logger.overrideLogger(new ConsoleLogger());
    });
    let hooks = 0;
    const app: INestApplication = await NestFactory.create(
      {
        module: PreparedLogModule,
        imports: [PreparedLogClock, LoggingModule.forRoot({ dir })],
        controllers: [PreparedLogProof],
        providers: [
          {
            provide: 'prepared-log-hook',
            useValue: {
              onApplicationBootstrap() {
                hooks++;
                new Logger('prepared-hook').log('actual init hook completed');
              },
            },
          },
        ],
      },
      { bufferLogs: true, abortOnError: false },
    );
    cleanup.push(() => app.close());
    const writer = app.get<RuntimeLogWriter>(RUNTIME_LOG_WRITER);
    new Logger('prepared-startup').warn(
      'startup buffered sk-ant-oat01-fixture_secret_abcdefghijkl',
    );
    attachPreparedCoordinatorLogger(app);
    await expect.poll(() => readFile(writer.currentPath, 'utf8')).toContain('startup buffered');
    expect(hooks).toBe(0);
    await app.listen(0, '127.0.0.1');
    await request(app.getHttpServer())
      .get('/prepared-log-proof')
      .expect(409, { code: 'PROVIDER_UNAVAILABLE' });
    expect(hooks).toBe(1);
    await app.close();
    const body = await readFile(writer.currentPath, 'utf8');
    expect(body).toContain('actual init hook completed');
    expect(body).toContain('PROVIDER_UNAVAILABLE workspace unconfirmed');
    expect(body).toContain('sk-ant-oat01-***');
    expect(body).not.toContain('fixture_secret_abcdefghijkl');
    expect(body.match(/startup buffered/g)).toHaveLength(1);
    await writer.close();
    expect(await readFile(writer.currentPath, 'utf8')).toBe(body);
  });

  async function fixture(failHook = false) {
    const directory = mkdtempSync(join(tmpdir(), 'upg-prepared-http-'));
    cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
    cleanup.push(
      useEnv({ COORDINATOR_GENERATION: undefined, COORDINATOR_WRITER_FENCE_VALID: undefined }),
    );
    const filename = join(directory, 'state.db');
    const raw = new Database(filename);
    raw.pragma('journal_mode = WAL');
    const source = fenceCoordinatorConnection(
      raw,
      'prepared-transport-test',
      { now: () => new Date() },
      { next: randomUUID },
    );
    migrate(drizzle(source), { migrationsFolder: resolve('drizzle') });
    source.exec('CREATE TABLE transport_hooks(value TEXT)');
    cleanup.push(() => {
      source.close();
    });
    const prepared = preparedConnection(filename, 'prepared-transport-test');
    cleanup.push(() => {
      prepared.connection.sqlite.close();
    });
    let hooks = 0;
    const module = await Test.createTestingModule({
      controllers: [PreparedTransportProof],
      providers: [
        DeploymentState,
        { provide: SQLITE, useValue: prepared.connection.sqlite },
        {
          provide: 'actual-nest-bootstrap-hook',
          useValue: {
            onApplicationBootstrap() {
              hooks++;
              if (failHook) throw new Error('DECLARED_BOOTSTRAP_FAILURE');
              prepared.connection.sqlite
                .prepare("INSERT INTO transport_hooks VALUES('candidate')")
                .run();
            },
          },
        },
      ],
    }).compile();
    const app = module.createNestApplication();
    cleanup.push(async () => {
      await app.close();
      expect((app.getHttpServer() as Server).listening).toBe(false);
    });
    let ready = false;
    const initialize = await prepareCoordinatorHttpTransport(
      app,
      readPublicNetworkConfig(),
      { host: '127.0.0.1', port: 0 },
      () => ready,
    );
    return {
      app,
      source,
      prepared,
      initialize,
      hooks: () => hooks,
      ready: () => {
        ready = true;
      },
    };
  }

  it('binds the real socket without executing hooks or gaining a second writer, then initializes on the acquired epoch', async () => {
    const f = await fixture();
    await request(f.app.getHttpServer()).get('/api/prepared-transport-proof').expect(425);
    expect(f.hooks()).toBe(0);
    expect(f.prepared.connection.sqlite.readonly).toBe(true);
    expect(f.source.prepare('SELECT count(*) n FROM transport_hooks').get()).toEqual({ n: 0 });
    expect(() => f.prepared.activate()).toThrow('COORDINATOR_WRITER_ALREADY_ACTIVE');
    coordinatorWriterControl(f.source).release();
    expect(f.prepared.activate()).toBe(2);
    await f.initialize();
    expect(f.hooks()).toBe(1);
    // Hook success alone is not permission to publish the candidate.
    await request(f.app.getHttpServer()).get('/api/prepared-transport-proof').expect(425);
    f.ready();
    const response = await request(f.app.getHttpServer())
      .get('/api/prepared-transport-proof')
      .expect(200);
    expect(response.body).toEqual({ n: 1 });
    expect(() => f.source.prepare("INSERT INTO transport_hooks VALUES('stale')").run()).toThrow(
      'COORDINATOR_WRITER_FENCE_EXPIRED',
    );
  });

  it('retains the closed admission gate when a real activation hook fails', async () => {
    const f = await fixture(true);
    coordinatorWriterControl(f.source).release();
    f.prepared.activate();
    await expect(f.initialize()).rejects.toThrow('DECLARED_BOOTSTRAP_FAILURE');
    await request(f.app.getHttpServer()).get('/api/prepared-transport-proof').expect(425);
    expect(f.hooks()).toBe(1);
  });
  it('withdraws transport identity when the actual reserved listener closes before adoption', async () => {
    const f = await fixture();
    expect(preparedCoordinatorBusinessTransportReady(f.app)).toBe(true);
    await new Promise<void>((ok, fail) => {
      (f.app.getHttpServer() as Server).close((error) => (error ? fail(error) : ok()));
    });
    expect(preparedCoordinatorBusinessTransportReady(f.app)).toBe(false);
    expect(f.hooks()).toBe(0);
    expect(() => coordinatorWriterControl(f.source).assert()).not.toThrow();
    expect(f.prepared.connection.sqlite.readonly).toBe(true);
  });
  it('rejects a real port collision before hooks or writer release', async () => {
    const f = await fixture();
    const module = await Test.createTestingModule({ providers: [DeploymentState] }).compile();
    const collision = module.createNestApplication();
    cleanup.push(() => collision.close());
    const address = (f.app.getHttpServer() as Server).address();
    if (!address || typeof address === 'string') throw new Error('Actual TCP listener required');
    const port = address.port;
    await expect(
      prepareCoordinatorHttpTransport(
        collision,
        readPublicNetworkConfig(),
        { host: '127.0.0.1', port },
        () => false,
      ),
    ).rejects.toMatchObject({ code: 'EADDRINUSE' });
    expect(f.hooks()).toBe(0);
    expect(() => coordinatorWriterControl(f.source).assert()).not.toThrow();
    expect(f.prepared.connection.sqlite.readonly).toBe(true);
  });
});
