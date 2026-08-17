import { defineConfig } from 'drizzle-kit';

/**
 * drizzle-kit config (docs/backend/13). SQLite dialect; the schema is the single
 * source and `pnpm db:generate` writes versioned migrations into ./drizzle,
 * which are committed and applied by the migrator at runtime and in tests.
 */
export default defineConfig({
  dialect: 'sqlite',
  schema: [
    './packages/modules/sandbox/src/infrastructure/persistence/schema/sandbox.sqlite.ts',
    './packages/modules/project/src/infrastructure/persistence/schema/project.sqlite.ts',
  ],
  out: './drizzle',
});
