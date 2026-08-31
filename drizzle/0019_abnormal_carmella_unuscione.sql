CREATE TABLE `resource_allocations` (
	`id` text PRIMARY KEY NOT NULL,
	`sandbox_id` text NOT NULL,
	`node_id` text DEFAULT 'local' NOT NULL,
	`cores_reserved` real NOT NULL,
	`ram_mb_reserved` integer NOT NULL,
	`disk_mb_reserved` integer NOT NULL,
	`allocated_at` integer NOT NULL,
	`released_at` integer,
	`reconciliation_status` text DEFAULT 'pending' NOT NULL,
	FOREIGN KEY (`sandbox_id`) REFERENCES `sandboxes`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "resource_allocations_reconciliation_ck" CHECK("resource_allocations"."reconciliation_status" IN ('confirmed','pending','orphaned')),
	CONSTRAINT "resource_allocations_positive_ck" CHECK("resource_allocations"."cores_reserved" > 0 AND "resource_allocations"."ram_mb_reserved" > 0 AND "resource_allocations"."disk_mb_reserved" > 0)
);
--> statement-breakpoint
CREATE INDEX `idx_alloc_sandbox` ON `resource_allocations` (`sandbox_id`);--> statement-breakpoint
CREATE INDEX `idx_alloc_node_released` ON `resource_allocations` (`node_id`,`released_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_alloc_active` ON `resource_allocations` (`sandbox_id`) WHERE released_at is null;