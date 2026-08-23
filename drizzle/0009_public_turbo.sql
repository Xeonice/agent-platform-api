CREATE TABLE `agent_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`sandbox_id` text NOT NULL,
	`runtime` text NOT NULL,
	`job_handle` text NOT NULL,
	`cursor` text,
	`status` text DEFAULT 'running' NOT NULL,
	`exit_code` integer,
	`session_ref` text,
	`last_seq` integer DEFAULT 0 NOT NULL,
	`stdout_bytes` integer DEFAULT 0 NOT NULL,
	`log_path` text NOT NULL,
	`artifacts` text DEFAULT '[]' NOT NULL,
	`error_code` text,
	`timeout_ms` integer NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`cancel_requested_at` integer,
	FOREIGN KEY (`sandbox_id`) REFERENCES `sandboxes`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "agent_tasks_status_ck" CHECK("agent_tasks"."status" IN ('running','succeeded','failed','killed','timed_out')),
	CONSTRAINT "agent_tasks_finished_ck" CHECK(("agent_tasks"."status" = 'running' AND "agent_tasks"."finished_at" IS NULL) OR ("agent_tasks"."status" <> 'running' AND "agent_tasks"."finished_at" IS NOT NULL)),
	CONSTRAINT "agent_tasks_seq_ck" CHECK("agent_tasks"."last_seq" >= 0),
	CONSTRAINT "agent_tasks_stdout_bytes_ck" CHECK("agent_tasks"."stdout_bytes" >= 0),
	CONSTRAINT "agent_tasks_timeout_ck" CHECK("agent_tasks"."timeout_ms" > 0)
);
--> statement-breakpoint
CREATE INDEX `idx_agent_tasks_sandbox` ON `agent_tasks` (`sandbox_id`);--> statement-breakpoint
CREATE INDEX `idx_agent_tasks_status` ON `agent_tasks` (`status`);