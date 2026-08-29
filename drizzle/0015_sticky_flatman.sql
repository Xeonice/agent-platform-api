CREATE TABLE `system_settings` (
	`id` integer PRIMARY KEY DEFAULT 1 NOT NULL,
	`initialized` integer DEFAULT false NOT NULL,
	`initialized_at` integer,
	`proxy_config` text,
	`last_connectivity_check` text,
	`last_connectivity_check_at` integer,
	`access_passcode_hash` text,
	`access_passcode_updated_at` integer,
	`public_base_url` text,
	`platform_version` text,
	`last_backup_at` integer,
	CONSTRAINT "system_settings_single_row" CHECK("system_settings"."id" = 1)
);
