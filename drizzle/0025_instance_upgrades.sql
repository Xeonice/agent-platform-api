CREATE TABLE `upgrade_instances` (
  `instance_id` text PRIMARY KEY NOT NULL,
  `activation_generation` integer NOT NULL DEFAULT 0,
  `confirmed_release` text,
  `service_state` text NOT NULL DEFAULT 'unknown',
  `ready` integer NOT NULL DEFAULT 0,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `upgrade_attempts` (
  `attempt_id` text PRIMARY KEY NOT NULL,
  `instance_id` text NOT NULL REFERENCES `upgrade_instances`(`instance_id`),
  `actor_id` text NOT NULL,
  `request_id` text NOT NULL,
  `request_digest` text NOT NULL,
  `target_release_id` text NOT NULL,
  `target_digest` text NOT NULL,
  `manifest` text NOT NULL,
  `plan` text NOT NULL,
  `source_activation` text NOT NULL,
  `source_actual` text,
  `generation` integer NOT NULL,
  `sequence` integer NOT NULL DEFAULT 0,
  `state` text NOT NULL DEFAULT 'accepted',
  `stage` text NOT NULL DEFAULT 'accepted',
  `reason` text,
  `controller_id` text,
  `fence` integer NOT NULL DEFAULT 0,
  `lease_expires_at` integer NOT NULL DEFAULT 0,
  `accepted_at` integer NOT NULL,
  `observed_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `upgrade_one_active_attempt` ON `upgrade_attempts` (`instance_id`)
WHERE `state` IN ('accepted','downloading','package-verified','migrating','prepared','candidate-ready','routing-switched','observing','api-activated');
--> statement-breakpoint
CREATE TABLE `upgrade_events` (
  `event_id` text PRIMARY KEY NOT NULL,
  `attempt_id` text NOT NULL REFERENCES `upgrade_attempts`(`attempt_id`),
  `event_digest` text NOT NULL,
  `generation` integer NOT NULL,
  `sequence` integer NOT NULL,
  `fence` integer NOT NULL,
  `kind` text NOT NULL,
  `payload` text NOT NULL,
  `recorded_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TRIGGER `upgrade_event_no_update` BEFORE UPDATE ON `upgrade_events`
BEGIN SELECT RAISE(ABORT, 'upgrade events are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `upgrade_event_no_delete` BEFORE DELETE ON `upgrade_events`
BEGIN SELECT RAISE(ABORT, 'upgrade events are immutable'); END;
--> statement-breakpoint
CREATE TABLE `upgrade_steps` (
  `attempt_id` text NOT NULL REFERENCES `upgrade_attempts`(`attempt_id`),
  `step_id` text NOT NULL,
  `completed_work` real NOT NULL DEFAULT 0,
  `applied` integer NOT NULL DEFAULT 0,
  `receipt_digest` text,
  `evidence` text,
  `applied_at` integer,
  PRIMARY KEY (`attempt_id`,`step_id`)
);
--> statement-breakpoint
CREATE TABLE `upgrade_recoveries` (
  `recovery_attempt_id` text PRIMARY KEY NOT NULL,
  `triggering_attempt_id` text NOT NULL REFERENCES `upgrade_attempts`(`attempt_id`),
  `instance_id` text NOT NULL REFERENCES `upgrade_instances`(`instance_id`),
  `generation` integer NOT NULL,
  `sequence` integer NOT NULL,
  `state` text NOT NULL,
  `plan` text NOT NULL,
  `plan_digest` text NOT NULL,
  `reason` text NOT NULL,
  `observed_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `platform_role_leases` (
  `role` text PRIMARY KEY NOT NULL,
  `instance_id` text NOT NULL,
  `holder_id` text NOT NULL,
  `generation` integer NOT NULL,
  `fence` integer NOT NULL,
  `expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `platform_operations` (
  `operation_id` text PRIMARY KEY NOT NULL,
  `instance_id` text NOT NULL,
  `actor_id` text NOT NULL,
  `role` text NOT NULL,
  `fence` integer NOT NULL,
  `request_digest` text NOT NULL,
  `state` text NOT NULL,
  `result` text,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `agent_task_start_intents` (
  `task_id` text PRIMARY KEY NOT NULL,
  `sandbox_id` text NOT NULL,
  `provider` text NOT NULL,
  `payload` text NOT NULL,
  `state` text NOT NULL DEFAULT 'pending',
  `created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sandbox_create_intents` (
  `sandbox_id` text PRIMARY KEY NOT NULL,
  `operation_id` text NOT NULL,
  `request_digest` text NOT NULL,
  `workspace_path` text NOT NULL,
  `state` text NOT NULL DEFAULT 'pending',
  `created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `terminal_bookmarks` (
  `terminal_identity` text PRIMARY KEY NOT NULL,
  `sandbox_id` text NOT NULL,
  `kind` text NOT NULL,
  `private_session_id` text NOT NULL,
  `runtime_id` text,
  `runtime_identity` text,
  `close_requested_at` integer
);
--> statement-breakpoint
CREATE TABLE `upgrade_continuity_baselines` (
  `attempt_id` text PRIMARY KEY NOT NULL REFERENCES `upgrade_attempts`(`attempt_id`),
  `snapshot` text NOT NULL,
  `digest` text NOT NULL,
  `captured_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `upgrade_probe_records` (
  `request_id` text PRIMARY KEY NOT NULL,
  `attempt_id` text NOT NULL,
  `value` text NOT NULL,
  `revision` integer NOT NULL,
  `committed_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `coordinator_handoffs` (
  `attempt_id` text PRIMARY KEY NOT NULL,
  `operation_id` text NOT NULL,
  `plan_digest` text NOT NULL,
  `candidate` text NOT NULL,
  `stage` text NOT NULL,
  `source_generation` integer NOT NULL,
  `target_generation` integer,
  `quiesced_at` integer,
  `activated_at` integer,
  `evidence` text
);
--> statement-breakpoint
CREATE TABLE `upgrade_role_handoffs` (
  `attempt_id` text NOT NULL,
  `kind` text NOT NULL,
  `operation_id` text NOT NULL,
  `plan_digest` text NOT NULL,
  `candidate` text NOT NULL,
  `stage` text NOT NULL,
  `evidence` text NOT NULL,
  PRIMARY KEY (`attempt_id`,`kind`)
);
--> statement-breakpoint
CREATE TABLE `upgrade_observations` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `attempt_id` text NOT NULL,
  `weight` integer NOT NULL,
  `route_generation` integer NOT NULL,
  `coordinator_generation` integer NOT NULL,
  `observed_at` integer NOT NULL,
  `latency_ms` real NOT NULL,
  `success` integer NOT NULL,
  `request_id` text NOT NULL,
  `evidence_digest` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `upgrade_observation_window` ON `upgrade_observations`(`attempt_id`,`weight`,`observed_at`);
--> statement-breakpoint
CREATE TABLE `upgrade_attachment_observations` (
  `attempt_id` text NOT NULL,
  `sandbox_id` text NOT NULL,
  `runtime_identity` text NOT NULL,
  `duration_ms` real NOT NULL,
  `observed_at` integer NOT NULL,
  PRIMARY KEY (`attempt_id`,`sandbox_id`)
);

--> statement-breakpoint
CREATE UNIQUE INDEX `upgrade_attempts_instance_id_actor_id_request_id_unique` ON `upgrade_attempts` (`instance_id`,`actor_id`,`request_id`);

--> statement-breakpoint
CREATE UNIQUE INDEX `upgrade_events_attempt_id_sequence_unique` ON `upgrade_events` (`attempt_id`,`sequence`);

--> statement-breakpoint
CREATE UNIQUE INDEX `sandbox_create_intents_operation_id_unique` ON `sandbox_create_intents` (`operation_id`);

--> statement-breakpoint
CREATE UNIQUE INDEX `terminal_bookmarks_sandbox_id_kind_private_session_id_unique` ON `terminal_bookmarks` (`sandbox_id`,`kind`,`private_session_id`);

--> statement-breakpoint
CREATE UNIQUE INDEX `coordinator_handoffs_operation_id_unique` ON `coordinator_handoffs` (`operation_id`);

--> statement-breakpoint
CREATE UNIQUE INDEX `upgrade_role_handoffs_operation_id_unique` ON `upgrade_role_handoffs` (`operation_id`);
