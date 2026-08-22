import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { DATABASE } from '@platform/shared-kernel';
import type { Tx } from '@platform/shared-kernel';
import { RuntimeInstallation } from '../../../domain/entities/runtime-installation.entity';
import type { RuntimeInstallState } from '../../../domain/entities/runtime-installation.entity';
import type { RuntimeInstallationRepository } from '../../../domain/repositories/runtime-installation.repository';
import { runtimeInstallations, type RuntimeInstallationRow } from '../schema/runtime.sqlite';

type Db = BetterSQLite3Database<Record<string, never>>;

/** SQLite RuntimeInstallationRepository (13 §2.3.2). Upsert on the PK. */
@Injectable()
export class SqliteRuntimeInstallationRepository implements RuntimeInstallationRepository {
  constructor(@Inject(DATABASE) private readonly db: Db) {}

  async find(sandboxId: string, runtimeId: string): Promise<RuntimeInstallation | null> {
    const row = this.db
      .select()
      .from(runtimeInstallations)
      .where(
        and(
          eq(runtimeInstallations.sandboxId, sandboxId),
          eq(runtimeInstallations.runtimeId, runtimeId),
        ),
      )
      .get();
    return row ? this.toDomain(row) : null;
  }

  async listBySandbox(sandboxId: string): Promise<RuntimeInstallation[]> {
    return this.db
      .select()
      .from(runtimeInstallations)
      .where(eq(runtimeInstallations.sandboxId, sandboxId))
      .all()
      .map((r) => this.toDomain(r));
  }

  saveSync(_tx: Tx, installation: RuntimeInstallation): void {
    this.db
      .insert(runtimeInstallations)
      .values({
        id: installation.id,
        sandboxId: installation.sandboxId,
        runtimeId: installation.runtimeId,
        status: installation.status,
        versionDetected: installation.versionDetected,
        installedAt: installation.installedAt,
        lastCheckedAt: installation.lastCheckedAt,
        error: installation.error,
      })
      .onConflictDoUpdate({
        target: runtimeInstallations.id,
        set: {
          status: installation.status,
          versionDetected: installation.versionDetected,
          installedAt: installation.installedAt,
          lastCheckedAt: installation.lastCheckedAt,
          error: installation.error,
        },
      })
      .run();
  }

  private toDomain(row: RuntimeInstallationRow): RuntimeInstallation {
    return RuntimeInstallation.rehydrate({
      id: row.id,
      sandboxId: row.sandboxId,
      runtimeId: row.runtimeId,
      status: row.status as RuntimeInstallState,
      versionDetected: row.versionDetected,
      installedAt: row.installedAt,
      lastCheckedAt: row.lastCheckedAt,
      error: row.error,
    });
  }
}
