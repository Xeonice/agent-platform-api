import { sql } from 'drizzle-orm';
import { sqliteTable, text, integer, check } from 'drizzle-orm/sqlite-core';

/**
 * Drizzle SQLite schema for the runtime context (docs/backend/13 §2.3.1). Single
 * row per runtime; `runtime_id` (a registry key, NOT an FK — 13 §2.3.3) is the PK.
 * `active_auth_method` is the two-way global switch `materialize` selects by.
 * Cross-dialect discipline (13 §1): enum = text + CHECK; timestamps are JS Date.
 */
export const runtimeSettings = sqliteTable(
  'runtime_settings',
  {
    runtimeId: text('runtime_id').primaryKey(),
    activeAuthMethod: text('active_auth_method').notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
  },
  (t) => ({
    activeAuthMethodCk: check(
      'runtime_settings_active_auth_method_ck',
      sql`${t.activeAuthMethod} IN ('account','api-key')`,
    ),
  }),
);

export const runtimeSchema = { runtimeSettings };
export type RuntimeSettingsRow = typeof runtimeSettings.$inferSelect;
