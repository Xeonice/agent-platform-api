CREATE TABLE `sandbox_state_transitions` (
	`id` text PRIMARY KEY NOT NULL,
	`sandbox_id` text NOT NULL,
	`from_status` text,
	`to_status` text NOT NULL,
	`at` integer NOT NULL,
	`triggered_by` text NOT NULL,
	CONSTRAINT "transitions_to_status_ck" CHECK("sandbox_state_transitions"."to_status" IN ('pending','scheduling','preparing-workspace','creating','starting','running','idle','stopping','stopped','failed','destroying','destroyed')),
	CONSTRAINT "transitions_triggered_by_ck" CHECK("sandbox_state_transitions"."triggered_by" IN ('scheduler','reaper','user','health-check','provider-event'))
);
--> statement-breakpoint
CREATE INDEX `idx_transitions_sandbox` ON `sandbox_state_transitions` (`sandbox_id`);--> statement-breakpoint
CREATE TABLE `sandboxes` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`runtime` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`headless` integer NOT NULL,
	`timeout_minutes` integer,
	`idle_timeout_sec` integer DEFAULT 1800 NOT NULL,
	`quota_cores` real,
	`quota_ram_mb` integer,
	`provider_handle` text,
	`workspace_path` text,
	`version` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "sandboxes_status_ck" CHECK("sandboxes"."status" IN ('pending','scheduling','preparing-workspace','creating','starting','running','idle','stopping','stopped','failed','destroying','destroyed')),
	CONSTRAINT "sandboxes_timeout_ck" CHECK(("sandboxes"."headless" = 1 AND "sandboxes"."timeout_minutes" IN (30,60,120,240)) OR ("sandboxes"."headless" = 0 AND "sandboxes"."timeout_minutes" IS NULL)),
	CONSTRAINT "sandboxes_idle_ck" CHECK("sandboxes"."idle_timeout_sec" > 0)
);
--> statement-breakpoint
CREATE INDEX `idx_sandboxes_project_status` ON `sandboxes` (`project_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_sandboxes_status` ON `sandboxes` (`status`);--> statement-breakpoint
CREATE INDEX `idx_sandboxes_provider_handle` ON `sandboxes` (`provider_handle`);