CREATE TABLE `automation_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`automation_id` text NOT NULL,
	`sandbox_id` text,
	`triggered_at` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`error_code` text,
	`error_message` text,
	`retry_count` integer DEFAULT 0 NOT NULL,
	`retry_at` integer,
	`started_at` integer,
	`completed_at` integer,
	`duration_sec` integer,
	`output_summary` text,
	`log_path` text,
	`log_bytes` integer,
	`webhook_status` text,
	`outcome_applied` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`automation_id`) REFERENCES `automations`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "automation_runs_status_ck" CHECK("automation_runs"."status" IN ('pending','running','success','failed','timeout','resource-exhausted','skipped','missed')),
	CONSTRAINT "automation_runs_retry_count_ck" CHECK("automation_runs"."retry_count" BETWEEN 0 AND 5),
	CONSTRAINT "automation_runs_log_bytes_ck" CHECK("automation_runs"."log_bytes" IS NULL OR "automation_runs"."log_bytes" <= 31457280),
	CONSTRAINT "automation_runs_webhook_status_ck" CHECK("automation_runs"."webhook_status" IS NULL OR "automation_runs"."webhook_status" IN ('sent','failed','skipped'))
);
--> statement-breakpoint
CREATE INDEX `automation_runs_automation_triggered_idx` ON `automation_runs` (`automation_id`,`triggered_at`);--> statement-breakpoint
CREATE INDEX `automation_runs_status_retry_idx` ON `automation_runs` (`status`,`retry_at`);--> statement-breakpoint
CREATE INDEX `automation_runs_outcome_idx` ON `automation_runs` (`outcome_applied`,`status`);--> statement-breakpoint
CREATE TABLE `automations` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`runtime_id` text NOT NULL,
	`prompt` text NOT NULL,
	`schedule_kind` text NOT NULL,
	`schedule_config` text NOT NULL,
	`timezone` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`degraded` integer DEFAULT false NOT NULL,
	`concurrency_mode` text DEFAULT 'skip' NOT NULL,
	`artifact_retention_days` integer DEFAULT 7 NOT NULL,
	`timeout_minutes` integer DEFAULT 120 NOT NULL,
	`webhook_url` text,
	`trigger_on` text DEFAULT 'failure' NOT NULL,
	`consecutive_failures` integer DEFAULT 0 NOT NULL,
	`last_triggered_at` integer,
	`next_trigger_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "automations_schedule_kind_ck" CHECK("automations"."schedule_kind" IN ('hourly','daily','weekly')),
	CONSTRAINT "automations_timeout_ck" CHECK("automations"."timeout_minutes" IN (30,60,120,240)),
	CONSTRAINT "automations_retention_ck" CHECK("automations"."artifact_retention_days" IN (3,7,30)),
	CONSTRAINT "automations_trigger_on_ck" CHECK("automations"."trigger_on" IN ('failure','success','all')),
	CONSTRAINT "automations_concurrency_ck" CHECK("automations"."concurrency_mode" IN ('skip','queue','concurrent')),
	CONSTRAINT "automations_prompt_len_ck" CHECK(length("automations"."prompt") <= 8000),
	CONSTRAINT "automations_failures_ck" CHECK("automations"."consecutive_failures" >= 0),
	CONSTRAINT "automations_timezone_ck" CHECK(length("automations"."timezone") > 0)
);
--> statement-breakpoint
CREATE INDEX `automations_project_idx` ON `automations` (`project_id`);--> statement-breakpoint
CREATE INDEX `automations_enabled_next_trigger_idx` ON `automations` (`enabled`,`next_trigger_at`);