import { resolve } from 'node:path';
import { unused } from '../../../../../test-support/unused';
import type { RuntimeCredentialService } from '../../src/application/runtime-credential.service';
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { SqliteUnitOfWork } from '../../../../../apps/api/src/platform/persistence/unit-of-work.impl';
import { SqliteCredentialRepository } from '../../src/infrastructure/persistence/sqlite/credential.repository.impl';
import { AesGcmCrypto } from '../../src/infrastructure/crypto/aes-gcm.crypto';
import { MasterKeyProvider } from '../../src/infrastructure/crypto/master-key.provider';
import { FsGitAuthMaterializer } from '../../src/infrastructure/git/git-auth.materializer';
import { CredentialApplicationService } from '../../src/application/credential-application.service';
import { CredentialFacadeAdapter } from '../../src/application/credential-facade.adapter';
import type { GitRemoteTester } from '../../src/domain/ports/git-remote-tester.port';

/**
 * SECURITY INVARIANT (05 §4.2, 03 §7.3): a corrupted-at-rest ciphertext — here we
 * TAMPER the stored `auth_tag` so AES-GCM authentication fails — must present as a
 * REVOKED / unusable credential (NO_CREDENTIAL on the clone facade, a graceful
 * `ok:false` on the test endpoint), and must NEVER surface as an unhandled 500.
 * This was previously covered by zero automated tests. Uses REAL sqlite + REAL
 * AES-256-GCM + the REAL materializer — nothing about the failure path is faked.
 */
function makeHarness() {
  const sqlite = new Database(':memory:');
  const db = drizzle(sqlite) as BetterSQLite3Database<Record<string, never>>;
  migrate(db, { migrationsFolder: resolve(process.cwd(), 'drizzle') });
  const repo = new SqliteCredentialRepository(db);
  const uow = new SqliteUnitOfWork(sqlite);
  const crypto = new AesGcmCrypto(new MasterKeyProvider());
  const materializer = new FsGitAuthMaterializer(crypto);
  // ls-remote must never be reached — decryption fails first. Make it loud if it is.
  const tester: GitRemoteTester = {
    lsRemote: async () => {
      throw new Error('ls-remote must not run when decryption fails');
    },
  };
  const app = new CredentialApplicationService(
    repo,
    uow,
    { publishInTx: () => undefined, subscribe: () => undefined },
    { now: () => new Date('2026-08-18T00:00:00Z') },
    { next: () => 'cred-1' },
    crypto,
    tester,
    materializer,
  );
  const facade = new CredentialFacadeAdapter(
    repo,
    materializer,
    uow,
    { now: () => new Date('2026-08-18T00:00:00Z') },
    // ⚠️ 后加的第 5 个参数；本组用例只走 git 凭证那半边 ⇒ 被调用就抛。
    unused<RuntimeCredentialService>('RuntimeCredentialService'),
  );
  return { sqlite, repo, app, facade };
}

describe('tampered auth_tag → graceful degradation (05 §4.2)', () => {
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

  async function storeAndTamper(): Promise<string> {
    const { id } = await h.app.storeGitCredential({
      type: 'https-token',
      secret: 'ghp_ABCDEFGHIJKLMNOPQRST',
      platform: 'github',
      allowedHosts: ['github.com'],
    });
    // Corrupt the stored GCM auth tag (16 bytes → 24 base64 chars) so `final()` fails.
    const badTag = randomBytes(16).toString('base64');
    h.sqlite.prepare('UPDATE credentials SET auth_tag = ? WHERE id = ?').run(badTag, id);
    return id;
  }

  it('clone facade: prepareGitAuth degrades to NO_CREDENTIAL (not a raw 500)', async () => {
    await storeAndTamper();
    await expect(
      h.facade.prepareGitAuth('git-https-token', 'github.com', 'https'),
    ).rejects.toMatchObject({ code: 'NO_CREDENTIAL' });
  });

  it('test endpoint: testGitCredential(stored) returns ok:false, never throws', async () => {
    const id = await storeAndTamper();
    const res = await h.app.testGitCredential({
      source: 'stored',
      credentialId: id,
      repoUrl: 'https://github.com/octocat/Hello-World.git',
    });
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe('CLONE_FAILED_PERMISSION');
  });
});
