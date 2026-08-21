import { describe, it, expect, vi } from 'vitest';
import { asCredentialId } from '@platform/shared-kernel';
import { CredentialPreparationError } from '@platform/contracts';
import { CredentialFacadeAdapter } from '../../src/application/credential-facade.adapter';
import { Credential } from '../../src/domain/entities/credential.entity';
import { EncryptedBlob } from '../../src/domain/value-objects/encrypted-blob.vo';
import { MaskedIdentifier } from '../../src/domain/value-objects/masked-identifier.vo';
import { DecryptionError } from '../../src/domain/ports/crypto.port';
import type { CredentialRepository } from '../../src/domain/repositories/credential.repository';
import type { GitAuthMaterializer } from '../../src/domain/ports/git-auth-materializer.port';

const NOW = new Date('2026-08-18T00:00:00Z');

function tokenCred(allowedHosts: string[]): Credential {
  return Credential.createGit({
    id: asCredentialId('cred-1'),
    obtainedVia: 'git-https-token',
    masked: MaskedIdentifier.forToken(Buffer.from('ghp_ABCDEFGHIJKLMNOPQRST')),
    allowedHosts,
    metadata: null,
    secret: new EncryptedBlob('blob', 'iv', 'tag', 'key'),
    now: NOW,
  });
}

function makeAdapter(opts: {
  candidates: Credential[];
  materialize?: GitAuthMaterializer['materialize'];
}) {
  const repo = {
    findById: async () => null,
    listGitCredentials: async () => opts.candidates,
    saveSync: () => undefined,
    revokeAndEraseSync: () => undefined,
    touchLastUsedSync: () => undefined,
  } satisfies CredentialRepository;
  const materialize =
    opts.materialize ?? vi.fn(async () => ({ env: {}, dispose: async () => undefined }));
  const materializer: GitAuthMaterializer = { materialize };
  const adapter = new CredentialFacadeAdapter(
    repo,
    materializer,
    { run: (fn) => fn({} as never) },
    { now: () => NOW },
  );
  return { adapter, materialize };
}

describe('CredentialFacadeAdapter.prepareGitAuth', () => {
  it('NO_CREDENTIAL when no credential of the kind is configured', async () => {
    const { adapter, materialize } = makeAdapter({ candidates: [] });
    await expect(
      adapter.prepareGitAuth('git-https-token', 'github.com', 'https'),
    ).rejects.toMatchObject({ code: 'NO_CREDENTIAL' });
    expect(materialize).not.toHaveBeenCalled();
  });

  it('HOST_NOT_ALLOWED when the target host is outside a token credential whitelist', async () => {
    const { adapter, materialize } = makeAdapter({ candidates: [tokenCred(['github.com'])] });
    const err = await adapter
      .prepareGitAuth('git-https-token', 'evil.example.com', 'https')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CredentialPreparationError);
    expect((err as CredentialPreparationError).code).toBe('HOST_NOT_ALLOWED');
    // never materialize a credential we refused to send.
    expect(materialize).not.toHaveBeenCalled();
  });

  it('DecryptionError degrades to NO_CREDENTIAL (05 §4.2 — presented as revoked, not 500)', async () => {
    const materialize = vi.fn(async () => {
      throw new DecryptionError();
    });
    const { adapter } = makeAdapter({ candidates: [tokenCred(['github.com'])], materialize });
    await expect(
      adapter.prepareGitAuth('git-https-token', 'github.com', 'https'),
    ).rejects.toMatchObject({ code: 'NO_CREDENTIAL' });
    expect(materialize).toHaveBeenCalledOnce();
  });
});

describe('CredentialFacadeAdapter.prepareRuntimeCredential (P1-c symmetric out-discipline)', () => {
  function makeRuntimeAdapter(prepareActive: () => Promise<never>) {
    const repo = { findById: async () => null } as never;
    const runtimeCredentials = { prepareActive: vi.fn(prepareActive) };
    const settingsReader = { activeAuthMethod: async () => 'account' as const };
    const adapter = new CredentialFacadeAdapter(
      repo,
      { materialize: vi.fn() } as never,
      { run: (fn: (tx: never) => unknown) => fn({} as never) } as never,
      { now: () => NOW } as never,
      runtimeCredentials as never,
      settingsReader as never,
    );
    return { adapter, prepareActive: runtimeCredentials.prepareActive };
  }

  it('DecryptionError degrades to NO_CREDENTIAL (05 §4.2 — not 500), mirroring git', async () => {
    const { adapter, prepareActive } = makeRuntimeAdapter(async () => {
      throw new DecryptionError();
    });
    await expect(adapter.prepareRuntimeCredential('codex')).rejects.toMatchObject({
      code: 'NO_CREDENTIAL',
    });
    expect(prepareActive).toHaveBeenCalledOnce();
  });

  it('propagates non-decryption errors unchanged (no swallowing)', async () => {
    const boom = new Error('unexpected');
    const { adapter } = makeRuntimeAdapter(async () => {
      throw boom;
    });
    await expect(adapter.prepareRuntimeCredential('codex')).rejects.toBe(boom);
  });
});
