/* Standalone migration runner: `pnpm db:migrate` (09 §2.3 build gate uses it). */
import { env } from '../config/env';
import { createConnection, runMigrations, migrationsDir } from './drizzle.connection';

function main(): void {
  const { db } = createConnection(env.databaseUrl);
  runMigrations(db);
  console.log(`migrations applied from ${migrationsDir()} to ${env.databaseUrl}`);
}

main();
