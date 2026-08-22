import { sql } from 'drizzle-orm';
import { sqliteTable, text, integer, check, uniqueIndex } from 'drizzle-orm/sqlite-core';

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

/**
 * `runtime_installations` (13 §2.3.2, aggregate 23 §7.2). One row per
 * (sandbox, runtime); its whole lifetime — INCLUDING the initial value — is written
 * by the sandbox provision workflow's `starting` 段 in its own short transactions,
 * never in the create transaction T1. Two reasons, the second decisive:
 *   - discipline: `RuntimeInstallation` is an independent aggregate (23 D-5), and
 *     23 §4.2 allows one aggregate per transaction (§4.3's two exceptions do not fit);
 *   - timing: the `installed` branch requires an `isInstalled(exec)` probe, and `exec`
 *     derives from `spawn({tty:false})` — at T1 the container does not exist yet, so
 *     the initial value is PHYSICALLY undecidable there.
 *
 * No FK on `runtime_id`: it is a registry key (04 §8), and an FK would require a
 * `runtimes` table — i.e. nailing the plugin system into the database (13 §2.3.3).
 */
export const runtimeInstallations = sqliteTable(
  'runtime_installations',
  {
    id: text('id').primaryKey(),
    sandboxId: text('sandbox_id').notNull(),
    runtimeId: text('runtime_id').notNull(),
    status: text('status').notNull().default('not_installed'),
    versionDetected: text('version_detected'),
    installedAt: integer('installed_at', { mode: 'timestamp' }),
    lastCheckedAt: integer('last_checked_at', { mode: 'timestamp' }).notNull(),
    error: text('error'),
  },
  (t) => ({
    // 23 I-RIN-1
    sandboxRuntimeUq: uniqueIndex('uq_rt_install').on(t.sandboxId, t.runtimeId),
    statusCk: check(
      'runtime_installations_status_ck',
      sql`${t.status} IN ('not_installed','installing','installed','failed')`,
    ),
    // 23 I-RIN-2: an `installed` row must name the version a real `--version` probe saw
    versionCk: check(
      'runtime_installations_version_ck',
      sql`${t.status} <> 'installed' OR ${t.versionDetected} IS NOT NULL`,
    ),
  }),
);

export const runtimeSchema = { runtimeSettings, runtimeInstallations };
export type RuntimeSettingsRow = typeof runtimeSettings.$inferSelect;
export type RuntimeInstallationRow = typeof runtimeInstallations.$inferSelect;
