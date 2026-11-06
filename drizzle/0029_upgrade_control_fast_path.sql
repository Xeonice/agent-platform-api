CREATE INDEX `upgrade_attempts_latest` ON `upgrade_attempts` (`instance_id`,`generation`);
--> statement-breakpoint
CREATE INDEX `upgrade_attempts_fence` ON `upgrade_attempts` (`instance_id`,`fence`);
--> statement-breakpoint
CREATE INDEX `platform_operations_authority` ON `platform_operations` (`instance_id`,`role`,`fence`);
--> statement-breakpoint
ALTER TABLE `upgrade_attempts` ADD COLUMN `plan_digest` text;
--> statement-breakpoint
ALTER TABLE `upgrade_steps` ADD COLUMN `evidence_digest` text;
--> statement-breakpoint
UPDATE `upgrade_attempts` SET `plan_digest`=json_extract(`plan`,'$.planDigest') WHERE json_valid(`plan`);
--> statement-breakpoint
CREATE TRIGGER `upgrade_plan_digest_insert` AFTER INSERT ON `upgrade_attempts`
BEGIN
  UPDATE `upgrade_attempts` SET `plan_digest`=CASE WHEN json_valid(NEW.plan) THEN json_extract(NEW.plan,'$.planDigest') END WHERE `attempt_id`=NEW.attempt_id;
END;
--> statement-breakpoint
CREATE TRIGGER `upgrade_plan_digest_update` AFTER UPDATE OF `plan` ON `upgrade_attempts`
BEGIN
  UPDATE `upgrade_attempts` SET `plan_digest`=CASE WHEN json_valid(NEW.plan) THEN json_extract(NEW.plan,'$.planDigest') END WHERE `attempt_id`=NEW.attempt_id;
END;
--> statement-breakpoint
CREATE TRIGGER `upgrade_legacy_evidence_digest_invalidate` AFTER UPDATE OF `evidence` ON `upgrade_steps`
WHEN NEW.evidence IS NOT OLD.evidence AND NEW.evidence_digest IS OLD.evidence_digest
BEGIN
  UPDATE `upgrade_steps` SET `evidence_digest`=NULL WHERE `attempt_id`=NEW.attempt_id AND `step_id`=NEW.step_id;
END;
