import { Global, Module } from '@nestjs/common';
import { CLOCK, ID_GENERATOR, EVENT_BUS, DATABASE, UNIT_OF_WORK } from '@platform/shared-kernel';
import { SystemClock } from '../time/system-clock';
import { UuidIdGenerator } from '../time/uuid-id-generator';
import { InProcessEventBus } from '../events/in-process-event-bus';
import { env } from '../config/env';
import { createConnection, runMigrations, type Connection } from './drizzle.connection';
import { SqliteUnitOfWork } from './unit-of-work.impl';

/** Memoized connection (per database url) — migrations run once on first open. */
const connections = new Map<string, Connection>();
function openConnection(): Connection {
  const url = env.databaseUrl;
  let conn = connections.get(url);
  if (!conn) {
    conn = createConnection(url);
    runMigrations(conn.db);
    connections.set(url, conn);
  }
  return conn;
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
    { provide: CLOCK, useClass: SystemClock },
    { provide: ID_GENERATOR, useClass: UuidIdGenerator },
    { provide: EVENT_BUS, useClass: InProcessEventBus },
    { provide: DATABASE, useFactory: () => openConnection().db },
    { provide: UNIT_OF_WORK, useFactory: () => new SqliteUnitOfWork(openConnection().sqlite) },
  ],
  exports: [CLOCK, ID_GENERATOR, EVENT_BUS, DATABASE, UNIT_OF_WORK],
})
export class PlatformModule {}
