import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNotNull, isNull, lt } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { DATABASE } from '@platform/shared-kernel';
import type { CredentialId, Tx } from '@platform/shared-kernel';
import { Credential } from '../../../domain/entities/credential.entity';
import { EncryptedBlob, Erased } from '../../../domain/value-objects/encrypted-blob.vo';
import { MaskedIdentifier } from '../../../domain/value-objects/masked-identifier.vo';
import type { CredentialMetadata } from '../../../domain/value-objects/credential-metadata.vo';
import type { ObtainedVia, RuntimeMode } from '../../../domain/value-objects/obtained-via.vo';
import { isEncrypted } from '../../../domain/value-objects/encrypted-blob.vo';
import type { CredentialRepository } from '../../../domain/repositories/credential.repository';
import { credentials, type CredentialRow } from '../schema/credential.sqlite';

type Db = BetterSQLite3Database<Record<string, never>>;

/**
 * SQLite (better-sqlite3 + Drizzle) CredentialRepository. Writes run inside the
 * caller's synchronous UnitOfWork. `revokeAndEraseSync` / `refreshSync` each write
 * in ONE UPDATE so no partial middle state can exist even transiently (I-CRD-3 / P2-2).
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

  async listByRuntime(runtimeId: string, includeRevoked = false): Promise<Credential[]> {
    const base = and(eq(credentials.kind, 'runtime'), eq(credentials.runtimeId, runtimeId));
    const where = includeRevoked ? base : and(base, isNull(credentials.revokedAt));
    return this.db
      .select()
      .from(credentials)
      .where(where)
      .all()
      .map((r) => this.toDomain(r));
  }

  /**
   * CANDIDATES for refresh — runtime credentials expiring before `at` (= now + lead)
   * that have not exhausted the retry budget.
   *
   * ⛔ IT DELIBERATELY DOES **NOT** FILTER BY AUTH METHOD ANY MORE (05 §5.1 ★5.1a ①).
   * This used to end with `c.obtainedVia === 'oauth-device'`, i.e. Codex's login shape
   * hard-coded inside a REPOSITORY — a place no adapter can see and no adapter can
   * override. A third-party runtime that declared `refreshCapability` and obtained its
   * credential via `setup-token` / `access-token-paste` had its declaration silently
   * vetoed here: `listRefreshDue` simply never handed the row to the scanner, with no
   * error and no log.
   *
   * ⚠️ WHERE THE DECISION MOVED TO, AND WHY THERE: the scanner already resolves the
   * runtime's adapter, so it can ask `refreshCapability.eligibleMethods` — the adapter's
   * OWN declaration — and skip anything else gracefully. Claude's `setup-token` (~1yr,
   * no refresh semantics) and every api-key stay out of the refresh flow exactly as
   * before, but now because their adapters SAY SO rather than because a SQL file
   * happened to spell one built-in's method name.
   *
   * ⚠️ WHY THE SCAN VOLUME IS FINE: the SQL predicate does all the real narrowing —
   * `kind='runtime'` AND not revoked AND a non-null `expires_at` inside the 30-minute
   * lead window. Credentials with no platform expiry (api-key with no declared TTL)
   * never appear at all, and what does appear is bounded by "runtime credentials
   * expiring in the next half hour", which on a single-tenant platform is 0–2 rows. The
   * predicate that was dropped removed no rows the SQL had not already removed at any
   * realistic scale, and the JS-side `refreshFailures` cap stays (that is a PLATFORM
   * retry budget, not a vendor fact, so it does belong here).
   */
  async listRefreshDue(at: Date): Promise<Credential[]> {
    return this.db
      .select()
      .from(credentials)
      .where(
        and(
          eq(credentials.kind, 'runtime'),
          isNull(credentials.revokedAt),
          isNotNull(credentials.expiresAt),
          lt(credentials.expiresAt, at),
        ),
      )
      .all()
      .map((r) => this.toDomain(r))
      .filter((c) => c.refreshFailures < 3);
  }

  async listExpiringBefore(at: Date): Promise<Credential[]> {
    return this.db
      .select()
      .from(credentials)
      .where(
        and(
          isNull(credentials.revokedAt),
          isNotNull(credentials.expiresAt),
          lt(credentials.expiresAt, at),
        ),
      )
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
      allowedHosts:
        cred.obtainedVia === 'git-https-token'
          ? cred.allowedHosts
          : cred.allowedHosts.length > 0
            ? cred.allowedHosts
            : null,
      issuedAt: cred.issuedAt,
      expiresAt: cred.expiresAt,
      refreshFailures: cred.refreshFailures,
      lastRefreshedAt: cred.lastRefreshedAt,
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

  refreshSync(
    _tx: Tx,
    id: CredentialId,
    newBlob: EncryptedBlob,
    newExpiresAt: Date,
    now: Date,
  ): void {
    this.db
      .update(credentials)
      .set({
        encryptedBlob: newBlob.blob,
        iv: newBlob.iv,
        authTag: newBlob.authTag,
        encryptionKeyId: newBlob.keyId,
        expiresAt: newExpiresAt,
        lastRefreshedAt: now,
        refreshFailures: 0,
      })
      .where(eq(credentials.id, id))
      .run();
  }

  recordRefreshFailureSync(_tx: Tx, id: CredentialId): void {
    const row = this.db
      .select({ n: credentials.refreshFailures })
      .from(credentials)
      .where(eq(credentials.id, id))
      .get();
    const next = (row?.n ?? 0) + 1;
    this.db.update(credentials).set({ refreshFailures: next }).where(eq(credentials.id, id)).run();
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
      obtainedVia: row.obtainedVia as ObtainedVia,
      masked: MaskedIdentifier.rehydrate(row.maskedIdentifier),
      mode: (row.mode as RuntimeMode | null) ?? null,
      allowedHosts: row.allowedHosts ?? [],
      metadata,
      secret,
      ownerRef: row.ownerRef,
      issuedAt: row.issuedAt,
      expiresAt: row.expiresAt,
      lastUsedAt: row.lastUsedAt,
      revokedAt: row.revokedAt,
      refreshFailures: row.refreshFailures,
      lastRefreshedAt: row.lastRefreshedAt,
    });
  }
}

/** Placeholder key id for a revoked (erased) row where no ciphertext remains. */
const UNKNOWN_KEY_ID = 'erased';
