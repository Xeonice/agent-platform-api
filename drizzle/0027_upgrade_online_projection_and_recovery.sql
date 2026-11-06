CREATE TABLE `upgrade_online_migrations` (
 `plan_digest` text PRIMARY KEY NOT NULL, `attempt_id` text NOT NULL, `plan` text NOT NULL,
 `stage` text NOT NULL, `checkpoint` text NOT NULL, `completed_work` integer NOT NULL DEFAULT 0,
 `read_epoch` integer NOT NULL DEFAULT 0, `degraded` integer NOT NULL DEFAULT 0, `reason` text,
 `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `upgrade_projection_changes` (
 `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL, `plan_digest` text NOT NULL,
 `projection` text NOT NULL, `row_key` text NOT NULL, `payload` text, `tombstone` integer NOT NULL,
 `projected` integer NOT NULL DEFAULT 0
);
--> statement-breakpoint
CREATE INDEX `upgrade_projection_pending` ON `upgrade_projection_changes` (`plan_digest`,`projected`,`id`);
--> statement-breakpoint
CREATE TABLE `upgrade_schema_epochs` (`singleton` integer PRIMARY KEY NOT NULL, `schema_version` integer NOT NULL);
--> statement-breakpoint
CREATE TABLE `upgrade_migration_operations` (`operation_id` text PRIMARY KEY NOT NULL, `request_digest` text NOT NULL, `result` text NOT NULL);
--> statement-breakpoint
CREATE TABLE `coordinator_recoveries` (
 `recovery_attempt_id` text PRIMARY KEY NOT NULL, `triggering_attempt_id` text NOT NULL,
 `operation_id` text NOT NULL, `plan_digest` text NOT NULL, `candidate` text NOT NULL,
 `stage` text NOT NULL, `source_generation` integer NOT NULL, `target_generation` integer,
 `quiesced_at` integer, `activated_at` integer, `evidence` text
);

--> statement-breakpoint
CREATE UNIQUE INDEX `coordinator_recoveries_operation_id_unique` ON `coordinator_recoveries` (`operation_id`);

--> statement-breakpoint
CREATE TABLE `agent_task_job_completions` (
 `task_id` text PRIMARY KEY NOT NULL, `sandbox_id` text NOT NULL, `provider` text NOT NULL,
 `job_handle_digest` text NOT NULL, `cursor` text, `last_seq` integer NOT NULL,
 `exit_code` integer, `exit_kind` text NOT NULL, `observed_at` integer NOT NULL, `evidence_digest` text NOT NULL,
 CONSTRAINT `agent_task_job_completions_seq_ck` CHECK(`last_seq`>=0),
 CONSTRAINT `agent_task_job_completions_kind_ck` CHECK(`exit_kind` IN ('natural','timeout','cancelled'))
);
--> statement-breakpoint
CREATE TRIGGER `agent_task_job_completion_no_update` BEFORE UPDATE ON `agent_task_job_completions`
BEGIN SELECT RAISE(ABORT,'job completion receipts are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `agent_task_job_completion_no_delete` BEFORE DELETE ON `agent_task_job_completions`
BEGIN SELECT RAISE(ABORT,'job completion receipts are immutable'); END;
