CREATE TABLE `credentials` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`runtime_id` text,
	`label` text,
	`masked_identifier` text NOT NULL,
	`metadata` text,
	`owner_ref` text,
	`encrypted_blob` text,
	`iv` text,
	`auth_tag` text,
	`encryption_key_id` text NOT NULL,
	`obtained_via` text NOT NULL,
	`mode` text,
	`allowed_hosts` text,
	`issued_at` integer NOT NULL,
	`expires_at` integer,
	`refresh_failures` integer DEFAULT 0 NOT NULL,
	`last_refreshed_at` integer,
	`revoked_at` integer,
	`last_used_at` integer,
	CONSTRAINT "credentials_kind_ck" CHECK("credentials"."kind" IN ('runtime','git')),
	CONSTRAINT "credentials_kind_shape_ck" CHECK(("credentials"."kind" = 'runtime' AND "credentials"."runtime_id" IS NOT NULL AND "credentials"."obtained_via" IN ('setup-token','oauth-device','api-key','access-token-paste')) OR ("credentials"."kind" = 'git' AND "credentials"."runtime_id" IS NULL AND "credentials"."obtained_via" IN ('git-ssh-key','git-https-token'))),
	CONSTRAINT "credentials_mode_ck" CHECK(("credentials"."kind" = 'runtime' AND "credentials"."mode" IN ('account','api-key')) OR ("credentials"."kind" = 'git' AND "credentials"."mode" IS NULL)),
	CONSTRAINT "credentials_allowed_hosts_ck" CHECK(("credentials"."obtained_via" = 'git-https-token' AND "credentials"."allowed_hosts" IS NOT NULL) OR ("credentials"."obtained_via" <> 'git-https-token')),
	CONSTRAINT "credentials_erased_ck" CHECK("credentials"."revoked_at" IS NULL OR ("credentials"."encrypted_blob" IS NULL AND "credentials"."iv" IS NULL AND "credentials"."auth_tag" IS NULL))
);
--> statement-breakpoint
CREATE INDEX `credentials_kind_obtained_idx` ON `credentials` (`kind`,`obtained_via`,`revoked_at`);--> statement-breakpoint
CREATE INDEX `credentials_runtime_idx` ON `credentials` (`runtime_id`,`revoked_at`);--> statement-breakpoint
CREATE INDEX `credentials_owner_idx` ON `credentials` (`owner_ref`);--> statement-breakpoint
CREATE INDEX `credentials_expires_idx` ON `credentials` (`expires_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_cred_runtime_active` ON `credentials` (`runtime_id`,`mode`) WHERE "credentials"."kind" = 'runtime' AND "credentials"."revoked_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_cred_git_active` ON `credentials` (`obtained_via`) WHERE "credentials"."kind" = 'git' AND "credentials"."revoked_at" IS NULL;