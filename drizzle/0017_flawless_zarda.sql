CREATE TABLE `retained_volumes` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`sandbox_id` text,
	`workspace_path` text NOT NULL,
	`source` text NOT NULL,
	`disk_bytes` integer,
	`download_bytes` integer,
	`retain_until` integer NOT NULL,
	`retained_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "retained_volumes_source_ck" CHECK("retained_volumes"."source" IN ('manual-destroy','automation-artifact')),
	CONSTRAINT "retained_volumes_retain_until_ck" CHECK("retained_volumes"."retain_until" > "retained_volumes"."retained_at")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `retained_volumes_workspace_path_unique` ON `retained_volumes` (`workspace_path`);--> statement-breakpoint
CREATE INDEX `retained_volumes_project_deleted_idx` ON `retained_volumes` (`project_id`,`deleted_at`);--> statement-breakpoint
CREATE INDEX `retained_volumes_retain_until_idx` ON `retained_volumes` (`retain_until`);