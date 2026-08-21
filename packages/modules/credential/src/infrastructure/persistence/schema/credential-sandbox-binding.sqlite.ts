import { sqliteTable, text, integer, uniqueIndex, index } from 'drizzle-orm/sqlite-core';
import { credentials } from './credential.sqlite';

/**
 * `credential_sandbox_bindings` — the runtime-credential INJECTION LEDGER
 * (docs/backend/13 §2.5.2, 23 §8.4). It exists ONLY to drive revoke → live-sandbox
 * coordination (force-restart/destroy bound sandboxes; env injected into a process
 * cannot be `unset` externally). An independent aggregate (not a Credential inner
 * entity) so accounting never loads the ciphertext (D-7).
 *
 * FKs (13 §2.5.2): credential_id → credentials RESTRICT (force explicit revoke, not
 * accidental delete); sandbox_id → sandboxes CASCADE (accounting is meaningless once
 * the sandbox is gone). The `credentials` FK is declared here; the cross-context
 * `sandboxes` CASCADE FK is added in the migration SQL (avoids a credential→sandbox
 * PACKAGE dependency for a DB-level constraint).
 *
 * BOUNDARY (I3): only `kind='runtime'` injections are ledgered; git credentials
 * are never injected (05 §3.2) → zero rows, and a git revoke hitting zero bindings
 * is normal (no error log).
 */
export const credentialSandboxBindings = sqliteTable(
  'credential_sandbox_bindings',
  {
    id: text('id').primaryKey(),
    credentialId: text('credential_id')
      .notNull()
      .references(() => credentials.id, { onDelete: 'restrict' }),
    sandboxId: text('sandbox_id').notNull(),
    injectedAt: integer('injected_at', { mode: 'timestamp' }).notNull(),
    revokedAt: integer('revoked_at', { mode: 'timestamp' }),
  },
  (t) => ({
    // 23 I-CSB-1
    sandboxCredentialUq: uniqueIndex('uq_csb_sandbox_credential').on(t.sandboxId, t.credentialId),
    credentialIdx: index('idx_csb_credential').on(t.credentialId),
    sandboxIdx: index('idx_csb_sandbox').on(t.sandboxId),
  }),
);

export const credentialSandboxBindingSchema = { credentialSandboxBindings };
export type CredentialSandboxBindingRow = typeof credentialSandboxBindings.$inferSelect;
