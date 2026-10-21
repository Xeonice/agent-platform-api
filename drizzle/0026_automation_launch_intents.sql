CREATE TABLE automation_cron_occurrences (
  automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  due_at INTEGER NOT NULL,
  run_id TEXT NOT NULL,
  PRIMARY KEY(automation_id,due_at)
);
--> statement-breakpoint
CREATE UNIQUE INDEX automation_cron_occurrences_run_idx ON automation_cron_occurrences(run_id);
--> statement-breakpoint
CREATE TABLE automation_launch_intents (
  run_id TEXT NOT NULL REFERENCES automation_runs(id) ON DELETE CASCADE,
  retry_count INTEGER NOT NULL CONSTRAINT automation_launch_intents_retry_ck CHECK(retry_count BETWEEN 0 AND 5),
  sandbox_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  input TEXT NOT NULL,
  input_digest TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(run_id,retry_count)
);
--> statement-breakpoint
CREATE UNIQUE INDEX automation_launch_intents_sandbox_idx ON automation_launch_intents(sandbox_id);
--> statement-breakpoint
CREATE UNIQUE INDEX automation_launch_intents_task_idx ON automation_launch_intents(task_id);
--> statement-breakpoint
CREATE TRIGGER automation_launch_intents_immutable BEFORE UPDATE ON automation_launch_intents
BEGIN SELECT RAISE(ABORT,'automation launch identities are immutable'); END;
--> statement-breakpoint
CREATE TABLE sandbox_admission_intents (
  sandbox_id TEXT NOT NULL PRIMARY KEY,
  input TEXT NOT NULL,
  input_digest TEXT NOT NULL
);
--> statement-breakpoint
CREATE TRIGGER sandbox_admission_intents_immutable BEFORE UPDATE ON sandbox_admission_intents
BEGIN SELECT RAISE(ABORT,'sandbox admission identities are immutable'); END;
