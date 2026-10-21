import { readSqlite } from './read-sqlite';
import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { DATABASE, type Tx } from '@platform/shared-kernel';
import type {
  SandboxStopIntent,
  SandboxStopIntents,
} from '../../../domain/ports/sandbox-stop-intents.port';

const stopIntentSchema = z.object({
  sandboxId: z.string(),
  operationId: z.string(),
  actor: z.object({ kind: z.enum(['user', 'automation', 'system']), id: z.string() }),
});

@Injectable()
export class SqliteSandboxStopIntents implements SandboxStopIntents {
  constructor(@Inject(DATABASE) private readonly db: BetterSQLite3Database) {}
  reserveSync(_tx: Tx, intent: SandboxStopIntent, at: Date): void {
    const result = JSON.stringify(intent);
    const digest = createHash('sha256').update(result).digest('hex');
    this.db.run(sql`INSERT INTO platform_operations
      (operation_id,instance_id,actor_id,role,fence,request_digest,state,result,created_at,updated_at)
      VALUES(${intent.operationId},${process.env.PLATFORM_INSTANCE_ID ?? 'standalone'},
             ${intent.actor.id},'sandbox-stop',0,${digest},'pending',${result},${at.getTime()},${at.getTime()})`);
  }
  finishSync(_tx: Tx, operationId: string, at: Date): void {
    this.db.run(sql`UPDATE platform_operations SET state='finished',updated_at=${at.getTime()}
      WHERE operation_id=${operationId} AND role='sandbox-stop' AND state='pending'`);
  }
  pending(): Promise<SandboxStopIntent[]> {
    return readSqlite(() => {
      return this.db
        .all<{ result: string }>(
          sql`SELECT result FROM platform_operations WHERE role='sandbox-stop' AND state='pending'`,
        )
        .map((row) => stopIntentSchema.parse(JSON.parse(row.result) as unknown));
    });
  }
}
