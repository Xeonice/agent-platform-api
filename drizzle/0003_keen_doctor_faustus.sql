CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`source_type` text NOT NULL,
	`repo_url` text,
	`repo_branch` text,
	`clone_status` text DEFAULT 'cloning' NOT NULL,
	`clone_error_code` text,
	`baseline_path` text NOT NULL,
	`baseline_size_bytes` integer,
	`workspace_mode` text DEFAULT 'copy' NOT NULL,
	`version` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "projects_source_type_ck" CHECK("projects"."source_type" IN ('git','empty')),
	CONSTRAINT "projects_clone_status_ck" CHECK("projects"."clone_status" IN ('cloning','ready','failed')),
	CONSTRAINT "projects_clone_error_ck" CHECK("projects"."clone_error_code" IS NULL OR "projects"."clone_error_code" IN ('CLONE_FAILED_PERMISSION','CLONE_FAILED_NETWORK','TIMEOUT','INTERRUPTED','DISK_INSUFFICIENT')),
	CONSTRAINT "projects_source_url_ck" CHECK(("projects"."source_type" = 'git' AND "projects"."repo_url" IS NOT NULL) OR ("projects"."source_type" = 'empty' AND "projects"."repo_url" IS NULL)),
	CONSTRAINT "projects_failed_error_ck" CHECK(("projects"."clone_status" = 'failed' AND "projects"."clone_error_code" IS NOT NULL) OR ("projects"."clone_status" != 'failed' AND "projects"."clone_error_code" IS NULL)),
	CONSTRAINT "projects_workspace_mode_ck" CHECK("projects"."workspace_mode" IN ('copy')),
	CONSTRAINT "projects_name_len_ck" CHECK(length("projects"."name") BETWEEN 1 AND 40)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `projects_name_unique` ON `projects` (`name`);