import { Global, Module } from '@nestjs/common';
import { CLOCK, ID_GENERATOR, EVENT_BUS, DATABASE, UNIT_OF_WORK } from '@platform/shared-kernel';
import { SystemClock } from '../time/system-clock';
import { UuidIdGenerator } from '../time/uuid-id-generator';
import { InProcessEventBus } from '../events/in-process-event-bus';
import { env } from '../config/env';
import { createConnection, runMigrations, type Connection } from './drizzle.connection';
import { SqliteUnitOfWork } from './unit-of-work.impl';

const CONNECTION = Symbol('Connection');

/**
 * @Global platform assembly: provides the cross-cutting ports (Clock, IdGenerator,
 * EventBus) and the persistence handles (DATABASE, UNIT_OF_WORK) to every context
 * module without them having to import it. Migrations run when the connection is
 * created, so tables exist before any repository is used.
 */
@Global()
@Module({
  providers: [
    { provide: CLOCK, useClass: SystemClock },
    { provide: ID_GENERATOR, useClass: UuidIdGenerator },
    { provide: EVENT_BUS, useClass: InProcessEventBus },
    {
      provide: CONNECTION,
      useFactory: (): Connection => {
        const conn = createConnection(env.databaseUrl);
        runMigrations(conn.db);
        return conn;
      },
    },
    { provide: DATABASE, useFactory: (conn: Connection) => conn.db, inject: [CONNECTION] },
    {
      provide: UNIT_OF_WORK,
      useFactory: (conn: Connection) => new SqliteUnitOfWork(conn.sqlite, conn.db),
      inject: [CONNECTION],
    },
  ],
  exports: [CLOCK, ID_GENERATOR, EVENT_BUS, DATABASE, UNIT_OF_WORK],
})
export class PlatformModule {}
