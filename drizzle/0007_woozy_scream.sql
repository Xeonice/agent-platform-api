CREATE TABLE `runtime_installations` (
	`id` text PRIMARY KEY NOT NULL,
	`sandbox_id` text NOT NULL,
	`runtime_id` text NOT NULL,
	`status` text DEFAULT 'not_installed' NOT NULL,
	`version_detected` text,
	`installed_at` integer,
	`last_checked_at` integer NOT NULL,
	`error` text,
	CONSTRAINT "runtime_installations_status_ck" CHECK("runtime_installations"."status" IN ('not_installed','installing','installed','failed')),
	CONSTRAINT "runtime_installations_version_ck" CHECK("runtime_installations"."status" <> 'installed' OR "runtime_installations"."version_detected" IS NOT NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_rt_install` ON `runtime_installations` (`sandbox_id`,`runtime_id`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_sandboxes` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text,
	`runtime` text NOT NULL,
	`image_ref` text,
	`provider` text DEFAULT 'aio' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`headless` integer NOT NULL,
	`timeout_minutes` integer,
	`idle_timeout_sec` integer DEFAULT 1800 NOT NULL,
	`quota_cores` real,
	`quota_ram_mb` integer,
	`provider_handle` text,
	`workspace_path` text,
	`agent_endpoint_port` integer,
	`agent_auth_token` text,
	`initial_prompt` text,
	`initial_prompt_consumed_at` integer,
	`failure_reason` text,
	`version` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "sandboxes_status_ck" CHECK("__new_sandboxes"."status" IN ('pending','scheduling','preparing-workspace','creating','starting','running','idle','stopping','stopped','failed','destroying','destroyed')),
	CONSTRAINT "sandboxes_timeout_ck" CHECK(("__new_sandboxes"."headless" = 1 AND "__new_sandboxes"."timeout_minutes" IN (30,60,120,240)) OR ("__new_sandboxes"."headless" = 0 AND "__new_sandboxes"."timeout_minutes" IS NULL)),
	CONSTRAINT "sandboxes_idle_ck" CHECK("__new_sandboxes"."idle_timeout_sec" > 0),
	CONSTRAINT "sandboxes_initial_prompt_len_ck" CHECK("__new_sandboxes"."initial_prompt" IS NULL OR length("__new_sandboxes"."initial_prompt") <= 8000),
	CONSTRAINT "sandboxes_initial_prompt_consumed_ck" CHECK("__new_sandboxes"."initial_prompt_consumed_at" IS NULL OR "__new_sandboxes"."initial_prompt" IS NOT NULL)
);
--> statement-breakpoint
-- ============================================================================
-- ⚠️  HAND-EDITED. DO NOT REPLACE THIS FILE WITH A FRESH `drizzle-kit generate`.
--
-- WHY the generated version is WRONG (and will be wrong again if regenerated):
--   SQLite cannot ADD a column that carries a CHECK constraint, so drizzle-kit
--   rewrites the whole table (create `__new_sandboxes` → copy → drop → rename).
--   It builds the copy statement as `INSERT INTO __new(<NEW columns>) SELECT <the
--   SAME NEW column list> FROM sandboxes` — i.e. it selects columns that exist only
--   on the NEW table. On an EMPTY database that never executes far enough to matter;
--   on any database that already holds sandbox rows it fails with
--   `no such column: name`, and the migration aborts mid-rebuild.
--
-- THE FIX BELOW: the five columns S5 introduces (`name`, `image_ref`,
--   `initial_prompt`, `initial_prompt_consumed_at`, `failure_reason`) are selected as
--   NULL instead of by name. NULL is also their CORRECT value for a pre-S5 sandbox:
--   it had no task name, no recorded image, and no instruction to consume.
--
-- IF YOU MUST REGENERATE: re-apply exactly this edit, and verify against a database
--   that already contains a `sandboxes` row — an empty-DB test cannot catch this.
-- ============================================================================
INSERT INTO `__new_sandboxes`("id", "project_id", "name", "runtime", "image_ref", "provider", "status", "headless", "timeout_minutes", "idle_timeout_sec", "quota_cores", "quota_ram_mb", "provider_handle", "workspace_path", "agent_endpoint_port", "agent_auth_token", "initial_prompt", "initial_prompt_consumed_at", "failure_reason", "version", "created_at", "updated_at") SELECT "id", "project_id", NULL, "runtime", NULL, "provider", "status", "headless", "timeout_minutes", "idle_timeout_sec", "quota_cores", "quota_ram_mb", "provider_handle", "workspace_path", "agent_endpoint_port", "agent_auth_token", NULL, NULL, NULL, "version", "created_at", "updated_at" FROM `sandboxes`;--> statement-breakpoint
DROP TABLE `sandboxes`;--> statement-breakpoint
ALTER TABLE `__new_sandboxes` RENAME TO `sandboxes`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_sandboxes_project_status` ON `sandboxes` (`project_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_sandboxes_status` ON `sandboxes` (`status`);--> statement-breakpoint
CREATE INDEX `idx_sandboxes_provider_handle` ON `sandboxes` (`provider_handle`);