import { sql } from 'drizzle-orm';
import { sqliteTable, text, integer, check, index, uniqueIndex } from 'drizzle-orm/sqlite-core';
import type { KnownHostEntry } from '../../../domain/value-objects/credential-metadata.vo';
import type { GitPlatform } from '../../../domain/value-objects/obtained-via.vo';

/**
 * Drizzle SQLite schema for the credential context (docs/backend/13 §2.5.1).
 *
 * The `credentials` table is SHARED by the runtime and git credential pipelines;
 * this slice writes only `kind='git'` rows, but the table carries the FULL column
 * set + CHECKs so the invariants (I-CRD-1/3/5/8) hold at the DB layer. Two partial
 * unique indexes: one per (runtime_id, mode) active, one per git obtained_via
 * active. Cross-dialect discipline (13 §1): enums = text + CHECK; no `.array()`;
 * timestamps are JS Date (integer timestamp mode); JSON columns are text(json).
 */
interface CredentialMetadataJson {
  provider?: GitPlatform;
  knownHosts?: KnownHostEntry[];
}

export const credentials = sqliteTable(
  'credentials',
  {
    id: text('id').primaryKey(),
    kind: text('kind').notNull(),
    runtimeId: text('runtime_id'),
    label: text('label'),
    maskedIdentifier: text('masked_identifier').notNull(),
    metadata: text('metadata', { mode: 'json' }).$type<CredentialMetadataJson>(),
    ownerRef: text('owner_ref'),
    encryptedBlob: text('encrypted_blob'),
    iv: text('iv'),
    authTag: text('auth_tag'),
    encryptionKeyId: text('encryption_key_id').notNull(),
    obtainedVia: text('obtained_via').notNull(),
    mode: text('mode'),
    allowedHosts: text('allowed_hosts', { mode: 'json' }).$type<string[]>(),
    issuedAt: integer('issued_at', { mode: 'timestamp' }).notNull(),
    expiresAt: integer('expires_at', { mode: 'timestamp' }),
    refreshFailures: integer('refresh_failures').notNull().default(0),
    lastRefreshedAt: integer('last_refreshed_at', { mode: 'timestamp' }),
    revokedAt: integer('revoked_at', { mode: 'timestamp' }),
    lastUsedAt: integer('last_used_at', { mode: 'timestamp' }),
  },
  (t) => ({
    // 13 §2.5.1: kind ∈ {runtime, git}
    kindCk: check('credentials_kind_ck', sql`${t.kind} IN ('runtime','git')`),
    // I-CRD-1: kind ↔ runtime_id / obtained_via cross-constraint
    kindShapeCk: check(
      'credentials_kind_shape_ck',
      sql`(${t.kind} = 'runtime' AND ${t.runtimeId} IS NOT NULL AND ${t.obtainedVia} IN ('setup-token','oauth-device','api-key','access-token-paste')) OR (${t.kind} = 'git' AND ${t.runtimeId} IS NULL AND ${t.obtainedVia} IN ('git-ssh-key','git-https-token'))`,
    ),
    // mode: runtime ⇒ account|api-key; git ⇒ NULL
    modeCk: check(
      'credentials_mode_ck',
      sql`(${t.kind} = 'runtime' AND ${t.mode} IN ('account','api-key')) OR (${t.kind} = 'git' AND ${t.mode} IS NULL)`,
    ),
    // I-CRD-8 (DB expresses only "non-null"): git-https-token ⇒ allowed_hosts NOT NULL
    allowedHostsCk: check(
      'credentials_allowed_hosts_ck',
      sql`(${t.obtainedVia} = 'git-https-token' AND ${t.allowedHosts} IS NOT NULL) OR (${t.obtainedVia} <> 'git-https-token')`,
    ),
    // I-CRD-3: revoked ⇒ ciphertext columns already wiped
    erasedCk: check(
      'credentials_erased_ck',
      sql`${t.revokedAt} IS NULL OR (${t.encryptedBlob} IS NULL AND ${t.iv} IS NULL AND ${t.authTag} IS NULL)`,
    ),
    kindObtainedIdx: index('credentials_kind_obtained_idx').on(t.kind, t.obtainedVia, t.revokedAt),
    runtimeIdx: index('credentials_runtime_idx').on(t.runtimeId, t.revokedAt),
    ownerIdx: index('credentials_owner_idx').on(t.ownerRef),
    expiresIdx: index('credentials_expires_idx').on(t.expiresAt),
    // I-CRD-5: two partial unique indexes (runtime per mode / git per obtained_via)
    runtimeActiveUq: uniqueIndex('uq_cred_runtime_active')
      .on(t.runtimeId, t.mode)
      .where(sql`${t.kind} = 'runtime' AND ${t.revokedAt} IS NULL`),
    gitActiveUq: uniqueIndex('uq_cred_git_active')
      .on(t.obtainedVia)
      .where(sql`${t.kind} = 'git' AND ${t.revokedAt} IS NULL`),
  }),
);

export const credentialSchema = { credentials };
export type CredentialRow = typeof credentials.$inferSelect;
export type CredentialInsert = typeof credentials.$inferInsert;
