import { readSqlite } from './read-sqlite';
import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { DATABASE, type Tx } from '@platform/shared-kernel';
import type { SandboxAdmissionIntents } from '../../../domain/ports/sandbox-admission-intents.port';
function digest(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}
@Injectable()
export class SqliteSandboxAdmissionIntents implements SandboxAdmissionIntents {
  constructor(@Inject(DATABASE) private readonly db: BetterSQLite3Database) {}
  find(sandboxId: string): Promise<string | null> {
    return readSqlite(() => {
      const row = this.db.get<{ input: string; input_digest: string } | undefined>(
        sql`SELECT * FROM sandbox_admission_intents WHERE sandbox_id=${sandboxId}`,
      );
      if (!row) return null;
      if (digest(row.input) !== row.input_digest)
        throw new Error('SANDBOX_ADMISSION_INPUT_CORRUPT');
      return row.input;
    });
  }
  reserveSync(_tx: Tx, sandboxId: string, input: string): void {
    this.db.run(
      sql`INSERT INTO sandbox_admission_intents(sandbox_id,input,input_digest) VALUES(${sandboxId},${input},${digest(input)})`,
    );
  }
}
