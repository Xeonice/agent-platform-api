import { readSqlite } from './read-sqlite';
import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { DATABASE, fromEpochMs, type Tx } from '@platform/shared-kernel';
import type {
  SandboxCreateIntent,
  SandboxCreateIntents,
} from '../../../domain/ports/sandbox-create-intents.port';

@Injectable()
export class SqliteSandboxCreateIntents implements SandboxCreateIntents {
  constructor(@Inject(DATABASE) private readonly db: BetterSQLite3Database) {}
  reserveSync(
    _tx: Tx,
    sandboxId: string,
    operationId: string,
    input: Readonly<object>,
    workspacePath: string,
    at: Date,
  ): SandboxCreateIntent {
    // Hash credentials in memory; never persist provider-create environment secrets.
    const requestDigest = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    const prior = this.db.get<{ operation_id: string; request_digest: string } | undefined>(
      sql`SELECT * FROM sandbox_create_intents WHERE sandbox_id=${sandboxId}`,
    );
    if (prior && (prior.operation_id !== operationId || prior.request_digest !== requestDigest))
      throw new Error('ORIGINAL_SANDBOX_CREATE_INTENT_UNCONFIRMED');
    if (!workspacePath) throw new Error('SANDBOX_WORKSPACE_INTENT_REQUIRED');
    if (!prior)
      this.db.run(
        sql`INSERT INTO sandbox_create_intents VALUES(${sandboxId},${operationId},${requestDigest},${workspacePath},'pending',${at.getTime()})`,
      );
    return {
      sandboxId,
      operationId,
      requestDigest,
      workspacePath,
      state: 'pending',
      createdAt: at,
    };
  }
  completeSync(_tx: Tx, sandboxId: string): void {
    this.db.run(sql`UPDATE sandbox_create_intents SET state='bound' WHERE sandbox_id=${sandboxId}`);
  }
  finishSync(_tx: Tx, sandboxId: string): void {
    this.db.run(
      sql`UPDATE sandbox_create_intents SET state='finished' WHERE sandbox_id=${sandboxId}`,
    );
  }
  pending(): Promise<SandboxCreateIntent[]> {
    return readSqlite(() => {
      return this.db
        .all<{
          sandbox_id: string;
          operation_id: string;
          request_digest: string;
          workspace_path: string;
          state: 'pending' | 'bound';
          created_at: number;
        }>(sql`SELECT * FROM sandbox_create_intents WHERE state IN ('pending','bound')`)
        .map((row) => ({
          sandboxId: row.sandbox_id,
          operationId: row.operation_id,
          requestDigest: row.request_digest,
          workspacePath: row.workspace_path,
          state: row.state,
          createdAt: fromEpochMs(row.created_at),
        }));
    });
  }
}
