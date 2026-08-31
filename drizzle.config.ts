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
    './packages/modules/sandbox/src/infrastructure/persistence/schema/agent-task.sqlite.ts',
    './packages/modules/sandbox/src/infrastructure/persistence/schema/resource-allocation.sqlite.ts',
    './packages/modules/project/src/infrastructure/persistence/schema/project.sqlite.ts',
    './packages/modules/project/src/infrastructure/persistence/schema/retained-volume.sqlite.ts',
    './packages/modules/automation/src/infrastructure/persistence/schema/automation.sqlite.ts',
    './packages/modules/credential/src/infrastructure/persistence/schema/credential.sqlite.ts',
    './packages/modules/credential/src/infrastructure/persistence/schema/credential-sandbox-binding.sqlite.ts',
    './packages/modules/runtime/src/infrastructure/persistence/schema/runtime.sqlite.ts',
    './packages/modules/image/src/infrastructure/persistence/schema/image.sqlite.ts',
    // 平台级表（13 §2.8）。落在 apps/api 而不是某个 module —— 理由写在 schema 文件顶部。
    './apps/api/src/platform/audit/audit-events.sqlite.ts',
    './apps/api/src/platform/system/system-settings.sqlite.ts',
  ],
  out: './drizzle',
});
