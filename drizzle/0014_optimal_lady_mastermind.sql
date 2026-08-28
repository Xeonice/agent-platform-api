CREATE TABLE `audit_events` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL,
	`category` text NOT NULL,
	`type` text NOT NULL,
	`severity` text DEFAULT 'info' NOT NULL,
	`subject_type` text,
	`subject_id` text,
	`actor` text NOT NULL,
	`summary` text NOT NULL,
	`detail` text,
	`duration_ms` integer,
	`outcome` text,
	`error_code` text,
	CONSTRAINT "audit_events_category_ck" CHECK("audit_events"."category" IN ('sandbox','project','credential','image','system')),
	CONSTRAINT "audit_events_severity_ck" CHECK("audit_events"."severity" IN ('info','warn','error')),
	CONSTRAINT "audit_events_outcome_ck" CHECK("audit_events"."outcome" IS NULL OR "audit_events"."outcome" IN ('ok','failed','skipped'))
);
--> statement-breakpoint
CREATE INDEX `idx_audit_events_subject` ON `audit_events` (`subject_type`,`subject_id`,`seq`);--> statement-breakpoint
CREATE INDEX `idx_audit_events_category_seq` ON `audit_events` (`category`,`seq`);--> statement-breakpoint
CREATE INDEX `idx_audit_events_at` ON `audit_events` (`at`);