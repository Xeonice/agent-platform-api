import { describe, it, expect, vi } from 'vitest';
import { CredentialApplicationService } from '../../src/application/credential-application.service';
import { EncryptedBlob } from '../../src/domain/value-objects/encrypted-blob.vo';
import type { CryptoService } from '../../src/domain/ports/crypto.port';
import type { GitRemoteTester } from '../../src/domain/ports/git-remote-tester.port';
import type {
  GitAuthMaterializer,
  MaterializedGitAuth,
} from '../../src/domain/ports/git-auth-materializer.port';
import type { CredentialRepository } from '../../src/domain/repositories/credential.repository';

// An UNENCRYPTED traditional PEM — accepted by the passphrase classifier (I-CRD-6),
// so the inline ssh-key test source is admitted and we reach the SSRF gate.
const UNPROTECTED_KEY =
  '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n-----END RSA PRIVATE KEY-----\n';

function makeService() {
  const materialize = vi.fn(async (): Promise<MaterializedGitAuth> => ({
    env: {},
    dispose: async () => undefined,
  }));
  const lsRemote = vi.fn(async () => ({ ok: true }));
  const crypto: CryptoService = {
    encrypt: async () => new EncryptedBlob('b', 'i', 't', 'k'),
    decrypt: async () => {
      throw new Error('decrypt must not be called on the test path');
    },
  };
  const materializer: GitAuthMaterializer = { materialize };
  const tester: GitRemoteTester = { lsRemote };
  const repo = {
    findById: async () => null,
    listGitCredentials: async () => [],
    saveSync: () => undefined,
    revokeAndEraseSync: () => undefined,
    touchLastUsedSync: () => undefined,
  } satisfies CredentialRepository;
  const svc = new CredentialApplicationService(
    repo,
    { run: (fn) => fn({} as never) },
    { publishInTx: () => undefined, subscribe: () => undefined },
    { now: () => new Date('2026-08-18T00:00:00Z') },
    { next: () => 'cred-1' },
    crypto,
    tester,
    materializer,
  );
  return { svc, materialize, lsRemote };
}

describe('testGitCredential SSRF gate (03 §7.3 C4) — blocks BEFORE ls-remote', () => {
  it('SSH key + empty allowedHosts + ssh:// metadata host → refused, no materialize, no ls-remote', async () => {
    const { svc, materialize, lsRemote } = makeService();
    const res = await svc.testGitCredential({
      source: 'inline',
      type: 'ssh-key',
      secret: UNPROTECTED_KEY,
      allowedHosts: [],
      repoUrl: 'ssh://git@169.254.169.254/x',
    });
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe('CLONE_FAILED_NETWORK');
    // The whole point: the probe is refused WITHOUT ever materializing auth or
    // issuing ls-remote — previously this exact case (SSH key, empty whitelist)
    // skipped all host checks and would have reached the network.
    expect(materialize).not.toHaveBeenCalled();
    expect(lsRemote).not.toHaveBeenCalled();
  });

  it.each([
    'ssh://git@127.0.0.1:2222/x',
    'git@0177.0.0.1:x', // octal loopback
    'git@127.0.0.1.:x', // trailing-dot loopback
  ])('refuses %s without hitting the network', async (repoUrl) => {
    const { svc, materialize, lsRemote } = makeService();
    const res = await svc.testGitCredential({
      source: 'inline',
      type: 'ssh-key',
      secret: UNPROTECTED_KEY,
      allowedHosts: [],
      repoUrl,
    });
    expect(res.ok).toBe(false);
    expect(materialize).not.toHaveBeenCalled();
    expect(lsRemote).not.toHaveBeenCalled();
  });

  it('private LAN ssh host passes the gate → materialize + ls-remote run (gate is precise)', async () => {
    const { svc, materialize, lsRemote } = makeService();
    const res = await svc.testGitCredential({
      source: 'inline',
      type: 'ssh-key',
      secret: UNPROTECTED_KEY,
      allowedHosts: [],
      repoUrl: 'ssh://git@192.168.1.10:2222/x',
    });
    expect(res.ok).toBe(true);
    expect(materialize).toHaveBeenCalledOnce();
    expect(lsRemote).toHaveBeenCalledOnce();
  });
});
