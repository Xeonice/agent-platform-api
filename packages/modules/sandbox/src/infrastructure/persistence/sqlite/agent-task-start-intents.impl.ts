import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { DATABASE, fromEpochMs, type Tx } from '@platform/shared-kernel';
import type {
  AgentTaskStartIntent,
  AgentTaskStartIntents,
} from '../../../domain/ports/agent-task-start-intents.port';

@Injectable()
export class SqliteAgentTaskStartIntents implements AgentTaskStartIntents {
  constructor(
    @Inject(DATABASE) private readonly db: BetterSQLite3Database<Record<string, never>>,
  ) {}
  createSync(_tx: Tx, intent: AgentTaskStartIntent): void {
    const prior = this.db.get<{ sandbox_id: string; provider: string; payload: string }>(
      sql`SELECT * FROM agent_task_start_intents WHERE task_id=${intent.taskId}`,
    );
    if (prior) {
      if (
        prior.sandbox_id !== intent.sandboxId ||
        prior.provider !== intent.provider ||
        prior.payload !== intent.payload
      )
        throw new Error('TASK_START_INTENT_CONFLICT');
      return;
    }
    this.db.run(
      sql`INSERT INTO agent_task_start_intents(task_id,sandbox_id,provider,payload,created_at) VALUES(${intent.taskId},${intent.sandboxId},${intent.provider},${intent.payload},${intent.createdAt.getTime()})`,
    );
  }
  async find(taskId: string): Promise<AgentTaskStartIntent | null> {
    const row = this.db.get<{
      task_id: string;
      sandbox_id: string;
      provider: string;
      payload: string;
      created_at: number;
    }>(sql`SELECT * FROM agent_task_start_intents WHERE task_id=${taskId}`);
    return row
      ? {
          taskId: row.task_id,
          sandboxId: row.sandbox_id,
          provider: row.provider,
          payload: row.payload,
          createdAt: fromEpochMs(row.created_at),
        }
      : null;
  }
  completeSync(_tx: Tx, taskId: string): void {
    this.db.run(sql`UPDATE agent_task_start_intents SET state='complete' WHERE task_id=${taskId}`);
  }
  async pending(): Promise<AgentTaskStartIntent[]> {
    return this.db
      .all<{
        task_id: string;
        sandbox_id: string;
        provider: string;
        payload: string;
        created_at: number;
      }>(sql`SELECT * FROM agent_task_start_intents WHERE state='pending' ORDER BY created_at`)
      .map((row) => ({
        taskId: row.task_id,
        sandboxId: row.sandbox_id,
        provider: row.provider,
        payload: row.payload,
        createdAt: fromEpochMs(row.created_at),
      }));
  }
}
