CREATE TABLE `images` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`owner_ref` text,
	`is_builtin` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `images_name_unique` ON `images` (`name`);--> statement-breakpoint
CREATE TABLE `image_manifests` (
	`id` text PRIMARY KEY NOT NULL,
	`image_id` text NOT NULL,
	`version` text NOT NULL,
	`base_image` text NOT NULL,
	`digest` text NOT NULL,
	`entrypoint_contract` text NOT NULL,
	`supported_runtimes` text NOT NULL,
	`resource_defaults` text NOT NULL,
	`labels_required` text NOT NULL,
	`validation_status` text DEFAULT 'pending' NOT NULL,
	`validation_errors` text,
	`is_active` integer DEFAULT true NOT NULL,
	`image_config` text,
	`registered_at` integer NOT NULL,
	FOREIGN KEY (`image_id`) REFERENCES `images`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "image_manifests_validation_status_ck" CHECK("image_manifests"."validation_status" IN ('pending','valid','warning','invalid')),
	CONSTRAINT "image_manifests_digest_ck" CHECK("image_manifests"."digest" IS NOT NULL AND length("image_manifests"."digest") > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_manifest_digest` ON `image_manifests` (`image_id`,`digest`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_manifest_active_tag` ON `image_manifests` (`image_id`,`version`) WHERE "image_manifests"."is_active";--> statement-breakpoint
CREATE INDEX `idx_manifest_validation_status` ON `image_manifests` (`validation_status`);--> statement-breakpoint
CREATE INDEX `idx_manifest_image` ON `image_manifests` (`image_id`);--> statement-breakpoint
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
	`failure_code` text,
	`failure_reason` text,
	`version` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`image_ref`) REFERENCES `image_manifests`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "sandboxes_status_ck" CHECK("__new_sandboxes"."status" IN ('pending','scheduling','preparing-workspace','creating','starting','running','idle','stopping','stopped','failed','destroying','destroyed')),
	CONSTRAINT "sandboxes_timeout_ck" CHECK(("__new_sandboxes"."headless" = 1 AND "__new_sandboxes"."timeout_minutes" IN (30,60,120,240)) OR ("__new_sandboxes"."headless" = 0 AND "__new_sandboxes"."timeout_minutes" IS NULL)),
	CONSTRAINT "sandboxes_idle_ck" CHECK("__new_sandboxes"."idle_timeout_sec" > 0),
	CONSTRAINT "sandboxes_initial_prompt_len_ck" CHECK("__new_sandboxes"."initial_prompt" IS NULL OR length("__new_sandboxes"."initial_prompt") <= 8000),
	CONSTRAINT "sandboxes_initial_prompt_consumed_ck" CHECK("__new_sandboxes"."initial_prompt_consumed_at" IS NULL OR "__new_sandboxes"."initial_prompt" IS NOT NULL)
);
--> statement-breakpoint
INSERT INTO `__new_sandboxes` (
	`id`, `project_id`, `name`, `runtime`, `image_ref`, `provider`, `status`, `headless`,
	`timeout_minutes`, `idle_timeout_sec`, `quota_cores`, `quota_ram_mb`, `provider_handle`,
	`workspace_path`, `agent_endpoint_port`, `agent_auth_token`, `initial_prompt`,
	`initial_prompt_consumed_at`, `failure_code`, `failure_reason`, `version`, `created_at`, `updated_at`
)
SELECT
	`id`, `project_id`, `name`, `runtime`, NULL, `provider`, `status`, `headless`,
	`timeout_minutes`, `idle_timeout_sec`, `quota_cores`, `quota_ram_mb`, `provider_handle`,
	`workspace_path`, `agent_endpoint_port`, `agent_auth_token`, `initial_prompt`,
	`initial_prompt_consumed_at`, `failure_code`, `failure_reason`, `version`, `created_at`, `updated_at`
FROM `sandboxes`;--> statement-breakpoint
DROP TABLE `sandboxes`;--> statement-breakpoint
ALTER TABLE `__new_sandboxes` RENAME TO `sandboxes`;--> statement-breakpoint
CREATE INDEX `idx_sandboxes_project_status` ON `sandboxes` (`project_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_sandboxes_status` ON `sandboxes` (`status`);--> statement-breakpoint
CREATE INDEX `idx_sandboxes_provider_handle` ON `sandboxes` (`provider_handle`);--> statement-breakpoint
CREATE INDEX `idx_sandboxes_image_ref` ON `sandboxes` (`image_ref`);
