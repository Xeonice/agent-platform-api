import { Inject, Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { DATABASE } from '@platform/shared-kernel';
import type { Tx } from '@platform/shared-kernel';
import type { AutomationProjectCleanup } from '@platform/contracts';
import { automations, automationRuns } from '../schema/automation.sqlite';

@Injectable()
export class SqliteAutomationProjectCleanup implements AutomationProjectCleanup {
  constructor(
    @Inject(DATABASE) private readonly db: BetterSQLite3Database<Record<string, never>>,
  ) {}

  deleteByProjectSync(_tx: Tx, projectId: string): void {
    // Runs cascade from their rule; both deletions belong to the project's transaction.
    this.db.delete(automations).where(eq(automations.projectId, projectId)).run();
  }

  async countsByProject(projectId: string): Promise<{ rules: number; runs: number }> {
    const rules =
      this.db
        .select({ n: sql<number>`count(*)` })
        .from(automations)
        .where(eq(automations.projectId, projectId))
        .get()?.n ?? 0;
    const runs =
      this.db
        .select({ n: sql<number>`count(*)` })
        .from(automationRuns)
        .innerJoin(automations, eq(automations.id, automationRuns.automationId))
        .where(eq(automations.projectId, projectId))
        .get()?.n ?? 0;
    return { rules, runs };
  }
}
