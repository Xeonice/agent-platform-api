import { afterEach } from 'vitest';
import { asAutomationId, asProjectId } from '@platform/shared-kernel';
import type { AuditRecorder, AuditRecordInput } from '@platform/contracts';
import type {
  DomainEvent as KernelDomainEvent,
  EventBus as KernelEventBus,
  Tx,
} from '@platform/shared-kernel';
import { Automation } from '../../packages/modules/automation/src/domain/entities/automation.entity';
import type { AutomationRun } from '../../packages/modules/automation/src/domain/entities/automation-run.entity';
import { SqliteAutomationRepository } from '../../packages/modules/automation/src/infrastructure/persistence/sqlite/automation.repository.impl';
import { SqliteAutomationRunRepository } from '../../packages/modules/automation/src/infrastructure/persistence/sqlite/automation-run.repository.impl';
import { currentDatabase } from './sqlite';

const databases: ReturnType<typeof currentDatabase>[] = [];
afterEach(() => databases.splice(0).forEach(({ sqlite }) => sqlite.close()));
export function automationDatabase() {
  const database = currentDatabase();
  databases.push(database);
  database.sqlite
    .prepare(
      `INSERT INTO projects (id,name,source_type,clone_status,baseline_path,created_at,updated_at)
    VALUES ('prj-aut','automation project','empty','ready','/tmp/aut',0,0)`,
    )
    .run();
  return database;
}
export class RuleRepository extends SqliteAutomationRepository {
  readonly saveLog: string[] = [];
  override saveSync(tx: Tx, rule: Automation) {
    this.saveLog.push(rule.id);
    super.saveSync(tx, rule);
  }
}
export class RunRepository extends SqliteAutomationRunRepository {
  readonly saveLog: string[] = [];
  override saveSync(tx: Tx, run: AutomationRun) {
    this.saveLog.push(run.id);
    super.saveSync(tx, run);
  }
}
export class NoopAudit implements AuditRecorder {
  readonly records: AuditRecordInput[] = [];
  record(record: AuditRecordInput) {
    this.records.push(record);
  }
}
export class RecordingEventBus implements KernelEventBus {
  readonly events: KernelDomainEvent[] = [];
  publishInTx(_tx: Tx, events: KernelDomainEvent[]) {
    this.events.push(...events);
  }
  subscribe() {}
}
export function hourlyRule(id: string, now: Date) {
  return Automation.create({
    id: asAutomationId(id),
    projectId: asProjectId('prj-aut'),
    name: 'hourly',
    runtimeId: 'codex',
    prompt: 'run tests',
    scheduleKind: 'hourly',
    scheduleConfig: { minute: 0 },
    timezone: 'UTC',
    timeoutMinutes: 120,
    artifactRetentionDays: 7,
    now,
  });
}
