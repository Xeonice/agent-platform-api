/** Independent control schema. No business migrations, role leases or SDK tables. */
export const UPGRADE_CONTROL_SCHEMA_VERSION = 1;
export const UPGRADE_CONTROL_SCHEMA_SQL = String.raw`
CREATE TABLE "upgrade_instances" (
  "instance_id" text PRIMARY KEY NOT NULL,
  "activation_generation" integer NOT NULL DEFAULT 0,
  "confirmed_release" text,
  "service_state" text NOT NULL DEFAULT 'unknown',
  "ready" integer NOT NULL DEFAULT 0,
  "updated_at" integer NOT NULL
);
CREATE TABLE "upgrade_attempts" (
  "attempt_id" text PRIMARY KEY NOT NULL,
  "instance_id" text NOT NULL REFERENCES "upgrade_instances"("instance_id"),
  "actor_id" text NOT NULL,
  "request_id" text NOT NULL,
  "request_digest" text NOT NULL,
  "target_release_id" text NOT NULL,
  "target_digest" text NOT NULL,
  "manifest" text NOT NULL,
  "plan" text NOT NULL,
  "source_activation" text NOT NULL,
  "source_actual" text,
  "generation" integer NOT NULL,
  "sequence" integer NOT NULL DEFAULT 0,
  "state" text NOT NULL DEFAULT 'accepted',
  "stage" text NOT NULL DEFAULT 'accepted',
  "reason" text,
  "controller_id" text,
  "fence" integer NOT NULL DEFAULT 0,
  "lease_expires_at" integer NOT NULL DEFAULT 0,
  "accepted_at" integer NOT NULL,
  "observed_at" integer NOT NULL
);
CREATE UNIQUE INDEX "upgrade_one_active_attempt" ON "upgrade_attempts" ("instance_id")
WHERE "state" IN ('accepted','downloading','package-verified','migrating','prepared','candidate-ready','routing-switched','observing','api-activated');
CREATE TABLE "upgrade_events" (
  "event_id" text PRIMARY KEY NOT NULL,
  "attempt_id" text NOT NULL REFERENCES "upgrade_attempts"("attempt_id"),
  "event_digest" text NOT NULL,
  "generation" integer NOT NULL,
  "sequence" integer NOT NULL,
  "fence" integer NOT NULL,
  "kind" text NOT NULL,
  "payload" text NOT NULL,
  "recorded_at" integer NOT NULL
);
CREATE TRIGGER "upgrade_event_no_update" BEFORE UPDATE ON "upgrade_events"
BEGIN SELECT RAISE(ABORT, 'upgrade events are immutable'); END;
CREATE TRIGGER "upgrade_event_no_delete" BEFORE DELETE ON "upgrade_events"
BEGIN SELECT RAISE(ABORT, 'upgrade events are immutable'); END;
CREATE TABLE "upgrade_steps" (
  "attempt_id" text NOT NULL REFERENCES "upgrade_attempts"("attempt_id"),
  "step_id" text NOT NULL,
  "completed_work" real NOT NULL DEFAULT 0,
  "applied" integer NOT NULL DEFAULT 0,
  "receipt_digest" text,
  "evidence" text,
  "applied_at" integer,
  PRIMARY KEY ("attempt_id","step_id")
);
CREATE TABLE "upgrade_recoveries" (
  "recovery_attempt_id" text PRIMARY KEY NOT NULL,
  "triggering_attempt_id" text NOT NULL REFERENCES "upgrade_attempts"("attempt_id"),
  "instance_id" text NOT NULL REFERENCES "upgrade_instances"("instance_id"),
  "generation" integer NOT NULL,
  "sequence" integer NOT NULL,
  "state" text NOT NULL,
  "plan" text NOT NULL,
  "plan_digest" text NOT NULL,
  "reason" text NOT NULL,
  "observed_at" integer NOT NULL
);
CREATE TABLE "platform_operations" (
  "operation_id" text PRIMARY KEY NOT NULL,
  "instance_id" text NOT NULL,
  "actor_id" text NOT NULL,
  "role" text NOT NULL,
  "fence" integer NOT NULL,
  "request_digest" text NOT NULL,
  "state" text NOT NULL,
  "result" text,
  "created_at" integer NOT NULL,
  "updated_at" integer NOT NULL
);
CREATE TABLE "upgrade_continuity_baselines" (
  "attempt_id" text PRIMARY KEY NOT NULL REFERENCES "upgrade_attempts"("attempt_id"),
  "snapshot" text NOT NULL,
  "digest" text NOT NULL,
  "captured_at" integer NOT NULL
);
CREATE UNIQUE INDEX "upgrade_attempts_instance_id_actor_id_request_id_unique" ON "upgrade_attempts" ("instance_id","actor_id","request_id");
CREATE UNIQUE INDEX "upgrade_events_attempt_id_sequence_unique" ON "upgrade_events" ("attempt_id","sequence");
CREATE INDEX "upgrade_attempts_latest" ON "upgrade_attempts" ("instance_id","generation");
CREATE INDEX "upgrade_attempts_fence" ON "upgrade_attempts" ("instance_id","fence");
CREATE INDEX "platform_operations_authority" ON "platform_operations" ("instance_id","role","fence");
ALTER TABLE "upgrade_attempts" ADD COLUMN "plan_digest" text;
ALTER TABLE "upgrade_steps" ADD COLUMN "evidence_digest" text;
UPDATE "upgrade_attempts" SET "plan_digest"=json_extract("plan",'$.planDigest') WHERE json_valid("plan");
CREATE TRIGGER "upgrade_plan_digest_insert" AFTER INSERT ON "upgrade_attempts"
BEGIN
  UPDATE "upgrade_attempts" SET "plan_digest"=CASE WHEN json_valid(NEW.plan) THEN json_extract(NEW.plan,'$.planDigest') END WHERE "attempt_id"=NEW.attempt_id;
END;
CREATE TRIGGER "upgrade_plan_digest_update" AFTER UPDATE OF "plan" ON "upgrade_attempts"
BEGIN
  UPDATE "upgrade_attempts" SET "plan_digest"=CASE WHEN json_valid(NEW.plan) THEN json_extract(NEW.plan,'$.planDigest') END WHERE "attempt_id"=NEW.attempt_id;
END;
CREATE TRIGGER "upgrade_legacy_evidence_digest_invalidate" AFTER UPDATE OF "evidence" ON "upgrade_steps"
WHEN NEW.evidence IS NOT OLD.evidence AND NEW.evidence_digest IS OLD.evidence_digest
BEGIN
  UPDATE "upgrade_steps" SET "evidence_digest"=NULL WHERE "attempt_id"=NEW.attempt_id AND "step_id"=NEW.step_id;
END;
`;
