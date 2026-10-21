import { describe, expect, it, vi } from 'vitest';
import type { CryptoService } from '../../../packages/modules/credential/src/domain/ports/crypto.port';
import type { MaterializeRuntimeInput } from '../../../packages/modules/credential/src/domain/ports/runtime-credential-materializer.port';
import { MissingPlatformAuthFileError } from '../../../packages/modules/credential/src/domain/ports/runtime-credential-materializer.port';
import { EncryptedBlob } from '../../../packages/modules/credential/src/domain/value-objects/encrypted-blob.vo';
import { SecretMaterial } from '../../../packages/modules/credential/src/domain/value-objects/secret-material.vo';
import { DefaultRuntimeCredentialMaterializer } from '../../../packages/modules/credential/src/infrastructure/runtime/runtime-credential.materializer';
import { assertDefined } from '../../support/assert-defined';

/** The cipher port is controlled; parsing, assembly and the real Buffer wipe are production code. */
function fixture(plaintext: string) {
  const secret = SecretMaterial.fromUtf8(plaintext);
  const decrypt = vi.fn(() => Promise.resolve(secret));
  const crypto: CryptoService = {
    decrypt,
    encrypt: () => Promise.reject(new Error('Encryption is outside this fixture')),
  };
  const input: MaterializeRuntimeInput = {
    runtimeId: 'codex',
    obtainedVia: 'oauth-device',
    maskedIdentifier: 'fixture@example.test',
    issuedAt: new Date('2026-10-18T00:00:00Z'),
    secret: new EncryptedBlob('owned-ciphertext', 'owned-iv', 'owned-tag', 'owned-key'),
  };
  return { materializer: new DefaultRuntimeCredentialMaterializer(crypto), input, secret, decrypt };
}
function expectWiped(secret: SecretMaterial): void {
  expect(secret.use((bytes) => bytes.length > 0 && bytes.every((byte) => byte === 0))).toBe(true);
}

describe('runtime credential materialization validates payloads and wipes decrypted bytes', () => {
  it.each([
    ['null payload', null],
    ['array payload', []],
    ['non-string token', { accessToken: 42 }],
    ['non-string platform auth file', { authFile: false }],
    ['non-array credential files', { credentialFiles: {} }],
    ['null credential file', { credentialFiles: [null] }],
    ['non-string file path', { credentialFiles: [{ containerPath: 42, content: 'fixture' }] }],
    ['non-string file contents', { credentialFiles: [{ containerPath: '~/.auth', content: [] }] }],
    [
      'non-string mode',
      { credentialFiles: [{ containerPath: '~/.auth', content: '', mode: 600 }] },
    ],
    ['array environment', { env: [] }],
    ['non-string environment value', { env: { TOKEN: 42 } }],
  ])(
    'rejects %s on both paths and zeroizes each decrypted SecretMaterial',
    async (_name, payload) => {
      for (const path of ['materializeForInjection', 'materializeForRefresh'] as const) {
        const f = fixture(JSON.stringify(payload));
        await expect(f.materializer[path](f.input)).rejects.toThrow('Invalid runtime credential');
        expect(f.decrypt).toHaveBeenCalledTimes(1);
        expect(f.decrypt).toHaveBeenCalledWith(f.input.secret);
        expectWiped(f.secret);
      }
    },
  );

  it('zeroizes after a JSON parse failure and after missing refresh material', async () => {
    for (const path of ['materializeForInjection', 'materializeForRefresh'] as const) {
      const f = fixture('{broken-json');
      await expect(f.materializer[path](f.input)).rejects.toThrow(SyntaxError);
      expectWiped(f.secret);
    }
    const f = fixture(JSON.stringify({ accessToken: 'owned-test-access-token' }));
    await expect(f.materializer.materializeForRefresh(f.input)).rejects.toThrow(
      MissingPlatformAuthFileError,
    );
    expectWiped(f.secret);
  });

  it('keeps complete platform auth material out of injection while preserving it for refresh', async () => {
    const payload = {
      credentialFiles: [
        { containerPath: '~/.codex/auth.json', content: 'sanitized-owned-fixture', mode: '0600' },
      ],
      env: { AGENT_TOKEN: 'owned-test-env-token' },
      accessToken: 'owned-test-access-token',
      authFile: '{"refresh_token":"owned-test-refresh-only"}',
    };
    const injection = fixture(JSON.stringify(payload));
    const injectable = await injection.materializer.materializeForInjection(injection.input);
    expectWiped(injection.secret);
    expect(injectable.credentialFiles).toEqual(payload.credentialFiles);
    expect(injectable.env).toEqual(payload.env);
    expect(Object.hasOwn(injectable, 'authFile')).toBe(false);
    expect(JSON.stringify(injectable)).not.toContain('owned-test-refresh-only');
    const injectedFile = assertDefined(injectable.credentialFiles[0]);
    injectable.zeroize();
    expect(injectedFile.content).toBe('');
    expect(injectable.credentialFiles).toEqual([]);
    expect(injectable.env).toBeUndefined();
    expect(injectable.accessToken).toBeUndefined();

    const refresh = fixture(JSON.stringify(payload));
    const refreshable = await refresh.materializer.materializeForRefresh(refresh.input);
    expectWiped(refresh.secret);
    expect(refreshable.authFile).toBe(payload.authFile);
    expect(refreshable.credentialFiles).toEqual(payload.credentialFiles);
    const refreshedFile = assertDefined(refreshable.credentialFiles[0]);
    refreshable.zeroize();
    expect(refreshedFile.content).toBe('');
    expect(refreshable.authFile).toBe('');
    expect(refreshable.credentialFiles).toEqual([]);
    expect(refreshable.env).toBeUndefined();
    expect(refreshable.accessToken).toBeUndefined();
  });
});
