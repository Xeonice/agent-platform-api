import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { DATABASE } from '@platform/shared-kernel';
import type { Tx } from '@platform/shared-kernel';
import { RuntimeSettings } from '../../../domain/entities/runtime-settings.entity';
import type { RuntimeAuthMode } from '../../../domain/entities/runtime-settings.entity';
import type { RuntimeSettingsRepository } from '../../../domain/repositories/runtime-settings.repository';
import { runtimeSettings, type RuntimeSettingsRow } from '../schema/runtime.sqlite';

type Db = BetterSQLite3Database<Record<string, never>>;

/** SQLite RuntimeSettingsRepository (docs/backend/13 §2.3.1). Upsert on PK. */
@Injectable()
export class SqliteRuntimeSettingsRepository implements RuntimeSettingsRepository {
  constructor(@Inject(DATABASE) private readonly db: Db) {}

  async findByRuntime(runtimeId: string): Promise<RuntimeSettings | null> {
    const row = this.db
      .select()
      .from(runtimeSettings)
      .where(eq(runtimeSettings.runtimeId, runtimeId))
      .get();
    return row ? this.toDomain(row) : null;
  }

  saveSync(_tx: Tx, settings: RuntimeSettings): void {
    this.db
      .insert(runtimeSettings)
      .values({
        runtimeId: settings.runtimeId,
        activeAuthMethod: settings.activeAuthMethod,
        updatedAt: settings.updatedAt,
      })
      .onConflictDoUpdate({
        target: runtimeSettings.runtimeId,
        set: { activeAuthMethod: settings.activeAuthMethod, updatedAt: settings.updatedAt },
      })
      .run();
  }

  private toDomain(row: RuntimeSettingsRow): RuntimeSettings {
    return RuntimeSettings.rehydrate({
      runtimeId: row.runtimeId,
      activeAuthMethod: row.activeAuthMethod as RuntimeAuthMode,
      updatedAt: row.updatedAt,
    });
  }
}
