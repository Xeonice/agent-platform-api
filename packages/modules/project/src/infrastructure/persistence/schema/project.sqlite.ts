import { sql } from 'drizzle-orm';
import { sqliteTable, text, integer, check } from 'drizzle-orm/sqlite-core';

/**
 * Drizzle SQLite schema for the project context (docs/backend/13 §2.2).
 *
 * Cross-dialect discipline (13 §1 / 28 §3): enums = text + CHECK; no `.array()`;
 * timestamps are JS Date (integer timestamp mode). Each CHECK carries its I-PRJ id.
 */
export const projects = sqliteTable(
  'projects',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull().unique(), // I-PRJ-4: names are unique
    sourceType: text('source_type').notNull(),
    repoUrl: text('repo_url'),
    repoBranch: text('repo_branch'),
    cloneStatus: text('clone_status').notNull().default('cloning'),
    cloneErrorCode: text('clone_error_code'),
    baselinePath: text('baseline_path').notNull(),
    baselineSizeBytes: integer('baseline_size_bytes'),
    workspaceMode: text('workspace_mode').notNull().default('copy'),
    version: integer('version').notNull().default(0),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
  },
  (t) => ({
    // 13 §2.2: source_type ∈ {git, empty}
    sourceTypeCk: check('projects_source_type_ck', sql`${t.sourceType} IN ('git','empty')`),
    // 13 §2.2: clone_status ∈ {cloning, ready, failed}
    cloneStatusCk: check(
      'projects_clone_status_ck',
      sql`${t.cloneStatus} IN ('cloning','ready','failed')`,
    ),
    // 03 §7.5: clone_error_code ∈ 5 values (when present)
    cloneErrorCk: check(
      'projects_clone_error_ck',
      sql`${t.cloneErrorCode} IS NULL OR ${t.cloneErrorCode} IN ('CLONE_FAILED_PERMISSION','CLONE_FAILED_NETWORK','TIMEOUT','INTERRUPTED','DISK_INSUFFICIENT')`,
    ),
    // I-PRJ-1: git ⇒ repo_url present; empty ⇒ repo_url null
    sourceUrlCk: check(
      'projects_source_url_ck',
      sql`(${t.sourceType} = 'git' AND ${t.repoUrl} IS NOT NULL) OR (${t.sourceType} = 'empty' AND ${t.repoUrl} IS NULL)`,
    ),
    // I-PRJ-2: failed ⇔ clone_error_code present
    failedErrorCk: check(
      'projects_failed_error_ck',
      sql`(${t.cloneStatus} = 'failed' AND ${t.cloneErrorCode} IS NOT NULL) OR (${t.cloneStatus} != 'failed' AND ${t.cloneErrorCode} IS NULL)`,
    ),
    workspaceModeCk: check('projects_workspace_mode_ck', sql`${t.workspaceMode} IN ('copy')`),
    // I-PRJ-4: name length 1–40
    nameLenCk: check('projects_name_len_ck', sql`length(${t.name}) BETWEEN 1 AND 40`),
  }),
);

export const projectSchema = { projects };
export type ProjectRow = typeof projects.$inferSelect;
export type ProjectInsert = typeof projects.$inferInsert;
