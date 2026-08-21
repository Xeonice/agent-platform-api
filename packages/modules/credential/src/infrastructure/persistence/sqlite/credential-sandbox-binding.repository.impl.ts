import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { DATABASE } from '@platform/shared-kernel';
import type { CredentialId, SandboxId, Tx } from '@platform/shared-kernel';
import { CredentialSandboxBinding } from '../../../domain/entities/credential-sandbox-binding.entity';
import type { CredentialSandboxBindingRepository } from '../../../domain/repositories/credential-sandbox-binding.repository';
import {
  credentialSandboxBindings,
  type CredentialSandboxBindingRow,
} from '../schema/credential-sandbox-binding.sqlite';

type Db = BetterSQLite3Database<Record<string, never>>;

/** SQLite CredentialSandboxBindingRepository (docs/backend/13 §2.5.2). */
@Injectable()
export class SqliteCredentialSandboxBindingRepository implements CredentialSandboxBindingRepository {
  constructor(@Inject(DATABASE) private readonly db: Db) {}

  async findActive(
    sandboxId: SandboxId,
    credentialId: CredentialId,
  ): Promise<CredentialSandboxBinding | null> {
    const row = this.db
      .select()
      .from(credentialSandboxBindings)
      .where(
        and(
          eq(credentialSandboxBindings.sandboxId, sandboxId),
          eq(credentialSandboxBindings.credentialId, credentialId),
          isNull(credentialSandboxBindings.revokedAt),
        ),
      )
      .get();
    return row ? this.toDomain(row) : null;
  }

  async listBySandbox(sandboxId: SandboxId): Promise<CredentialSandboxBinding[]> {
    return this.db
      .select()
      .from(credentialSandboxBindings)
      .where(eq(credentialSandboxBindings.sandboxId, sandboxId))
      .all()
      .map((r) => this.toDomain(r));
  }

  async listByCredential(
    credentialId: CredentialId,
    includeCleared = false,
  ): Promise<CredentialSandboxBinding[]> {
    const base = eq(credentialSandboxBindings.credentialId, credentialId);
    const where = includeCleared ? base : and(base, isNull(credentialSandboxBindings.revokedAt));
    return this.db
      .select()
      .from(credentialSandboxBindings)
      .where(where)
      .all()
      .map((r) => this.toDomain(r));
  }

  saveSync(_tx: Tx, binding: CredentialSandboxBinding): void {
    this.db
      .insert(credentialSandboxBindings)
      .values({
        id: binding.id,
        credentialId: binding.credentialId as string,
        sandboxId: binding.sandboxId as string,
        injectedAt: binding.injectedAt,
        revokedAt: binding.revokedAt,
      })
      .run();
  }

  markClearedSync(_tx: Tx, id: string, at: Date): void {
    this.db
      .update(credentialSandboxBindings)
      .set({ revokedAt: at })
      .where(eq(credentialSandboxBindings.id, id))
      .run();
  }

  private toDomain(row: CredentialSandboxBindingRow): CredentialSandboxBinding {
    return CredentialSandboxBinding.rehydrate({
      id: row.id,
      credentialId: row.credentialId as CredentialId,
      sandboxId: row.sandboxId as SandboxId,
      injectedAt: row.injectedAt,
      revokedAt: row.revokedAt,
    });
  }
}
