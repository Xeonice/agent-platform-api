ALTER TABLE `sandboxes` ADD `failure_operation` text;--> statement-breakpoint
ALTER TABLE `sandboxes` ADD `source_automation_id` text;--> statement-breakpoint
ALTER TABLE `sandboxes` ADD `source_automation_name` text;--> statement-breakpoint
ALTER TABLE `sandboxes` ADD `artifact_retention_days` integer;--> statement-breakpoint
ALTER TABLE `sandboxes` ADD `automation_finished_at` integer;--> statement-breakpoint
ALTER TABLE `retained_volumes` ADD `sandbox_name` text;--> statement-breakpoint
ALTER TABLE `retained_volumes` ADD `source_automation_id` text;--> statement-breakpoint
ALTER TABLE `retained_volumes` ADD `source_automation_name` text;