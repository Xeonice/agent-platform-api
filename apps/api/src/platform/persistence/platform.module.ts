import { Global, Module } from '@nestjs/common';
import {
  CLOCK,
  ID_GENERATOR,
  EVENT_BUS,
  DATABASE,
  UNIT_OF_WORK,
  BUSINESS_WRITER_AUTHORITY,
  coordinatorWorker,
} from '@platform/shared-kernel';
import {
  COORDINATOR_GATEWAY_WORK_FACTORY,
  type CoordinatorGatewayWorkFactory,
} from '@platform/contracts';
import { SystemClock } from '../time/system-clock';
import { UuidIdGenerator } from '../time/uuid-id-generator';
import { InProcessEventBus } from '../events/in-process-event-bus';
import { env } from '../config/env';
import {
  createConnection,
  runMigrations,
  migrationsDir,
  type Connection,
} from './drizzle.connection';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { assertCoordinatorMigrationCompatibility } from './coordinator-schema-compatibility';
import { SqliteUnitOfWork } from './unit-of-work.impl';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import {
  coordinatorWriterControl,
  fenceCoordinatorConnection,
  withCoordinatorBusinessEpoch,
} from './coordinator-lease';
import { platformInstanceId } from '@platform/sandbox';
import { preparedConnection } from './prepared-connection';
import { PLATFORM_SQLITE } from './platform-sqlite.token';
export { PLATFORM_SQLITE } from './platform-sqlite.token';

/** Memoized connection (per database url) — migrations run once on first open. */
const connections = new Map<string, Connection>();
let adoptPrepared: (() => number) | undefined;
function openConnection(): Connection {
  const url = env.databaseUrl;
  let conn = connections.get(url);
  if (!conn) {
    if (process.env.PLATFORM_PROCESS_ROLE === 'coordinator-prepared') {
      const prepared = preparedConnection(url, platformInstanceId());
      adoptPrepared = prepared.activate.bind(prepared);
      connections.set(url, prepared.connection);
      return prepared.connection;
    }
    conn = createConnection(url);
    if (process.env.PLATFORM_PROCESS_ROLE === 'coordinator') {
      assertCoordinatorMigrationCompatibility(
        conn.sqlite,
        readMigrationFiles({ migrationsFolder: migrationsDir() }).length,
        true,
      );
      const sqlite = fenceCoordinatorConnection(
        conn.sqlite,
        platformInstanceId(),
        new SystemClock(),
        new UuidIdGenerator(),
      );
      conn = { sqlite, db: drizzle(sqlite) };
    }
    runMigrations(conn.db, conn.sqlite);
    connections.set(url, conn);
  }
  return conn;
}
export function platformConnection(): Connection {
  return openConnection();
}
export function activatePreparedPlatform(): number {
  if (!adoptPrepared) throw new Error('PREPARED_PLATFORM_REQUIRED');
  return adoptPrepared();
}

/**
 * @Global platform assembly: provides the cross-cutting ports (Clock, IdGenerator,
 * EventBus) and the persistence handles (DATABASE, UNIT_OF_WORK) to every context
 * module without them having to import it. Migrations run when the connection is
 * first opened, so tables exist before any repository is used. The DATABASE /
 * UNIT_OF_WORK factories take NO `inject` (they read the memoized connection
 * directly) — a factory with a local `inject` token is not reliably visible to
 * child modules under the testing injector.
 */
@Global()
@Module({
  providers: [
    {
      provide: COORDINATOR_GATEWAY_WORK_FACTORY,
      useFactory: (): CoordinatorGatewayWorkFactory => ({
        register: (id, stopAdmission) => coordinatorWorker(id, stopAdmission),
      }),
    },
    { provide: CLOCK, useClass: SystemClock },
    { provide: ID_GENERATOR, useClass: UuidIdGenerator },
    { provide: EVENT_BUS, useClass: InProcessEventBus },
    { provide: DATABASE, useFactory: () => openConnection().db },
    { provide: PLATFORM_SQLITE, useFactory: () => openConnection().sqlite },
    { provide: UNIT_OF_WORK, useFactory: () => new SqliteUnitOfWork(openConnection().sqlite) },
    {
      provide: BUSINESS_WRITER_AUTHORITY,
      useFactory: () => ({
        run: <T>(work: () => T): T => withCoordinatorBusinessEpoch(openConnection().sqlite, work),
        epoch: () =>
          ['coordinator', 'coordinator-prepared'].includes(process.env.PLATFORM_PROCESS_ROLE ?? '')
            ? coordinatorWriterControl(openConnection().sqlite).generation
            : 0,
        assert: () => {
          if (
            ['coordinator', 'coordinator-prepared'].includes(
              process.env.PLATFORM_PROCESS_ROLE ?? '',
            )
          )
            coordinatorWriterControl(openConnection().sqlite).assert();
        },
      }),
    },
  ],
  exports: [
    COORDINATOR_GATEWAY_WORK_FACTORY,
    CLOCK,
    ID_GENERATOR,
    EVENT_BUS,
    DATABASE,
    PLATFORM_SQLITE,
    UNIT_OF_WORK,
    BUSINESS_WRITER_AUTHORITY,
  ],
})
export class PlatformModule {}
