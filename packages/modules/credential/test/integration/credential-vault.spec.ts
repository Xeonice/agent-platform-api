import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
// The REAL production UnitOfWork adapter — the test never self-mints a Tx (P2-1).
import { SqliteUnitOfWork } from '../../../../../apps/api/src/platform/persistence/unit-of-work.impl';
import { SqliteCredentialRepository } from '../../src/infrastructure/persistence/sqlite/credential.repository.impl';
import { AesGcmCrypto } from '../../src/infrastructure/crypto/aes-gcm.crypto';
import { MasterKeyProvider } from '../../src/infrastructure/crypto/master-key.provider';
import { SecretMaterial } from '../../src/domain/value-objects/secret-material.vo';
import { CredentialApplicationService } from '../../src/application/credential-application.service';
import type { GitAuthMaterializer } from '../../src/domain/ports/git-auth-materializer.port';
import type { GitRemoteTester } from '../../src/domain/ports/git-remote-tester.port';

/**
 * Integration (docs/backend/25): real better-sqlite3 + Drizzle migrations + the real
 * SqliteUnitOfWork + real AES-256-GCM crypto. Proves the Vault encrypt/decrypt
 * round-trip, that store persists ciphertext (not plaintext), that "更换" revokes
 * the old row in the SAME tx (I-CRD-5), and that revoke erases the ciphertext (I-CRD-3).
 */
function makeHarness() {
  const sqlite = new Database(':memory:');
  const db = drizzle(sqlite) as BetterSQLite3Database<Record<string, never>>;
  migrate(db, { migrationsFolder: resolve(process.cwd(), 'drizzle') });
  const repo = new SqliteCredentialRepository(db);
  const uow = new SqliteUnitOfWork(sqlite);
  const crypto = new AesGcmCrypto(new MasterKeyProvider());
  let n = 0;
  const materializer: GitAuthMaterializer = {
    materialize: async () => ({ env: {}, dispose: async () => undefined }),
  };
  const tester: GitRemoteTester = { lsRemote: async () => ({ ok: true }) };
  const app = new CredentialApplicationService(
    repo,
    uow,
    { publishInTx: () => undefined, subscribe: () => undefined },
    { now: () => new Date('2026-08-17T00:00:00Z') },
    { next: () => `cred-${++n}` },
    crypto,
    tester,
    materializer,
  );
  return { sqlite, db, repo, uow, crypto, app };
}

describe('CredentialVault (crypto + store/replace/revoke)', () => {
  let h: ReturnType<typeof makeHarness>;
  const savedKey = process.env.PLATFORM_MASTER_KEY;

  beforeEach(() => {
    process.env.PLATFORM_MASTER_KEY = randomBytes(32).toString('base64');
    h = makeHarness();
  });
  afterEach(() => {
    if (savedKey === undefined) delete process.env.PLATFORM_MASTER_KEY;
    else process.env.PLATFORM_MASTER_KEY = savedKey;
  });

  it('AES-256-GCM encrypt/decrypt round-trips', async () => {
    const blob = await h.crypto.encrypt(SecretMaterial.fromUtf8('the-plaintext-secret'));
    expect(blob.blob).not.toContain('the-plaintext-secret');
    const back = await h.crypto.decrypt(blob);
    expect(back.use((b) => b.toString('utf8'))).toBe('the-plaintext-secret');
  });

  it('stores a git credential as ciphertext, returns masked, never leaks the secret', async () => {
    const SECRET = 'ghp_ABCDEFGHIJKLMNOPQRST';
    const res = await h.app.storeGitCredential({
      type: 'https-token',
      secret: SECRET,
      platform: 'github',
      allowedHosts: ['github.com'],
    });
    expect(res.maskedIdentifier).toBe('…QRST');

    const list = await h.app.listGitCredentials();
    expect(list).toHaveLength(1);
    expect(JSON.stringify(list)).not.toContain(SECRET);
    expect(list[0].allowedHosts).toEqual(['github.com']);

    // ciphertext is stored (not the plaintext) and decrypts back to the secret.
    const row = h.sqlite.prepare('SELECT encrypted_blob, iv, auth_tag FROM credentials').get() as {
      encrypted_blob: string;
      iv: string;
      auth_tag: string;
    };
    expect(row.encrypted_blob).not.toContain(SECRET);
    expect(row.encrypted_blob).toBeTruthy();
  });

  it('"更换" revokes the old same-protocol credential in the same tx (I-CRD-5)', async () => {
    await h.app.storeGitCredential({
      type: 'https-token',
      secret: 'ghp_first000000000000',
      allowedHosts: ['github.com'],
    });
    await h.app.storeGitCredential({
      type: 'https-token',
      secret: 'ghp_second00000000000',
      allowedHosts: ['github.com'],
    });

    const active = await h.app.listGitCredentials();
    expect(active).toHaveLength(1); // uq_cred_git_active holds
    const rows = h.sqlite
      .prepare('SELECT revoked_at, encrypted_blob FROM credentials ORDER BY issued_at')
      .all() as Array<{
      revoked_at: number | null;
      encrypted_blob: string | null;
    }>;
    expect(rows).toHaveLength(2);
    const revoked = rows.filter((r) => r.revoked_at !== null);
    expect(revoked).toHaveLength(1);
    expect(revoked[0].encrypted_blob).toBeNull(); // old ciphertext erased
  });

  it('revoke erases the ciphertext and keeps the audit row (I-CRD-3)', async () => {
    const { id } = await h.app.storeGitCredential({
      type: 'ssh-key',
      secret: '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n-----END RSA PRIVATE KEY-----\n',
      allowedHosts: [],
    });
    await h.app.revokeGitCredential(id);

    expect(await h.app.listGitCredentials()).toHaveLength(0);
    const row = h.sqlite
      .prepare('SELECT encrypted_blob, iv, auth_tag, revoked_at FROM credentials WHERE id = ?')
      .get(id) as {
      encrypted_blob: string | null;
      iv: string | null;
      auth_tag: string | null;
      revoked_at: number | null;
    };
    expect(row.encrypted_blob).toBeNull();
    expect(row.iv).toBeNull();
    expect(row.auth_tag).toBeNull();
    expect(row.revoked_at).not.toBeNull();
  });

  it('rejects a passphrase-protected SSH key (I-CRD-6)', async () => {
    await expect(
      h.app.storeGitCredential({
        type: 'ssh-key',
        secret: '-----BEGIN ENCRYPTED PRIVATE KEY-----\nx\n-----END ENCRYPTED PRIVATE KEY-----\n',
        allowedHosts: [],
      }),
    ).rejects.toThrow();
  });

  it('rejects an https-token without allowedHosts (I-CRD-8)', async () => {
    await expect(
      h.app.storeGitCredential({ type: 'https-token', secret: 'ghp_x', allowedHosts: [] }),
    ).rejects.toThrow();
  });
});
