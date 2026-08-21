CREATE TABLE `credential_sandbox_bindings` (
	`id` text PRIMARY KEY NOT NULL,
	`credential_id` text NOT NULL,
	`sandbox_id` text NOT NULL,
	`injected_at` integer NOT NULL,
	`revoked_at` integer,
	FOREIGN KEY (`credential_id`) REFERENCES `credentials`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`sandbox_id`) REFERENCES `sandboxes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_csb_sandbox_credential` ON `credential_sandbox_bindings` (`sandbox_id`,`credential_id`);--> statement-breakpoint
CREATE INDEX `idx_csb_credential` ON `credential_sandbox_bindings` (`credential_id`);--> statement-breakpoint
CREATE INDEX `idx_csb_sandbox` ON `credential_sandbox_bindings` (`sandbox_id`);--> statement-breakpoint
CREATE TABLE `runtime_settings` (
	`runtime_id` text PRIMARY KEY NOT NULL,
	`active_auth_method` text NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "runtime_settings_active_auth_method_ck" CHECK("runtime_settings"."active_auth_method" IN ('account','api-key'))
);
