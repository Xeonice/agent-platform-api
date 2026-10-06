CREATE TABLE `sandbox_project_cleanup_jobs` (
	`sandbox_id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`provider_sandbox_id` text,
	`provider_state` text,
	`workspace_path` text
);
