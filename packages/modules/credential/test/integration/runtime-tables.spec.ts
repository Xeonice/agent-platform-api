import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import type { CredentialId, Tx } from '@platform/shared-kernel';
import { SqliteCredentialRepository } from '../../src/infrastructure/persistence/sqlite/credential.repository.impl';
import { Credential } from '../../src/domain/entities/credential.entity';
import { EncryptedBlob } from '../../src/domain/value-objects/encrypted-blob.vo';
import { MaskedIdentifier } from '../../src/domain/value-objects/masked-identifier.vo';

/**
 * S4 new-table migration + FK integration (docs/backend/13 §2.3/§2.5.2, 25). FKs are
 * only enforced with `PRAGMA foreign_keys = ON`.
 */
function freshDb() {
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite);
  migrate(db, { migrationsFolder: resolve(process.cwd(), 'drizzle') });
  return { sqlite, db };
}

const SANDBOX = (id: string) =>
  `INSERT INTO sandboxes (id, project_id, runtime, headless, created_at, updated_at)
   VALUES ('${id}','p1','codex',0,0,0)`;
const RUNTIME_CRED = (id: string, mode: string) =>
  `INSERT INTO credentials (id, kind, runtime_id, masked_identifier, encrypted_blob, iv, auth_tag, encryption_key_id, obtained_via, mode, issued_at)
   VALUES ('${id}','runtime','codex','m','b','iv','tag','k','${mode === 'api-key' ? 'api-key' : 'oauth-device'}','${mode}',0)`;
const BINDING = (id: string, cred: string, sbx: string) =>
  `INSERT INTO credential_sandbox_bindings (id, credential_id, sandbox_id, injected_at)
   VALUES ('${id}','${cred}','${sbx}',0)`;

describe('S4 tables migration (13 §2.3/§2.5.2)', () => {
  it('creates runtime_settings + credential_sandbox_bindings', () => {
    const { sqlite } = freshDb();
    const tables = sqlite
      .prepare(`SELECT name FROM sqlite_master WHERE type='table'`)
      .all()
      .map((r) => (r as { name: string }).name);
    expect(tables).toContain('runtime_settings');
    expect(tables).toContain('credential_sandbox_bindings');
  });

  it('runtime_settings CHECK rejects a bad active_auth_method', () => {
    const { sqlite } = freshDb();
    expect(() =>
      sqlite
        .prepare(
          `INSERT INTO runtime_settings (runtime_id, active_auth_method, updated_at) VALUES ('codex','nope',0)`,
        )
        .run(),
    ).toThrow(/CHECK constraint failed/i);
  });

  it('uq_cred_runtime_active: two active runtime creds of the same mode collide (I-CRD-5)', () => {
    const { sqlite } = freshDb();
    sqlite.prepare(RUNTIME_CRED('a', 'account')).run();
    expect(() => sqlite.prepare(RUNTIME_CRED('b', 'account')).run()).toThrow(
      /UNIQUE constraint failed/i,
    );
    // a different mode is fine
    expect(() => sqlite.prepare(RUNTIME_CRED('c', 'api-key')).run()).not.toThrow();
  });

  it('binding FK: credential_id RESTRICT blocks deleting a bound credential', () => {
    const { sqlite } = freshDb();
    sqlite.prepare(SANDBOX('s1')).run();
    sqlite.prepare(RUNTIME_CRED('cr1', 'account')).run();
    sqlite.prepare(BINDING('bd1', 'cr1', 's1')).run();
    expect(() => sqlite.prepare(`DELETE FROM credentials WHERE id='cr1'`).run()).toThrow(
      /FOREIGN KEY constraint failed/i,
    );
  });

  it('binding FK: sandbox_id CASCADE removes bindings when the sandbox is deleted', () => {
    const { sqlite } = freshDb();
    sqlite.prepare(SANDBOX('s2')).run();
    sqlite.prepare(RUNTIME_CRED('cr2', 'account')).run();
    sqlite.prepare(BINDING('bd2', 'cr2', 's2')).run();
    sqlite.prepare(`DELETE FROM sandboxes WHERE id='s2'`).run();
    const rows = sqlite.prepare(`SELECT * FROM credential_sandbox_bindings WHERE id='bd2'`).all();
    expect(rows).toHaveLength(0);
  });

  it('binding unique(sandbox_id, credential_id) (I-CSB-1)', () => {
    const { sqlite } = freshDb();
    sqlite.prepare(SANDBOX('s3')).run();
    sqlite.prepare(RUNTIME_CRED('cr3', 'account')).run();
    sqlite.prepare(BINDING('bd3', 'cr3', 's3')).run();
    expect(() => sqlite.prepare(BINDING('bd3b', 'cr3', 's3')).run()).toThrow(
      /UNIQUE constraint failed/i,
    );
  });
});

describe('refreshSync atomicity (P2-2)', () => {
  it('overwrites ciphertext + expires_at + last_refreshed_at and zeroes refresh_failures in ONE UPDATE', async () => {
    const { db } = freshDb();
    const repo = new SqliteCredentialRepository(db);
    const tx = {} as Tx;
    const cred = Credential.createRuntime({
      id: 'rc' as CredentialId,
      runtimeId: 'codex',
      obtainedVia: 'oauth-device',
      masked: MaskedIdentifier.rehydrate('m'),
      secret: new EncryptedBlob('old', 'oiv', 'otag', 'k1'),
      now: new Date(0),
      expiresAt: new Date(1000), // 1s (timestamps are second-granular)
    });
    repo.saveSync(tx, cred);
    repo.recordRefreshFailureSync(tx, cred.id);
    repo.recordRefreshFailureSync(tx, cred.id);

    repo.refreshSync(
      tx,
      cred.id,
      new EncryptedBlob('new', 'niv', 'ntag', 'k2'),
      new Date(9000),
      new Date(5000),
    );

    const reread = await repo.findById(cred.id);
    expect(reread).not.toBeNull();
    expect(reread!.assertUsable().blob).toBe('new');
    expect(reread!.assertUsable().keyId).toBe('k2');
    expect(reread!.expiresAt!.getTime()).toBe(9000);
    expect(reread!.lastRefreshedAt!.getTime()).toBe(5000);
    expect(reread!.refreshFailures).toBe(0);
  });
});
