import { Inject, Injectable } from '@nestjs/common';
import { eq, ne, and, inArray, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { DATABASE } from '@platform/shared-kernel';
import type { SandboxId, ProjectId, Tx } from '@platform/shared-kernel';
import { Sandbox } from '../../../domain/entities/sandbox.entity';
import type { SandboxStatus } from '../../../domain/value-objects/sandbox-status.vo';
import type { TriggeredBy } from '../../../domain/entities/state-transition.entity';
import type { SandboxRepository } from '../../../domain/repositories/sandbox.repository';
import {
  sandboxes,
  sandboxStateTransitions,
  type SandboxRow,
  type SandboxTransitionRow,
} from '../schema/sandbox.sqlite';

type Db = BetterSQLite3Database<Record<string, never>>;

/**
 * SQLite (better-sqlite3 + Drizzle) implementation of the SandboxRepository port.
 * `saveSync` is synchronous (P0-2): better-sqlite3 statements run synchronously,
 * so the whole write completes inside the UnitOfWork's sync transaction.
 * snake_case ↔ camelCase and Date mapping happen here (28 §4 boundary rule).
 */
@Injectable()
export class SqliteSandboxRepository implements SandboxRepository {
  constructor(@Inject(DATABASE) private readonly db: Db) {}

  async findById(id: SandboxId): Promise<Sandbox | null> {
    const row = this.db.select().from(sandboxes).where(eq(sandboxes.id, id)).get();
    if (!row) return null;
    const transitions = this.db
      .select()
      .from(sandboxStateTransitions)
      .where(eq(sandboxStateTransitions.sandboxId, id))
      .all();
    return this.toDomain(row, transitions);
  }

  async findByProject(projectId: ProjectId): Promise<Sandbox[]> {
    const rows = this.db.select().from(sandboxes).where(eq(sandboxes.projectId, projectId)).all();
    return rows.map((row) => {
      const transitions = this.db
        .select()
        .from(sandboxStateTransitions)
        .where(eq(sandboxStateTransitions.sandboxId, row.id))
        .all();
      return this.toDomain(row, transitions);
    });
  }

  async countActiveByProject(projectIds: string[]): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const id of projectIds) out[id] = 0; // ensure every requested id is present
    if (projectIds.length === 0) return out;
    const rows = this.db
      .select({ projectId: sandboxes.projectId, n: sql<number>`count(*)` })
      .from(sandboxes)
      .where(and(inArray(sandboxes.projectId, projectIds), ne(sandboxes.status, 'destroyed')))
      .groupBy(sandboxes.projectId)
      .all();
    for (const row of rows) out[row.projectId] = row.n;
    return out;
  }

  saveSync(_tx: Tx, sandbox: Sandbox): void {
    // The injected connection is already inside the active UnitOfWork transaction
    // (better-sqlite3 is single-connection + synchronous), so we write on it
    // directly; `_tx` is only the marker gating this call (28 §7.3).
    const db = this.db;
    const history = sandbox.transitions;
    if (history.length === 0) {
      // an aggregate always carries at least its creation transition (28 §2.2)
      throw new Error('cannot persist a sandbox with no transition history');
    }
    const createdAt = history[0].at;
    const updatedAt = history[history.length - 1].at;

    db.insert(sandboxes)
      .values({
        id: sandbox.id as string,
        projectId: sandbox.projectId as string,
        runtime: sandbox.runtime,
        provider: sandbox.provider,
        status: sandbox.status,
        headless: sandbox.headless,
        timeoutMinutes: sandbox.timeoutMinutes,
        idleTimeoutSec: sandbox.idleTimeoutSec,
        providerHandle: sandbox.providerSandboxId,
        workspacePath: sandbox.workspacePath,
        agentEndpointPort: sandbox.agentEndpointPort,
        version: sandbox.version,
        createdAt,
        updatedAt,
      })
      .onConflictDoUpdate({
        target: sandboxes.id,
        set: {
          status: sandbox.status,
          timeoutMinutes: sandbox.timeoutMinutes,
          idleTimeoutSec: sandbox.idleTimeoutSec,
          providerHandle: sandbox.providerSandboxId,
          workspacePath: sandbox.workspacePath,
          agentEndpointPort: sandbox.agentEndpointPort,
          version: sandbox.version,
          updatedAt,
        },
      })
      .run();

    for (const t of sandbox.pendingTransitions) {
      db.insert(sandboxStateTransitions)
        .values({
          id: `${sandbox.id}-${t.to}-${t.at.getTime()}`,
          sandboxId: sandbox.id as string,
          fromStatus: t.from,
          toStatus: t.to,
          at: t.at,
          triggeredBy: t.triggeredBy,
        })
        .run();
    }

    // NOTE: optimistic-lock version bump is a full-slice TODO (28 §2.2). The
    // scaffold persists the aggregate's current version as-is.
    sandbox.markPersisted(sandbox.version);
  }

  private toDomain(row: SandboxRow, transitions: SandboxTransitionRow[]): Sandbox {
    return Sandbox.rehydrate({
      id: row.id as SandboxId,
      projectId: row.projectId as ProjectId,
      runtime: row.runtime,
      provider: row.provider,
      status: row.status as SandboxStatus,
      headless: row.headless,
      timeoutMinutes: row.timeoutMinutes,
      idleTimeoutSec: row.idleTimeoutSec,
      workspacePath: row.workspacePath,
      providerSandboxId: row.providerHandle,
      agentEndpointPort: row.agentEndpointPort,
      version: row.version,
      transitions: transitions.map((t) => ({
        from: t.fromStatus as SandboxStatus | null,
        to: t.toStatus as SandboxStatus,
        at: t.at,
        triggeredBy: t.triggeredBy as TriggeredBy,
      })),
    });
  }
}
