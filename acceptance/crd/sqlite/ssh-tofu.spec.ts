import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { asCredentialId } from '@platform/shared-kernel';
import { SqliteUnitOfWork } from '../../../apps/api/src/platform/persistence/unit-of-work.impl';
import { SqliteCredentialRepository } from '../../../packages/modules/credential/src/infrastructure/persistence/sqlite/credential.repository.impl';
import { AesGcmCrypto } from '../../../packages/modules/credential/src/infrastructure/crypto/aes-gcm.crypto';
import { MasterKeyProvider } from '../../../packages/modules/credential/src/infrastructure/crypto/master-key.provider';
import { FsGitAuthMaterializer } from '../../../packages/modules/credential/src/infrastructure/git/git-auth.materializer';
import {
  platformKnownHostsPath,
  pinnedKnownHostsPath,
} from '../../../packages/modules/credential/src/infrastructure/git/known-hosts';
import { CredentialFacadeAdapter } from '../../../packages/modules/credential/src/application/credential-facade.adapter';
import { Credential } from '../../../packages/modules/credential/src/domain/entities/credential.entity';
import { MaskedIdentifier } from '../../../packages/modules/credential/src/domain/value-objects/masked-identifier.vo';
import { SecretMaterial } from '../../../packages/modules/credential/src/domain/value-objects/secret-material.vo';
import { CredentialMapper } from '../../../packages/modules/credential/src/application/dto/credential.mapper';
import { unused } from '../../support/strict-ports';
import type { RuntimeCredentialService } from '../../../packages/modules/credential/src/application/runtime-credential.service';

let root: string;
let sqlite: Database.Database;
let priorRoot: string | undefined;
let priorKey: string | undefined;
beforeEach(async () => {
  priorRoot = process.env.DATA_ROOT;
  priorKey = process.env.PLATFORM_MASTER_KEY;
  root = await mkdtemp(join(tmpdir(), 'ssh-metadata-'));
  process.env.DATA_ROOT = root;
  process.env.PLATFORM_MASTER_KEY = randomBytes(32).toString('base64');
  sqlite = new Database(':memory:');
  migrate(drizzle(sqlite), { migrationsFolder: resolve(process.cwd(), 'drizzle') });
});
afterEach(async () => {
  sqlite.close();
  if (priorRoot === undefined) delete process.env.DATA_ROOT;
  else process.env.DATA_ROOT = priorRoot;
  if (priorKey === undefined) delete process.env.PLATFORM_MASTER_KEY;
  else process.env.PLATFORM_MASTER_KEY = priorKey;
  await rm(root, { recursive: true, force: true });
});

async function setup() {
  const repo = new SqliteCredentialRepository(drizzle(sqlite));
  const uow = new SqliteUnitOfWork(sqlite);
  const crypto = new AesGcmCrypto(new MasterKeyProvider());
  const secret = SecretMaterial.fromUtf8('synthetic fixture SSH private key');
  const blob = await crypto.encrypt(secret);
  secret.zeroize();
  let now = new Date('2026-10-05T00:00:00Z');
  const id = asCredentialId('ssh-credential');
  const credential = Credential.createGit({
    id,
    obtainedVia: 'git-ssh-key',
    masked: MaskedIdentifier.forToken(Buffer.from('synthetic-fixture-mask')),
    allowedHosts: [],
    metadata: { provider: 'gitea' },
    secret: blob,
    now,
  });
  uow.run((tx) => repo.saveSync(tx, credential));
  const facade = new CredentialFacadeAdapter(
    repo,
    new FsGitAuthMaterializer(crypto),
    uow,
    { now: () => now },
    unused<RuntimeCredentialService>('runtime credential'),
  );
  const key = (await readFile(pinnedKnownHostsPath(), 'utf8'))
    .split('\n')[0]!
    .split(' ')
    .slice(1)
    .join(' ');
  return {
    repo,
    uow,
    id,
    facade,
    key,
    advance: () => {
      now = new Date(now.getTime() + 86_400_000);
    },
  };
}

describe('successful SSH clone records public host fingerprints in the credential vault', () => {
  it('records only after success and preserves firstSeenAt on later clones without rewriting ciphertext', async () => {
    const h = await setup();
    const handle = await h.facade.prepareGitAuth('git-ssh-key', 'git.acme.example.com', 'ssh');
    const before = await h.repo.findById(h.id);
    await writeFile(
      platformKnownHostsPath(),
      `git.acme.example.com ${h.key}\nother.example.com ${h.key}\n`,
    );
    expect(before?.metadata?.knownHosts).toBeUndefined();
    expect(handle.recordSuccessfulClone).toBeTypeOf('function');
    await handle.recordSuccessfulClone?.();
    h.advance();
    await handle.recordSuccessfulClone?.();
    const saved = await h.repo.findById(h.id);
    expect(CredentialMapper.toMaskedGit(saved!)).toMatchObject({
      platform: 'gitea',
      knownHosts: [
        {
          host: 'git.acme.example.com',
          keyType: 'ssh-ed25519',
          fingerprint: 'SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU',
          firstSeenAt: '2026-10-05T00:00:00.000Z',
        },
      ],
    });
    expect(saved?.secret).toEqual(before?.secret);
    await handle.dispose();
  });

  it('does not restore a credential revoked while its successful clone was in flight', async () => {
    const h = await setup();
    const handle = await h.facade.prepareGitAuth('git-ssh-key', 'git.acme.example.com', 'ssh');
    await writeFile(platformKnownHostsPath(), `git.acme.example.com ${h.key}\n`);
    h.uow.run((tx) => h.repo.revokeAndEraseSync(tx, h.id, new Date('2026-10-05T01:00:00Z')));
    await handle.recordSuccessfulClone?.();
    const saved = await h.repo.findById(h.id);
    expect(saved?.isRevoked()).toBe(true);
    expect(saved?.metadata?.knownHosts).toBeUndefined();
    const row = sqlite.prepare('SELECT encrypted_blob FROM credentials WHERE id = ?').get(h.id) as {
      encrypted_blob: string | null;
    };
    expect(row.encrypted_blob).toBeNull();
    await handle.dispose();
  });
});
