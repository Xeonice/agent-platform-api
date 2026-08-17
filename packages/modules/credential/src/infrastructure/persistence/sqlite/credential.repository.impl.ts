import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { DATABASE } from '@platform/shared-kernel';
import type { CredentialId, Tx } from '@platform/shared-kernel';
import { Credential } from '../../../domain/entities/credential.entity';
import { EncryptedBlob, Erased } from '../../../domain/value-objects/encrypted-blob.vo';
import { MaskedIdentifier } from '../../../domain/value-objects/masked-identifier.vo';
import type { CredentialMetadata } from '../../../domain/value-objects/credential-metadata.vo';
import type { GitObtainedVia } from '../../../domain/value-objects/obtained-via.vo';
import { isEncrypted } from '../../../domain/value-objects/encrypted-blob.vo';
import type { CredentialRepository } from '../../../domain/repositories/credential.repository';
import { credentials, type CredentialRow } from '../schema/credential.sqlite';

type Db = BetterSQLite3Database<Record<string, never>>;

/**
 * SQLite (better-sqlite3 + Drizzle) CredentialRepository. Writes run inside the
 * caller's synchronous UnitOfWork. `revokeAndEraseSync` wipes the ciphertext and
 * sets revoked_at in ONE UPDATE so "revoked but ciphertext still present" cannot
 * exist even transiently (I-CRD-3).
 */
@Injectable()
export class SqliteCredentialRepository implements CredentialRepository {
  constructor(@Inject(DATABASE) private readonly db: Db) {}

  async findById(id: CredentialId): Promise<Credential | null> {
    const row = this.db.select().from(credentials).where(eq(credentials.id, id)).get();
    return row ? this.toDomain(row) : null;
  }

  async listGitCredentials(includeRevoked = false): Promise<Credential[]> {
    const where = includeRevoked
      ? eq(credentials.kind, 'git')
      : and(eq(credentials.kind, 'git'), isNull(credentials.revokedAt));
    return this.db
      .select()
      .from(credentials)
      .where(where)
      .all()
      .map((r) => this.toDomain(r));
  }

  saveSync(_tx: Tx, cred: Credential): void {
    const secret = cred.secret;
    const enc = isEncrypted(secret) ? secret : null;
    const values = {
      id: cred.id as string,
      kind: cred.kind,
      runtimeId: cred.runtimeId,
      label: null,
      maskedIdentifier: cred.masked.toString(),
      metadata: this.metadataToJson(cred.metadata),
      ownerRef: cred.ownerRef,
      encryptedBlob: enc?.blob ?? null,
      iv: enc?.iv ?? null,
      authTag: enc?.authTag ?? null,
      encryptionKeyId: enc?.keyId ?? UNKNOWN_KEY_ID,
      obtainedVia: cred.obtainedVia,
      mode: cred.mode,
      allowedHosts: cred.obtainedVia === 'git-https-token' ? cred.allowedHosts : cred.allowedHosts.length > 0 ? cred.allowedHosts : null,
      issuedAt: cred.issuedAt,
      expiresAt: cred.expiresAt,
      refreshFailures: 0,
      lastRefreshedAt: null,
      revokedAt: cred.revokedAt,
      lastUsedAt: cred.lastUsedAt,
    };
    this.db.insert(credentials).values(values).run();
  }

  revokeAndEraseSync(_tx: Tx, id: CredentialId, at: Date): void {
    this.db
      .update(credentials)
      .set({ revokedAt: at, encryptedBlob: null, iv: null, authTag: null })
      .where(eq(credentials.id, id))
      .run();
  }

  touchLastUsedSync(_tx: Tx, id: CredentialId, at: Date): void {
    this.db.update(credentials).set({ lastUsedAt: at }).where(eq(credentials.id, id)).run();
  }

  private metadataToJson(m: CredentialMetadata | null): CredentialRow['metadata'] {
    if (!m) return null;
    return { provider: m.provider, knownHosts: m.knownHosts };
  }

  private toDomain(row: CredentialRow): Credential {
    const secret =
      row.revokedAt !== null
        ? new Erased(row.revokedAt)
        : row.encryptedBlob !== null && row.iv !== null && row.authTag !== null
          ? new EncryptedBlob(row.encryptedBlob, row.iv, row.authTag, row.encryptionKeyId)
          : new Erased(row.issuedAt);
    const metadata: CredentialMetadata | null = row.metadata
      ? { provider: row.metadata.provider, knownHosts: row.metadata.knownHosts }
      : null;
    return Credential.rehydrate({
      id: row.id as CredentialId,
      kind: row.kind === 'git' ? 'git' : 'runtime',
      runtimeId: row.runtimeId,
      obtainedVia: row.obtainedVia as GitObtainedVia,
      masked: MaskedIdentifier.rehydrate(row.maskedIdentifier),
      mode: null,
      allowedHosts: row.allowedHosts ?? [],
      metadata,
      secret,
      ownerRef: row.ownerRef,
      issuedAt: row.issuedAt,
      expiresAt: row.expiresAt,
      lastUsedAt: row.lastUsedAt,
      revokedAt: row.revokedAt,
    });
  }
}

/** Placeholder key id for a revoked (erased) row where no ciphertext remains. */
const UNKNOWN_KEY_ID = 'erased';
