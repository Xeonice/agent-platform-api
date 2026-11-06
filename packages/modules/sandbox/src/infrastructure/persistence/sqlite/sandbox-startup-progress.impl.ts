import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { StartupObservationSchema } from '@platform/contracts';
import { DATABASE, isRecord, type Tx } from '@platform/shared-kernel';
import type {
  SandboxStartupProgress,
  SandboxStartupProgressStore,
} from '../../../domain/ports/sandbox-startup-progress.port';

/** Reuses the existing operation ledger; no change to historical create intents. */
@Injectable()
export class SqliteSandboxStartupProgress implements SandboxStartupProgressStore {
  constructor(@Inject(DATABASE) private readonly db: BetterSQLite3Database) {}

  readSync(sandboxId: string): SandboxStartupProgress | undefined {
    const row = this.db.get<{ result: string } | undefined>(
      sql`SELECT result FROM platform_operations
          WHERE operation_id=${this.key(sandboxId)} AND role='sandbox-provisioning'`,
    );
    if (!row) return undefined;
    // Old/malformed observation degrades to unavailable, never a guessed stage.
    try {
      const value: unknown = JSON.parse(row.result);
      if (!isRecord(value)) return undefined;
      const parsed = StartupObservationSchema.safeParse({
        ...value,
        observedAt: null,
      });
      if (!parsed.success) return undefined;
      const { observedAt: _observedAt, ...progress } = parsed.data;
      return progress;
    } catch {
      return undefined;
    }
  }

  saveSync(_tx: Tx, sandboxId: string, progress: SandboxStartupProgress, at: Date): void {
    const key = this.key(sandboxId);
    const cycleVersion = Number(/:(\d+)$/.exec(progress.operationId)?.[1]);
    if (!Number.isSafeInteger(cycleVersion) || cycleVersion < 0)
      throw new Error('INVALID_STARTUP_CYCLE_VERSION');
    const digest = createHash('sha256').update(progress.operationId).digest('hex');
    const result = JSON.stringify(progress);
    this.db.run(sql`INSERT INTO platform_operations
      (operation_id,instance_id,actor_id,role,fence,request_digest,state,result,created_at,updated_at)
      VALUES(${key},${process.env.PLATFORM_INSTANCE_ID ?? 'standalone'},'system',
             'sandbox-provisioning',${cycleVersion},${digest},${progress.state},${result},${at.getTime()},${at.getTime()})
      ON CONFLICT(operation_id) DO UPDATE SET
        fence=excluded.fence,request_digest=excluded.request_digest,state=excluded.state,result=excluded.result,
        updated_at=excluded.updated_at
      WHERE platform_operations.role='sandbox-provisioning' AND
        (excluded.fence > platform_operations.fence OR
         (excluded.fence = platform_operations.fence AND
          json_extract(platform_operations.result,'$.operationId')=${progress.operationId} AND
          json_extract(platform_operations.result,'$.sequence') < ${progress.sequence}))`);
  }

  private key(sandboxId: string): string {
    return `sandbox-startup:${sandboxId}`;
  }
}
