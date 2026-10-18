import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { DATABASE, fromEpochMs, type Tx } from '@platform/shared-kernel';
import type {
  AutomationLaunchIntent,
  AutomationLaunchIntents,
} from '../../../domain/ports/automation-launch-intents.port';

interface Row {
  run_id: string;
  retry_count: number;
  sandbox_id: string;
  task_id: string;
  actor_id: string;
  input: string;
  input_digest: string;
  created_at: number;
}
function digest(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}
function hydrate(row: Row): AutomationLaunchIntent {
  if (row.input_digest !== digest(row.input)) throw new Error('AUTOMATION_LAUNCH_INPUT_CORRUPT');
  return {
    runId: row.run_id,
    retryCount: row.retry_count,
    sandboxId: row.sandbox_id,
    taskId: row.task_id,
    actorId: row.actor_id,
    input: row.input,
    createdAt: fromEpochMs(row.created_at),
  };
}
@Injectable()
export class SqliteAutomationLaunchIntents implements AutomationLaunchIntents {
  constructor(@Inject(DATABASE) private readonly db: BetterSQLite3Database) {}
  async find(runId: string, retryCount: number): Promise<AutomationLaunchIntent | null> {
    const row = this.db.get<Row | undefined>(
      sql`SELECT * FROM automation_launch_intents WHERE run_id=${runId} AND retry_count=${retryCount}`,
    );
    return Promise.resolve(row ? hydrate(row) : null);
  }
  reserveSync(_tx: Tx, intent: AutomationLaunchIntent): AutomationLaunchIntent {
    const row = this.db.get<Row | undefined>(
      sql`SELECT * FROM automation_launch_intents WHERE run_id=${intent.runId} AND retry_count=${intent.retryCount}`,
    );
    if (row) {
      if (
        row.sandbox_id !== intent.sandboxId ||
        row.task_id !== intent.taskId ||
        row.actor_id !== intent.actorId ||
        row.input_digest !== digest(intent.input)
      )
        throw new Error('AUTOMATION_LAUNCH_INTENT_CONFLICT');
      return hydrate(row);
    }
    this.db.run(
      sql`INSERT INTO automation_launch_intents(run_id,retry_count,sandbox_id,task_id,actor_id,input,input_digest,created_at) VALUES(${intent.runId},${intent.retryCount},${intent.sandboxId},${intent.taskId},${intent.actorId},${intent.input},${digest(intent.input)},${intent.createdAt.getTime()})`,
    );
    return intent;
  }
  reserveOccurrenceSync(_tx: Tx, automationId: string, dueAt: Date, runId: string): boolean {
    const rule = this.db.get<{ next_trigger_at: number | null; enabled: number } | undefined>(
      sql`SELECT next_trigger_at,enabled FROM automations WHERE id=${automationId}`,
    );
    if (rule?.enabled !== 1 || rule.next_trigger_at !== Math.floor(dueAt.getTime() / 1000))
      return false;
    const prior = this.db.get(
      sql`SELECT 1 FROM automation_cron_occurrences WHERE automation_id=${automationId} AND due_at=${dueAt.getTime()}`,
    );
    if (prior) return false;
    this.db.run(
      sql`INSERT INTO automation_cron_occurrences(automation_id,due_at,run_id) VALUES(${automationId},${dueAt.getTime()},${runId})`,
    );
    return true;
  }
}
